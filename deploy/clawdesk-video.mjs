// One video for the panel, in one of three modes: its subtitles (then its audio), sampled frames,
// or the original file. The three stay separate, so an answer can only claim what was obtained.
//
// Runs in the Gateway container (the bridge), which has the Docker CLI, and starts a pinned worker
// container per job. The work happens there, not here: the worker image carries yt-dlp and ffmpeg,
// gets no mounts but its own output directory, no Docker socket, no cookies and no credentials,
// and is stopped on a timeout or a cancel. Arguments are passed as an argv array — never a shell
// string — and the only owner-supplied value is the canonical video URL the panel validated.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Where kept originals go: a directory outside the agents' folder exchange, or nothing. */
const VIDEO_DIR = process.env.CLAWDESK_VIDEO_DIR || "";
/** Progress of the running downloads, read by the panel while a job is on. */
const PROGRESS = new Map();

const IMAGE = process.env.CLAWDESK_VIDEO_IMAGE || "ghcr.io/khusravkhon/clawdesk-video:dev";
const DOCKER = "/usr/local/libexec/docker";
/** Subtitle languages asked for, in order of preference; auto-generated ones count. */
const SUB_LANGS = "ru,ru-orig,ru.*,en,en-orig,en.*";
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
const CANCELED = new Set();

export class VideoError extends Error {
  constructor(code) {
    super(code);
    this.name = "VideoError";
    this.code = code;
  }
}

const JOB_ID = /^[0-9a-f-]{36}$/;
const URL_ALLOWED = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;

/** The container name of a job, so a cancel can stop exactly that one. */
const containerName = (jobId) => `clawdesk-video-${jobId}`;

function run(argv, { timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(DOCKER, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      // Enough for metadata and a subtitle file; a longer stream is cut off here.
      if (out.length < MAX_SUBTITLE_BYTES * 2) out += chunk;
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < 64 * 1024) err += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out, err, timedOut, spawnFailed: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut, spawnFailed: false });
    });
  });
}

/** Fixed docker arguments: no network namespace sharing, no mounts but the output, no privileges. */
const dockerArgs = (jobId, outDir, args, { memory = "1g", cpus = "1.0", entrypoint = null, network = "bridge" } = {}) => [
  "run",
  "--rm",
  "--name",
  containerName(jobId),
  ...(entrypoint ? ["--entrypoint", entrypoint] : []),
  "--network",
  network,
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,size=64m",
  "--pids-limit",
  "256",
  "--memory",
  memory,
  "--cpus",
  cpus,
  "-v",
  `${outDir}:/out:rw`,
  "-w",
  "/out",
  IMAGE,
  ...args,
];

/** yt-dlp's own error text, mapped to the codes the panel knows. Nothing else is passed on. */
export function errorCode(stderr) {
  const text = String(stderr).toLowerCase();
  if (/sign in|age|private video|members-only|not available in your country|geo/.test(text)) return "site_refused";
  if (/video unavailable|does not exist|removed by the uploader|not a valid url/.test(text)) return "not_found";
  if (/timed out|timeout/.test(text)) return "timeout";
  return "download_failed";
}

/** The subtitle file yt-dlp wrote, preferring a requested language over an automatic one. */
export function pickSubtitle(files) {
  const subtitles = files.filter((name) => /\.(vtt|srt)$/i.test(name));
  if (!subtitles.length) return null;
  const score = (name) => {
    const lower = name.toLowerCase();
    let value = 0;
    if (/\.ru[.-]/.test(lower) || lower.includes(".ru.")) value -= 2;
    if (lower.includes(".en.")) value -= 1;
    if (lower.includes("auto")) value += 1;
    return value;
  };
  return [...subtitles].sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0];
}

/** The language tag out of a subtitle file name, when it has one. */
export const subtitleLanguage = (name) => {
  const match = /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\.(?:vtt|srt)$/.exec(name);
  return match ? match[1] : null;
};

