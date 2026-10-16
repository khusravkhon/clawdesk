import { randomUUID } from "node:crypto";
import { parseVideoUrl, VIDEO_LIMITS, VideoUrlError, type CreateVideoJobRequest, type VideoJobDto, type VideoJobError, type VideoJobsDto } from "@clawdesk/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { ChatService } from "../chat/chat-service.js";
import type { Db } from "../db/client.js";
import { videoJobs } from "../db/schema.js";
import { BridgeError, type BridgeClient, type BridgeVideoResult } from "../gateway/bridge-client.js";
import { parseCues, toTranscript, transcriptMessage } from "./subtitles.js";

// One video at a time. The work itself happens in the worker the bridge starts; this keeps the
// durable part: whose job it is, what state it is in, and what the agent was actually told.
// Nothing here claims more than the worker reported: subtitles, speech, or neither.

export class VideoJobRejected extends Error {
  constructor(readonly code: VideoJobError) {
    super(code);
    this.name = "VideoJobRejected";
  }
}

type Deps = { db: Db; bridge: BridgeClient; chat: ChatService; logger: Logger };
type Row = typeof videoJobs.$inferSelect;

const toDto = (row: Row): VideoJobDto => ({
  id: row.id,
  agentId: row.agentId,
  url: row.url,
  title: row.title,
  state: row.state,
  source: row.source,
  language: row.language,
  durationSec: row.durationSec,
  chars: row.chars,
  error: (row.error as VideoJobError | null) ?? null,
  createdAt: row.createdAt.getTime(),
  finishedAt: row.finishedAt?.getTime() ?? null,
});

export class VideoService {
  #running: Promise<void> | null = null;
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
    return stale.changes;
  }

  async list(): Promise<VideoJobsDto> {
    const jobs = this.deps.db.select().from(videoJobs).orderBy(desc(videoJobs.createdAt)).limit(50).all().map(toDto);
    return { jobs, speechConfigured: await this.#speechConfigured(), workerAvailable: await this.deps.bridge.available() };
  }

  /** Queues one video for one agent. The link is canonicalized here; the worker gets nothing else. */
  create(request: CreateVideoJobRequest): VideoJobDto {
    let link;
    try {
      link = parseVideoUrl(request.url);
    } catch (error) {
      throw new VideoJobRejected(error instanceof VideoUrlError ? error.code : "invalid_url");
    }
    const row = { id: randomUUID(), agentId: request.agentId, url: link.canonical, videoId: link.videoId, state: "queued" as const, source: "none" as const, chars: 0 };
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
    if (this.#running) return;
    this.#running = this.#work().finally(() => {
      this.#running = null;
      const next = this.deps.db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.state, "queued")).get();
      if (next) this.#pump();
    });
  }

  async #work(): Promise<void> {
    const job = this.deps.db.select().from(videoJobs).where(eq(videoJobs.state, "queued")).orderBy(videoJobs.createdAt).get();
    if (!job) return;
    this.deps.db.update(videoJobs).set({ state: "running" }).where(eq(videoJobs.id, job.id)).run();
    this.#current = job.id;
    try {
      const result = await this.deps.bridge.studyVideo({ jobId: job.id, url: job.url, maxDurationSec: VIDEO_LIMITS.maxDurationSec, maxAudioBytes: VIDEO_LIMITS.maxAudioBytes, maxSeconds: VIDEO_LIMITS.maxJobSeconds });
      await this.#finish(job, result);
    } catch (error) {
      const code: VideoJobError = error instanceof BridgeError && CODES.has(error.code as VideoJobError) ? (error.code as VideoJobError) : "worker_unavailable";
      this.deps.logger.warn({ jobId: job.id, code }, "studying a video failed");
      this.#fail(job.id, code);
    } finally {
      this.#current = null;
    }
  }

  /** Writes the outcome and tells the agent — unless the owner canceled the job meanwhile. */
  async #finish(job: Row, result: BridgeVideoResult): Promise<void> {
    const state = this.deps.db.select({ state: videoJobs.state }).from(videoJobs).where(eq(videoJobs.id, job.id)).get();
    if (state?.state !== "running") return; // canceled while the worker was busy
    if (result.error) {
      this.#fail(job.id, knownError(result.error), { title: result.title ?? null, durationSec: result.durationSec ?? null });
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
    this.#done(job.id, { source: "speech", chars: 0, title: result.title ?? null, language: null, durationSec: result.durationSec ?? null });
  }

  #done(id: string, fields: { source: "subtitles" | "speech"; chars: number; title: string | null; language: string | null; durationSec: number | null }): void {
    this.deps.db.update(videoJobs).set({ ...fields, state: "ready", error: null, finishedAt: new Date() }).where(eq(videoJobs.id, id)).run();
  }

  #fail(id: string, error: VideoJobError, fields: { title?: string | null; durationSec?: number | null } = {}): void {
    this.deps.db.update(videoJobs).set({ ...fields, state: "failed", error, finishedAt: new Date() }).where(eq(videoJobs.id, id)).run();
  }

  async #speechConfigured(): Promise<boolean> {
    try {
      return (await this.deps.bridge.telegramAudioStatus()).configured;
    } catch {
      return false;
    }
  }

  /** Jobs still open, for the panel's "something is running" state. */
  open(): number {
    return this.deps.db.select({ id: videoJobs.id }).from(videoJobs).where(inArray(videoJobs.state, ["queued", "running"])).all().length;
  }

  /** The job the worker is on, or null. */
  get current(): string | null {
    return this.#current;
  }

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

const CODES = new Set<VideoJobError>(["invalid_url", "unsupported_host", "playlist_not_allowed", "too_long", "speech_not_configured", "site_refused", "not_found", "download_failed", "timeout", "audio_too_large", "worker_unavailable", "panel_restarted"]);
/** A code the worker or the bridge reported, or a neutral one: no invented reason. */
const knownError = (code: string | undefined): VideoJobError => (code && CODES.has(code as VideoJobError) ? (code as VideoJobError) : "download_failed");
