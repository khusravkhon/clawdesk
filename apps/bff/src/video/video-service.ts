import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseVideoUrl, VIDEO_LIMITS, VideoUrlError, type CreateVideoJobRequest, type VideoJobDto, type VideoJobError, type VideoJobMode, type VideoJobsDto } from "@clawdesk/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { ChatService } from "../chat/chat-service.js";
import type { Db } from "../db/client.js";
import { videoJobs } from "../db/schema.js";
import { BridgeError, type BridgeClient, type BridgeVideoResult } from "../gateway/bridge-client.js";
export type { VideoJobMode };
import { framesMessage, parseCues, timecode, toTranscript, transcriptMessage } from "./subtitles.js";
import type { NewLibraryItem } from "../library/library-service.js";

// One video at a time. The work itself happens in the worker the bridge starts; this keeps the
// durable part: whose job it is, what state it is in, and what the agent was actually told.
// Nothing here claims more than the worker reported: subtitles, speech, or neither.

export class VideoJobRejected extends Error {
  constructor(readonly code: VideoJobError) {
    super(code);
    this.name = "VideoJobRejected";
  }
}

type Deps = {
  db: Db;
  bridge: BridgeClient;
  chat: ChatService;
  logger: Logger;
  /** Keeps a transcript, so the owner can search what a video said. */
  library?: { add(item: NewLibraryItem): string | null };
  /** Where kept originals live, read-only for the panel; absent when this install keeps none. */
  videoDir?: string | undefined;
  waitUntilReady?: () => Promise<void>;
};
type Row = typeof videoJobs.$inferSelect;

const toDto = (row: Row, progress: number | null = null): VideoJobDto => ({
  id: row.id,
  agentId: row.agentId,
  mode: row.mode,
  url: row.url,
  title: row.title,
  state: row.state,
  source: row.source,
  language: row.language,
  durationSec: row.durationSec,
  chars: row.chars,
  error: (row.error as VideoJobError | null) ?? null,
  frames: row.frames,
  fileName: row.fileName,
  fileBytes: row.fileBytes,
  progress: row.state === "running" ? progress : null,
  createdAt: row.createdAt.getTime(),
  finishedAt: row.finishedAt?.getTime() ?? null,
});

export class VideoService {
  #running: Promise<void> | null = null;
  #stopped = false;
  /** The job the worker is on right now, so a cancel knows what to stop. */
  #current: string | null = null;

  constructor(private readonly deps: Deps) {}