function checkRequest(body) {
  const jobId = String(body?.jobId ?? "");
  const url = String(body?.url ?? "");
  if (!JOB_ID.test(jobId)) throw new VideoError("invalid_url");
  // The panel canonicalizes the link; the worker takes nothing else, whatever the caller sent.
  if (!URL_ALLOWED.test(url)) throw new VideoError("invalid_url");
  const maxSeconds = Math.min(Math.max(Number(body?.maxSeconds) || 600, 60), 3600);
  const maxDurationSec = Math.min(Math.max(Number(body?.maxDurationSec) || 14400, 60), 24 * 3600);
  const maxAudioBytes = Math.min(Math.max(Number(body?.maxAudioBytes) || 20 * 1024 * 1024, 1024), 64 * 1024 * 1024);
  const maxFrames = Math.min(Math.max(Number(body?.maxFrames) || 8, 1), 32);
  const maxFrameBytes = Math.min(Math.max(Number(body?.maxFrameBytes) || 2 * 1024 * 1024, 1024), 8 * 1024 * 1024);
  const maxFileBytes = Math.min(Math.max(Number(body?.maxFileBytes) || 2 * 1024 * 1024 * 1024, 1024), 8 * 1024 * 1024 * 1024);
  return { jobId, url, maxSeconds, maxDurationSec, maxAudioBytes, maxFrames, maxFrameBytes, maxFileBytes };
}

/**
 * One job: metadata, then subtitles, then — only if there are none — the audio track.
 * Returns what was actually obtained; an empty result is an error, never a silent success.
 */
/** yt-dlp progress lines (--newline): the percentage is all the panel shows. */
export function parseProgress(line) {
  const match = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(String(line));
  if (!match) return null;
  return Math.min(100, Math.max(0, Math.round(Number(match[1]))));
}

/** The frame files ffmpeg wrote, in order, so their timecodes stay right. */
export const frameFiles = (files) => files.filter((name) => /^frame-\d{3}\.jpg$/.test(name)).sort();

/** Progress of a running job, for the panel to poll. */
export const videoProgress = (jobId) => (JOB_ID.test(String(jobId)) ? (PROGRESS.get(String(jobId)) ?? null) : null);

/**
 * Frames only: a bounded, low-resolution copy is downloaded, evenly spaced frames are taken from
 * it, and the copy is thrown away. No subtitles and no audio are touched, so a visual answer
 * cannot quietly lean on the words.
 */
