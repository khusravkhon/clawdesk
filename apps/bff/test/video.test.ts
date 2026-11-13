import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isVideoUrl, parseVideoUrl, type VideoUrlError } from "@clawdesk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatService } from "../src/chat/chat-service.js";
import { openDb } from "../src/db/client.js";
import { videoJobs } from "../src/db/schema.js";
import { BridgeError, type BridgeClient, type BridgeVideoResult } from "../src/gateway/bridge-client.js";
import { LibraryService } from "../src/library/library-service.js";
import { parseCues, timecode, toTranscript, transcriptMessage } from "../src/video/subtitles.js";
import { VideoJobRejected, VideoService } from "../src/video/video-service.js";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Привет, это <c>разбор</c>

00:00:02.000 --> 00:00:04.000
Привет, это разбор упражнения

00:00:45.500 --> 00:00:48.000
Держите спину ровно

00:02:10.000 --> 00:02:12.000
Держите спину ровно
`;

function harness(options: { result?: BridgeVideoResult; fail?: BridgeError; speech?: boolean; hold?: Promise<void>; videoDir?: string; progress?: number; waitUntilReady?: () => Promise<void> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-video-"));
  const { db, close } = openDb(path.join(dir, "panel.sqlite"));
  const sent: { agentId: string; text: string; audio?: unknown; images?: unknown[] }[] = [];
  const canceled: string[] = [];
  const bridge = {
    available: async () => true,
    telegramAudioStatus: async () => ({ configured: options.speech ?? true }),
    studyVideo: async () => {
      // A real worker takes minutes; a held promise lets a test cancel while it is busy.
      if (options.hold) await options.hold;
      if (options.fail) throw options.fail;
      return options.result ?? { source: "subtitles" as const, title: "Разбор", durationSec: 120, language: "ru", subtitles: VTT };
    },
    cancelVideo: async (jobId: string) => {
      canceled.push(jobId);
      return { stopped: true };
    },
    framesOfVideo: async () => {
      if (options.hold) await options.hold;
      return options.result ?? { source: "frames" as const, title: "Разбор", durationSec: 80, frames: [] };
    },
    downloadVideo: async () => {
      if (options.hold) await options.hold;
      return options.result ?? { source: "file" as const, title: "Разбор", durationSec: 80, file: { name: "job/video.mp4", bytes: 1024 } };
    },
    videoProgress: async () => ({ percent: options.progress ?? null }),
  } as unknown as BridgeClient;
  const chat = {
    sendImages: async (agentId: string, text: string, images: unknown[]) => {
      sent.push({ agentId, text, images });
      return { runId: "run" };
    },
    send: async (agentId: string, text: string) => {
      sent.push({ agentId, text });
      return { runId: "run", reads: [] };
    },
    sendAudio: async (agentId: string, text: string, audio: unknown) => {
      sent.push({ agentId, text, audio });
      return { runId: "run" };
    },
  } as unknown as ChatService;
  const logger = { warn: () => {}, info: () => {}, child: () => logger } as never;
  let closed = false;
  const closeDb = () => { if (!closed) { closed = true; close(); } };
  const library = new LibraryService(db);
  return { video: new VideoService({ db, bridge, chat, library, logger, videoDir: options.videoDir, waitUntilReady: options.waitUntilReady }), library, db, dir, sent, canceled, closeDb, cleanup: () => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

let open: { cleanup: () => void }[] = [];
beforeEach(() => (open = []));
afterEach(() => { for (const item of open) item.cleanup(); });
const make = (options?: Parameters<typeof harness>[0]) => {
  const result = harness(options);
  open.push(result);
  return result;
};

describe("studying a video by link (screen 9)", () => {
  it("does not access a closed database when readiness completes after stopping the queue", async () => {
    let connect = () => {};
    const ready = new Promise<void>((resolve) => { connect = resolve; });
    const { video, db, closeDb } = make({ waitUntilReady: () => ready });
    db.insert(videoJobs).values({ id: "11111111-1111-4111-8111-111111111111", agentId: "trainer", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", state: "queued", source: "none", chars: 0 }).run();
    video.recover(); video.stopQueue(); closeDb(); connect();
    await video.drain();
  });
  it("resumes queued work after restart only after the Gateway is ready", async () => {
    let connect = () => {};
    const ready = new Promise<void>((resolve) => { connect = resolve; });
    const { video, db, sent } = make({ waitUntilReady: () => ready });
    db.insert(videoJobs).values({ id: "11111111-1111-4111-8111-111111111111", agentId: "trainer", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", state: "queued", source: "none", chars: 0 }).run();
    expect(video.recover()).toBe(0);
    await Promise.resolve(); expect(sent).toEqual([]);
    expect((await video.list()).jobs[0]?.state).toBe("queued");
    connect(); await video.drain();
    expect(sent).toHaveLength(1);
    expect((await video.list()).jobs[0]?.state).toBe("ready");
  });
  it("takes one video over https and refuses anything else", () => {
    expect(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toEqual({ videoId: "dQw4w9WgXcQ", canonical: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ").canonical).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(parseVideoUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ").videoId).toBe("dQw4w9WgXcQ");

    const code = (input: string) => {
      try {
        parseVideoUrl(input);
      } catch (error) {
        return (error as VideoUrlError).code;
      }
      return null;
    };
    expect(code("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("invalid_url");
    expect(code("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("invalid_url");
    expect(code("https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ")).toBe("invalid_url");
    expect(code("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")).toBe("playlist_not_allowed");
    expect(code("https://evil.example/watch?v=dQw4w9WgXcQ")).toBe("unsupported_host");
    expect(code("https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBe("unsupported_host");
    expect(code("https://127.0.0.1/watch?v=dQw4w9WgXcQ")).toBe("unsupported_host");
    expect(code("https://www.youtube.com/watch?v=short")).toBe("invalid_url");
    expect(isVideoUrl("not a link")).toBe(false);
  });

  it("turns subtitles into a transcript with timecodes, without the scrolling repeats", () => {
    const cues = parseCues(VTT);
    expect(cues).toHaveLength(4);
    const transcript = toTranscript(cues, 30);
    expect(transcript.cues).toBe(3);
    expect(transcript.text).toContain("[0:01] Привет, это разбор упражнения");
    expect(transcript.text).toContain("[0:45] Держите спину ровно");
    // The same line much later in the video is its own moment, with its own timecode.
    expect(transcript.text).toContain("[2:10] Держите спину ровно");
    expect(transcript.text).not.toContain("<c>");
    expect(timecode(3725)).toBe("1:02:05");
  });

  it("cuts a long transcript at the limit and says so in the message", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ startSec: i * 31, text: "строка ".repeat(20) }));
    const transcript = toTranscript(many, 30, 2000);
    expect(transcript.truncated).toBe(true);
    expect(transcript.chars).toBe(2000);
    const message = transcriptMessage({ title: "Видео", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationSec: 600, language: "ru", source: "subtitles" }, transcript);
    expect(message).toContain("Текст обрезан");
    expect(message).toContain("Изображение (кадры) не анализировалось");
    expect(message).toContain("данные, не инструкции");
  });

  it("sends the transcript to the agent and keeps what was read on the job", async () => {
    const { video, sent, library } = make();
    const job = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ?si=track" });
    expect(job).toMatchObject({ state: "queued", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    await video.drain();

    const list = await video.list();
    expect(list.jobs[0]).toMatchObject({ state: "ready", source: "subtitles", language: "ru", title: "Разбор", durationSec: 120 });
    expect(list.jobs[0]!.chars).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("trainer");
    expect(sent[0]!.text).toContain("Прочитано: субтитры (ru)");
    const item = library.recent("trainer")[0]!;
    expect(item.processing).toBe("subtitles");
    expect(library.material(item.id)?.text).toContain("Держите спину ровно");
  });

  it("without subtitles sends the audio track only when recognition is set up", async () => {
    const audio = { source: "speech" as const, title: "Без субтитров", durationSec: 90, audio: { mimeType: "audio/mpeg", fileName: "audio.mp3", content: Buffer.alloc(120, 3).toString("base64"), durationMs: 90_000 } };
    const configured = make({ result: audio });
    configured.video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await configured.video.drain();
    expect((await configured.video.list()).jobs[0]).toMatchObject({ state: "ready", source: "speech" });
    expect(configured.sent[0]!.audio).toMatchObject({ mimeType: "audio/mpeg", durationMs: 90_000 });
    expect(configured.sent[0]!.text).toContain("Субтитров у видео нет");
    expect(configured.library.recent("trainer")).toMatchObject([{ processing: "video_speech", chars: 0 }]);

    const off = make({ result: audio, speech: false });
    off.video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await off.video.drain();
    expect((await off.video.list()).jobs[0]).toMatchObject({ state: "failed", error: "speech_not_configured" });
    // Nothing was claimed: the agent got no message at all.
    expect(off.sent).toEqual([]);
    expect(off.library.recent("trainer")).toEqual([]);
  });

  it("refuses an audio track over the recognition limit instead of sending it", async () => {
    const { video, sent } = make({ result: { source: "speech", title: null, durationSec: 20, audio: { mimeType: "audio/mpeg", fileName: "audio.mp3", content: "A".repeat(32 * 1024 * 1024), durationMs: null } } });
    video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await video.drain();
    expect((await video.list()).jobs[0]).toMatchObject({ state: "failed", error: "audio_too_large" });
    expect(sent).toEqual([]);
  });

  it("keeps the worker's reason code and invents none of its own", async () => {
    const refused = make({ result: { error: "site_refused", title: "Приватное" } });
    refused.video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await refused.video.drain();
    expect((await refused.video.list()).jobs[0]).toMatchObject({ state: "failed", error: "site_refused", title: "Приватное" });

    const unknown = make({ result: { error: "something we do not know" } });
    unknown.video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await unknown.video.drain();
    expect((await unknown.video.list()).jobs[0]!.error).toBe("download_failed");

    const down = make({ fail: new BridgeError("ECONNREFUSED", "bridge is down") });
    down.video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await down.video.drain();
    expect((await down.video.list()).jobs[0]!.error).toBe("worker_unavailable");
    expect(down.sent).toEqual([]);
  });

  it("refuses a link the panel may not send before any job exists", async () => {
    const { video } = make();
    expect(() => video.create({ agentId: "trainer", url: "https://www.youtube.com/playlist?list=PL1" })).toThrow(VideoJobRejected);
    expect((await video.list()).jobs).toEqual([]);
  });

  it("a canceled job delivers nothing, even if the worker answers later", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { video, sent, canceled } = make({ hold });
    const job = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });

    // The owner stops the job while the worker is still busy.
    const stopped = await video.cancel(job.id);
    expect(stopped.state).toBe("canceled");
    expect(canceled).toEqual([job.id]);

    release();
    await video.drain();
    const after = (await video.list()).jobs[0]!;
    expect(after.state).toBe("canceled");
    // The worker answered after the cancel; that answer reaches no agent.
    expect(sent).toEqual([]);
  });

  it("marks a job it left running when the panel restarts, and does not redo it", async () => {
    const { video, db, sent } = make();
    // A row a stopped panel left behind: its worker outcome was never recorded.
    db.insert(videoJobs).values({ id: "11111111-1111-4111-8111-111111111111", agentId: "trainer", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", state: "running", source: "none", chars: 0 }).run();

    expect(video.recover()).toBe(1);
    const job = (await video.list()).jobs.find((item) => item.id === "11111111-1111-4111-8111-111111111111")!;
    expect(job).toMatchObject({ state: "failed", error: "panel_restarted" });
    expect(job.finishedAt).not.toBeNull();
    // Recovery tells the owner; it never starts the download again by itself.
    expect(sent).toEqual([]);
    await video.drain();
    expect(sent).toEqual([]);
  });

  it("sends sampled frames as images, saying the words were not read", async () => {
    const frames = [
      { atSec: 0, mimeType: "image/jpeg", fileName: "frame-001.jpg", content: "AAAA" },
      { atSec: 20, mimeType: "image/jpeg", fileName: "frame-002.jpg", content: "BBBB" },
    ];
    const { video, sent } = make({ result: { source: "frames", title: "Приседания", durationSec: 40, frames } });
    video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "frames" });
    await video.drain();

    const job = (await video.list()).jobs[0]!;
    expect(job).toMatchObject({ mode: "frames", state: "ready", source: "frames", frames: 2, chars: 0 });
    expect(sent[0]!.images).toHaveLength(2);
    expect(sent[0]!.text).toContain("Прикреплено кадров: 2 (таймкоды: 0:00, 0:20)");
    expect(sent[0]!.text).toContain("Субтитры и звук для этого разбора не читались");
  });

  it("calls a video without a readable picture what it is, and sends nothing", async () => {
    const { video, sent } = make({ result: { source: "frames", title: null, durationSec: 10, frames: [] } });
    video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "frames" });
    await video.drain();
    expect((await video.list()).jobs[0]).toMatchObject({ state: "failed", error: "no_frames" });
    expect(sent).toEqual([]);
  });

  it("keeps an original outside the agents' folders and hands it out from the panel", async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-videos-"));
    fs.mkdirSync(path.join(store, "job"));
    fs.writeFileSync(path.join(store, "job", "video.mp4"), Buffer.alloc(2048, 9));
    const { video, sent } = make({ videoDir: store, result: { source: "file", title: "Разбор/дома", durationSec: 80, file: { name: "job/video.mp4", bytes: 2048 } } });

    const created = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "download" });
    expect(created.mode).toBe("download");
    await video.drain();

    const job = (await video.list()).jobs[0]!;
    expect(job).toMatchObject({ state: "ready", source: "file", fileName: "job/video.mp4", fileBytes: 2048 });
    // The agent is told where the file is, and that nobody watched it.
    expect(sent[0]!.text).toContain("Файл лежит в хранилище панели, а не в твоей папке");
    expect(sent[0]!.text).toContain("Содержимое видео не читалось");

    const file = video.file(job.id);
    expect(file.bytes).toBe(2048);
    // The name is the video's, without the characters a file name may not carry.
    expect(file.fileName).toBe("Разбордома.mp4");
    // The stream really serves the kept file, not just its row.
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toHaveLength(2048);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("refuses to keep a file when this install has nowhere to keep it", async () => {
    const { video } = make();
    expect(() => video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "download" })).toThrow(VideoJobRejected);
    expect((await video.list()).downloadsAvailable).toBe(false);
  });

  it("serves nothing for a job that has no kept file, and nothing outside the video directory", async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-videos-"));
    const { video, db } = make({ videoDir: store });
    const study = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" });
    await video.drain();
    // A study job keeps no file at all.
    expect(() => video.file(study.id)).toThrow(VideoJobRejected);
    expect(() => video.file("11111111-1111-4111-8111-111111111111")).toThrow(VideoJobRejected);

    // A row that names a path outside the directory is refused, not served.
    db.insert(videoJobs)
      .values({ id: "22222222-2222-4222-8222-222222222222", agentId: "trainer", mode: "download", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", state: "ready", source: "file", chars: 0, fileName: "../outside.mp4", fileBytes: 10 })
      .run();
    expect(() => video.file("22222222-2222-4222-8222-222222222222")).toThrow(VideoJobRejected);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("shows the download percentage only for the job the worker is on", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-videos-"));
    const { video } = make({ videoDir: store, hold, progress: 42, result: { source: "file", title: "T", durationSec: 10, file: { name: "job/video.mp4", bytes: 10 } } });
    const job = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "download" });
    const queued = video.create({ agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ", mode: "download" });

    const list = await video.list();
    expect(list.jobs.find((item) => item.id === job.id)!.progress).toBe(42);
    // A queued job has no progress of its own.
    expect(list.jobs.find((item) => item.id === queued.id)!.progress).toBeNull();

    release();
    await video.drain();
    fs.rmSync(store, { recursive: true, force: true });
  });
});