  /**
   * A job the panel left running cannot be finished: the worker outcome was never recorded.
   * It is marked as such instead of being retried, so nothing is downloaded twice unasked.
   */
  recover(): number {
    const stale = this.deps.db.update(videoJobs).set({ state: "failed", error: "panel_restarted", finishedAt: new Date() }).where(eq(videoJobs.state, "running")).run();
    if (stale.changes) this.deps.logger.warn({ jobs: stale.changes }, "video jobs were running when the panel stopped");
    if (this.deps.db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.state, "queued")).get()) this.#pump();
    return stale.changes;
  }

  async list(): Promise<VideoJobsDto> {
    // Only the job actually in the worker has progress to ask about.
    const progress = this.#current ? await this.deps.bridge.videoProgress(this.#current).then((result) => result.percent).catch(() => null) : null;
    const jobs = this.deps.db
      .select()
      .from(videoJobs)
      .orderBy(desc(videoJobs.createdAt))
      .limit(50)
      .all()
      .map((row) => toDto(row, row.id === this.#current ? progress : null));
    return { jobs, speechConfigured: await this.#speechConfigured(), workerAvailable: await this.deps.bridge.available(), downloadsAvailable: !!this.deps.videoDir };
  }

  /** Queues one video for one agent. The link is canonicalized here; the worker gets nothing else. */
  create(request: Omit<CreateVideoJobRequest, "mode"> & { mode?: VideoJobMode }): VideoJobDto {
    const mode = request.mode ?? "study";
    let link;
    try {
      link = parseVideoUrl(request.url);
    } catch (error) {
      throw new VideoJobRejected(error instanceof VideoUrlError ? error.code : "invalid_url");
    }
    // Keeping a file needs somewhere to keep it; the panel says so instead of starting a download.
    if (mode === "download" && !this.deps.videoDir) throw new VideoJobRejected("downloads_unavailable");
    const row = { id: randomUUID(), agentId: request.agentId, mode, url: link.canonical, videoId: link.videoId, state: "queued" as const, source: "none" as const, chars: 0 };
    this.deps.db.insert(videoJobs).values(row).run();
    const created = this.deps.db.select().from(videoJobs).where(eq(videoJobs.id, row.id)).get()!;
    this.#pump();
    return toDto(created);
  }

  /** Stops a job: a queued one never starts, a running one is stopped in the worker. */
  async cancel(id: string): Promise<VideoJobDto> {
    const row = this.deps.db.select().from(videoJobs).where(eq(videoJobs.id, id)).get();
    if (!row) throw new VideoJobRejected("not_found");
    if (row.state !== "queued" && row.state !== "running") return toDto(row);
    if (row.state === "running") {
      // Best effort: the row is marked canceled either way, so a worker left behind cannot
      // silently deliver its result later.
      await this.deps.bridge.cancelVideo(id).catch((error: Error) => this.deps.logger.warn({ err: error, jobId: id }, "could not stop the video worker"));
    }
    this.deps.db.update(videoJobs).set({ state: "canceled", finishedAt: new Date() }).where(eq(videoJobs.id, id)).run();
    return toDto(this.deps.db.select().from(videoJobs).where(eq(videoJobs.id, id)).get()!);
  }

  /** Waits for the queue to be empty; tests use it, the panel does not. */
  async drain(): Promise<void> {
    while (this.#running) await this.#running;
  }

  #pump(): void {
    if (this.#running || this.#stopped) return;
    this.#running = this.#work().finally(() => {
      this.#running = null;
      if (this.#stopped) return;
      const next = this.deps.db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.state, "queued")).get();
      if (next) this.#pump();
    });
  }

  async #work(): Promise<void> {
    try { if (this.deps.waitUntilReady) await this.deps.waitUntilReady(); }
    catch { return; }
    if (this.#stopped) return;
    const job = this.deps.db.select().from(videoJobs).where(eq(videoJobs.state, "queued")).orderBy(videoJobs.createdAt).get();
    if (!job) return;
    this.deps.db.update(videoJobs).set({ state: "running" }).where(eq(videoJobs.id, job.id)).run();
    this.#current = job.id;
    try {
      const result = await this.#ask(job);
      await this.#finish(job, result);
    } catch (error) {
      const code: VideoJobError = error instanceof BridgeError && CODES.has(error.code as VideoJobError) ? (error.code as VideoJobError) : "worker_unavailable";
      this.deps.logger.warn({ jobId: job.id, code }, "studying a video failed");
      this.#fail(job.id, code);
    } finally {
      this.#current = null;
    }
  }

  /** One call per mode; each mode asks the worker for exactly what the owner wanted. */
  #ask(job: Row): Promise<BridgeVideoResult> {
    const common = { jobId: job.id, url: job.url, maxDurationSec: VIDEO_LIMITS.maxDurationSec };
    if (job.mode === "frames") {
      return this.deps.bridge.framesOfVideo({ ...common, maxFrames: VIDEO_LIMITS.maxFrames, maxFrameBytes: VIDEO_LIMITS.maxFrameBytes, maxSeconds: VIDEO_LIMITS.maxJobSeconds });
    }
    if (job.mode === "download") {
      return this.deps.bridge.downloadVideo({ ...common, maxFileBytes: VIDEO_LIMITS.maxFileBytes, maxSeconds: VIDEO_LIMITS.maxDownloadSeconds });
    }
    return this.deps.bridge.studyVideo({ ...common, maxAudioBytes: VIDEO_LIMITS.maxAudioBytes, maxSeconds: VIDEO_LIMITS.maxJobSeconds });
  }

  /** Writes the outcome and tells the agent — unless the owner canceled the job meanwhile. */
  async #finish(job: Row, result: BridgeVideoResult): Promise<void> {
    if (this.#stopped) return;
    const state = this.deps.db.select({ state: videoJobs.state }).from(videoJobs).where(eq(videoJobs.id, job.id)).get();
    if (state?.state !== "running") return; // canceled while the worker was busy
    if (result.error) {
      this.#fail(job.id, knownError(result.error), { title: result.title ?? null, durationSec: result.durationSec ?? null });
      return;
    }
    const about = { title: result.title ?? null, durationSec: result.durationSec ?? null };
    if (result.source === "frames") {
      const frames = result.frames ?? [];
      if (!frames.length) {
        this.#fail(job.id, "no_frames", about);
        return;
      }
      await this.deps.chat.sendImages(
        job.agentId,
        framesMessage({ ...about, url: job.url }, frames.map((frame) => timecode(frame.atSec))),
        frames.map((frame) => ({ mimeType: frame.mimeType, fileName: frame.fileName, content: frame.content })),
      );
      this.#keepVideo(job, about.title, "video_frames");
      this.#done(job.id, { source: "frames", chars: 0, language: null, frames: frames.length, ...about });
      return;
    }
    if (result.source === "file") {
      if (!result.file) {
        this.#fail(job.id, "download_failed", about);
        return;
      }
      // The agent is told the file is kept in the panel, not placed in its folder: a 2 GiB file
      // in an exchanged folder would hold up every other file there.
      await this.deps.chat.send(job.agentId, fileMessage({ ...about, url: job.url }, result.file.bytes));
      this.#keepVideo(job, about.title, "video_file");
      this.#done(job.id, { source: "file", chars: 0, language: null, fileName: result.file.name, fileBytes: result.file.bytes, ...about });
      return;
    }
    if (result.source === "subtitles") {
      const transcript = toTranscript(parseCues(result.subtitles ?? ""), 30, VIDEO_LIMITS.maxTranscriptChars);
      if (!transcript.text.trim()) {
        this.#fail(job.id, "download_failed", { title: result.title ?? null, durationSec: result.durationSec ?? null });
        return;
      }
      const message = transcriptMessage({ title: result.title ?? null, url: job.url, durationSec: result.durationSec ?? null, language: result.language ?? null, source: "subtitles" }, transcript);
      await this.deps.chat.send(job.agentId, message);
      this.deps.library?.add({ agentId: job.agentId, kind: "video", title: result.title ?? job.url, source: job.url, locator: "таймкод", text: transcript.text,
        processing: transcript.truncated ? "subtitles_partial" : "subtitles" });
      this.#done(job.id, { source: "subtitles", chars: transcript.chars, title: result.title ?? null, language: result.language ?? null, durationSec: result.durationSec ?? null });
      return;
    }
    // No subtitles: the audio goes to the agent, where the owner's configured recognition reads it.
    if (!result.audio) {
      this.#fail(job.id, "download_failed", { title: result.title ?? null, durationSec: result.durationSec ?? null });
      return;
    }
    if (!(await this.#speechConfigured())) {
      this.#fail(job.id, "speech_not_configured", { title: result.title ?? null, durationSec: result.durationSec ?? null });
      return;
    }
    const bytes = Math.floor((result.audio.content.length / 4) * 3);
    if (bytes > VIDEO_LIMITS.maxAudioBytes) {
      this.#fail(job.id, "audio_too_large", { title: result.title ?? null, durationSec: result.durationSec ?? null });
      return;
    }
    await this.deps.chat.sendAudio(job.agentId, speechMessage({ title: result.title ?? null, url: job.url, durationSec: result.durationSec ?? null }), {
      mimeType: result.audio.mimeType,
      fileName: result.audio.fileName,
      content: result.audio.content,
      durationMs: result.audio.durationMs ?? null,
    });
    this.#keepVideo(job, about.title, "video_speech");
    this.#done(job.id, { source: "speech", chars: 0, title: result.title ?? null, language: null, durationSec: result.durationSec ?? null });
  }

  #keepVideo(job: Row, title: string | null, processing: "video_frames" | "video_file" | "video_speech"): void {
    this.deps.library?.add({ agentId: job.agentId, kind: "video", title: title ?? job.url, source: job.url, text: "", processing });
  }

  #done(id: string, fields: { source: "subtitles" | "speech" | "frames" | "file"; chars: number; title: string | null; language: string | null; durationSec: number | null; frames?: number; fileName?: string; fileBytes?: number }): void {
    if (this.#stopped) return;
    this.deps.db.update(videoJobs).set({ ...fields, state: "ready", error: null, finishedAt: new Date() }).where(eq(videoJobs.id, id)).run();
  }

  #fail(id: string, error: VideoJobError, fields: { title?: string | null; durationSec?: number | null } = {}): void {
    if (this.#stopped) return;
    this.deps.db.update(videoJobs).set({ ...fields, state: "failed", error, finishedAt: new Date() }).where(eq(videoJobs.id, id)).run();
  }

  async #speechConfigured(): Promise<boolean> {
    try {
      return (await this.deps.bridge.telegramAudioStatus()).configured;
    } catch {
      return false;
    }
  }

  /**
   * The kept original of a ready download, as a stream. The name comes from our own row, and the
   * resolved path must stay inside the video directory: nothing else is served from there.
   */
  file(id: string): { stream: fs.ReadStream; fileName: string; bytes: number } {
    const row = this.deps.db.select().from(videoJobs).where(eq(videoJobs.id, id)).get();
    if (row?.state !== "ready" || !row.fileName || !this.deps.videoDir) throw new VideoJobRejected("not_found");
    const dir = path.resolve(this.deps.videoDir);
    const full = path.resolve(dir, row.fileName);
    if (full !== path.normalize(full) || !full.startsWith(dir + path.sep) || !fs.existsSync(full)) throw new VideoJobRejected("not_found");
    const name = `${(row.title ?? "video").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80) || "video"}${path.extname(full)}`;
    return { stream: fs.createReadStream(full), fileName: name, bytes: row.fileBytes ?? fs.statSync(full).size };
  }

  /** Jobs still open, for the panel's "something is running" state. */
  open(): number {
    return this.deps.db.select({ id: videoJobs.id }).from(videoJobs).where(inArray(videoJobs.state, ["queued", "running"])).all().length;
  }

  /** The job the worker is on, or null. */
  get current(): string | null {
    return this.#current;
  }

  stopQueue(): void { this.#stopped = true; }

  /** Jobs of one agent, newest first. */
  forAgent(agentId: string): VideoJobDto[] {
    return this.deps.db
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.agentId, agentId)))
      .orderBy(desc(videoJobs.createdAt))
      .limit(20)
      .all()
      .map(toDto);
  }
}