export async function framesOfVideo(body) {
  const { jobId, url, maxSeconds, maxDurationSec, maxFrames, maxFrameBytes } = checkRequest(body);
  CANCELED.delete(jobId);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-frames-"));
  const deadline = Date.now() + maxSeconds * 1000;
  const left = () => Math.max(5_000, deadline - Date.now());
  try {
    const meta = await run(dockerArgs(jobId, outDir, ["--skip-download", "--dump-single-json", url]), { timeoutMs: Math.min(left(), 120_000) });
    if (meta.spawnFailed) throw new VideoError("worker_unavailable");
    if (meta.code !== 0) throw new VideoError(meta.timedOut ? "timeout" : errorCode(meta.err));
    const info = parseInfo(meta.out);
    if (info.durationSec !== null && info.durationSec > maxDurationSec) return { error: "too_long", title: info.title, durationSec: info.durationSec };

    const copy = await run(
      dockerArgs(jobId, outDir, ["--newline", "-f", "worst[height>=240][filesize<300M]/worst", "--max-filesize", "300M", "-o", "source.%(ext)s", url]),
      { timeoutMs: left(), onLine: (line) => setProgress(jobId, parseProgress(line)) },
    );
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (copy.timedOut) throw new VideoError("timeout");
    if (copy.code !== 0) throw new VideoError(errorCode(copy.err));
    const source = (await fs.readdir(outDir)).find((name) => name.startsWith("source."));
    if (!source) throw new VideoError("download_failed");

    // Evenly spaced: one frame per duration/maxFrames, so the sample covers the whole video.
    const everySec = Math.max(1, Math.round((info.durationSec ?? maxFrames * 10) / maxFrames));
    const frames = await run(
      dockerArgs(jobId, outDir, ["-hide_banner", "-loglevel", "error", "-i", `/out/${source}`, "-vf", `fps=1/${everySec},scale=640:-2`, "-frames:v", String(maxFrames), "-q:v", "6", "-f", "image2", "/out/frame-%03d.jpg"], { entrypoint: "ffmpeg", memory: "2g" }),
      { timeoutMs: left() },
    );
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (frames.timedOut) throw new VideoError("timeout");
    const files = frameFiles(await fs.readdir(outDir));
    if (!files.length) return { error: "no_frames", title: info.title, durationSec: info.durationSec };
    const images = [];
    for (const [index, name] of files.entries()) {
      const bytes = await fs.readFile(path.join(outDir, name));
      if (bytes.length > maxFrameBytes) continue;
      images.push({ atSec: index * everySec, mimeType: "image/jpeg", fileName: name, content: bytes.toString("base64") });
    }
    if (!images.length) return { error: "no_frames", title: info.title, durationSec: info.durationSec };
    return { source: "frames", title: info.title, durationSec: info.durationSec, frames: images };
  } finally {
    CANCELED.delete(jobId);
    PROGRESS.delete(jobId);
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The original file, kept in the panel's video directory — never in an agent's exchanged folder,
 * where a large file would hold up every other file of that folder.
 */
export async function downloadVideo(body) {
  const { jobId, url, maxSeconds, maxDurationSec, maxFileBytes } = checkRequest(body);
  if (!VIDEO_DIR) throw new VideoError("downloads_unavailable");
  CANCELED.delete(jobId);
  const outDir = path.join(VIDEO_DIR, jobId);
  await fs.mkdir(outDir, { recursive: true });
  const deadline = Date.now() + maxSeconds * 1000;
  const left = () => Math.max(5_000, deadline - Date.now());
  try {
    const meta = await run(dockerArgs(jobId, outDir, ["--skip-download", "--dump-single-json", url]), { timeoutMs: Math.min(left(), 120_000) });
    if (meta.spawnFailed) throw new VideoError("worker_unavailable");
    if (meta.code !== 0) throw new VideoError(meta.timedOut ? "timeout" : errorCode(meta.err));
    const info = parseInfo(meta.out);
    if (info.durationSec !== null && info.durationSec > maxDurationSec) return { error: "too_long", title: info.title, durationSec: info.durationSec };

    setProgress(jobId, 0);
    const got = await run(
      dockerArgs(jobId, outDir, ["--newline", "--no-part", "-f", `best[filesize<?${Math.floor(maxFileBytes / (1024 * 1024))}M]/best`, "--max-filesize", String(maxFileBytes), "--merge-output-format", "mp4", "-o", "video.%(ext)s", url]),
      { timeoutMs: left(), onLine: (line) => setProgress(jobId, parseProgress(line)) },
    );
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (got.timedOut) throw new VideoError("timeout");
    if (got.code !== 0) {
      // A file over the limit is a refusal the owner can act on, not a failure of the download.
      throw new VideoError(/file is larger|max-filesize/i.test(got.err) ? "file_too_large" : errorCode(got.err));
    }
    const file = (await fs.readdir(outDir)).find((name) => name.startsWith("video."));
    if (!file) throw new VideoError("download_failed");
    const stat = await fs.stat(path.join(outDir, file));
    if (stat.size > maxFileBytes) {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      return { error: "file_too_large", title: info.title, durationSec: info.durationSec };
    }
    return { source: "file", title: info.title, durationSec: info.durationSec, file: { name: `${jobId}/${file}`, bytes: stat.size } };
  } catch (error) {
    // Nothing half-downloaded is left behind to fill the disk.
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    CANCELED.delete(jobId);
    PROGRESS.delete(jobId);
  }
}

function setProgress(jobId, percent) {
  if (percent !== null) PROGRESS.set(jobId, percent);
}

export async function studyVideo(body) {
  const { jobId, url, maxSeconds, maxDurationSec, maxAudioBytes } = checkRequest(body);
  CANCELED.delete(jobId);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-video-"));
  const deadline = Date.now() + maxSeconds * 1000;
  const left = () => Math.max(5_000, deadline - Date.now());
  try {
    const meta = await run(dockerArgs(jobId, outDir, ["--no-playlist", "--skip-download", "--dump-single-json", url]), { timeoutMs: Math.min(left(), 120_000) });
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (meta.spawnFailed) throw new VideoError("worker_unavailable");
    if (meta.code !== 0) throw new VideoError(meta.timedOut ? "timeout" : errorCode(meta.err));
    const info = parseInfo(meta.out);
    if (info.durationSec !== null && info.durationSec > maxDurationSec) {
      return { error: "too_long", title: info.title, durationSec: info.durationSec };
    }

    const subs = await run(
      dockerArgs(jobId, outDir, ["--no-playlist", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", SUB_LANGS, "--sub-format", "vtt/srt/best", "-o", "%(id)s.%(ext)s", url]),
      { timeoutMs: left() },
    );
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (subs.timedOut) throw new VideoError("timeout");
    const picked = pickSubtitle(await fs.readdir(outDir));
    if (picked) {
      const stat = await fs.stat(path.join(outDir, picked));
      if (stat.size > MAX_SUBTITLE_BYTES) throw new VideoError("download_failed");
      const subtitles = await fs.readFile(path.join(outDir, picked), "utf8");
      if (subtitles.trim()) {
        return { source: "subtitles", title: info.title, durationSec: info.durationSec, language: subtitleLanguage(picked), subtitles };
      }
    }

    // No subtitles: the audio track, bounded, for the owner's own speech recognition.
    const audio = await run(
      dockerArgs(jobId, outDir, ["--no-playlist", "-f", "bestaudio[filesize<20M]/bestaudio", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5", "--max-filesize", String(maxAudioBytes), "-o", "audio.%(ext)s", url]),
      { timeoutMs: left() },
    );
    if (CANCELED.has(jobId)) throw new VideoError("timeout");
    if (audio.timedOut) throw new VideoError("timeout");
    if (audio.code !== 0) throw new VideoError(errorCode(audio.err));
    const file = (await fs.readdir(outDir)).find((name) => name === "audio.mp3");
    if (!file) throw new VideoError("download_failed");
    const bytes = await fs.readFile(path.join(outDir, file));
    if (bytes.length > maxAudioBytes) return { error: "audio_too_large", title: info.title, durationSec: info.durationSec };
    return {
      source: "speech",
      title: info.title,
      durationSec: info.durationSec,
      audio: { mimeType: "audio/mpeg", fileName: "audio.mp3", content: bytes.toString("base64"), durationMs: info.durationSec === null ? null : info.durationSec * 1000 },
    };
  } finally {
    CANCELED.delete(jobId);
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reads the fields the panel needs out of yt-dlp's JSON; anything else is ignored. */
export function parseInfo(stdout) {
  try {
    const json = JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "{}");
    const duration = Number(json.duration);
    const title = typeof json.title === "string" ? json.title.slice(0, 300) : null;
    return { title, durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null };
  } catch {
    return { title: null, durationSec: null };
  }
}

/** Stops the worker of this job; the panel marks the job canceled either way. */
export async function cancelVideo(body) {
  const jobId = String(body?.jobId ?? "");
  if (!JOB_ID.test(jobId)) throw new VideoError("invalid_url");
  CANCELED.add(jobId);
  const stopped = await run(["rm", "--force", containerName(jobId)], { timeoutMs: 30_000 });
  return { stopped: stopped.code === 0 };
}