/** What the agent is told about a kept original: where it is, and that nobody watched it. */
function fileMessage(video: { title: string | null; url: string; durationSec: number | null }, bytes: number): string {
  const size = `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
  return [
    `## Видео сохранено: ${video.title ?? video.url}`,
    "",
    `Ссылка: ${video.url}`,
    `Размер файла: ${size}. Файл лежит в хранилище панели, а не в твоей папке —`,
    "его можно скачать в панели. Содержимое видео не читалось: ни субтитры, ни звук, ни кадры.",
  ].join("\n");
}

/** The message that accompanies the audio: what it is, and what has not happened yet. */
function speechMessage(video: { title: string | null; url: string; durationSec: number | null }): string {
  return [
    `## Видео без субтитров: ${video.title ?? video.url}`,
    "",
    `Ссылка: ${video.url}`,
    "Субтитров у видео нет, поэтому прикреплена звуковая дорожка.",
    "Распознай речь и сделай конспект. Изображение (кадры) не анализировалось.",
    "Если распознать речь не удалось — скажи об этом прямо, не пересказывай по названию.",
  ].join("\n");
}

const CODES = new Set<VideoJobError>(["invalid_url", "unsupported_host", "playlist_not_allowed", "too_long", "speech_not_configured", "site_refused", "not_found", "download_failed", "timeout", "audio_too_large", "file_too_large", "no_frames", "downloads_unavailable", "worker_unavailable", "panel_restarted", "storage_quota_exceeded", "storage_unavailable", "storage_busy"]);
/** A code the worker or the bridge reported, or a neutral one: no invented reason. */
const knownError = (code: string | undefined): VideoJobError => (code && CODES.has(code as VideoJobError) ? (code as VideoJobError) : "download_failed");
