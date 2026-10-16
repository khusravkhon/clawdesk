import { z } from "zod";

// Studying a video by link (screen 9): the owner sends a link, a worker reads its subtitles, and
// the agent gets a summary with timestamps. Only what was actually analyzed is ever claimed:
// subtitles, speech, or neither — the frames of the video are not looked at here.

/**
 * What the owner asked for. The three are separate on purpose: a summary from subtitles, a look at
 * the picture, and keeping the file are different questions, and mixing them would let an answer
 * claim it watched a video it only read.
 */
export const VideoJobMode = z.enum([
  /** Subtitles, or the audio track when there are none. */
  "study",
  /** Sampled frames for an agent that can read images. Nothing is listened to or read. */
  "frames",
  /** The original file, kept outside the agents' folder exchange. */
  "download",
]);
export type VideoJobMode = z.infer<typeof VideoJobMode>;

export const VideoJobState = z.enum([
  /** Waiting its turn: one video is studied at a time. */
  "queued",
  "running",
  /** Studied, and its text handed to the agent. */
  "ready",
  "failed",
  "canceled",
]);
export type VideoJobState = z.infer<typeof VideoJobState>;

/** Where the material came from; "none" means nothing was obtained. */
export const VideoJobSource = z.enum(["subtitles", "speech", "frames", "file", "none"]);
export type VideoJobSource = z.infer<typeof VideoJobSource>;

/** Every way studying a video can fail, so the panel can say what to do next. */
export const VideoJobError = z.enum([
  "invalid_url",
  "unsupported_host",
  "playlist_not_allowed",
  "too_long",
  /** No subtitles, and speech recognition is not set up, so nothing could be read. */
  "speech_not_configured",
  /** The site refused: age or region limits, a private video, or it asked to sign in. */
  "site_refused",
  "not_found",
  "download_failed",
  "timeout",
  /** The audio is larger than the recognition provider takes. */
  "audio_too_large",
  /** The file is larger than the panel keeps for one video. */
  "file_too_large",
  /** No frame could be taken: the video has no picture the worker could read. */
  "no_frames",
  /** The panel has nowhere to keep originals (no video directory in this install). */
  "downloads_unavailable",
  /** The worker is missing or the bridge is unreachable. */
  "worker_unavailable",
  /** The panel restarted while this job was running; its outcome is unknown. */
  "panel_restarted",
]);
export type VideoJobError = z.infer<typeof VideoJobError>;

export const VideoJobDto = z.object({
  id: z.string(),
  agentId: z.string(),
  mode: VideoJobMode,
  /** The canonical link the worker was given, never the owner's original query string. */
  url: z.string(),
  title: z.string().nullable(),
  state: VideoJobState,
  source: VideoJobSource,
  /** The subtitle language the worker took, when it said which. */
  language: z.string().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  /** Characters of text handed to the agent. */
  chars: z.number().int().nonnegative(),
  error: VideoJobError.nullable(),
  /** Frames handed to the agent, for a "frames" job. */
  frames: z.number().int().nonnegative().nullable(),
  /** The kept original: its name in the panel's video directory and its size. */
  fileName: z.string().nullable(),
  fileBytes: z.number().int().nonnegative().nullable(),
  /** 0-100 while a download is running; null when the worker reported nothing yet. */
  progress: z.number().int().min(0).max(100).nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type VideoJobDto = z.infer<typeof VideoJobDto>;

export const VideoJobsDto = z.object({
  jobs: z.array(VideoJobDto),
  /** Whether this install has a directory to keep originals in. */
  downloadsAvailable: z.boolean(),
  /** Whether speech recognition is set up; without it a video without subtitles cannot be read. */
  speechConfigured: z.boolean(),
  /** Whether the Gateway bridge that runs the worker is reachable at all. */
  workerAvailable: z.boolean(),
});
export type VideoJobsDto = z.infer<typeof VideoJobsDto>;

export const CreateVideoJobRequest = z.object({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  url: z.string().trim().min(1).max(2000),
  mode: VideoJobMode.default("study"),
});
export type CreateVideoJobRequest = z.infer<typeof CreateVideoJobRequest>;

/** Hard limits of one job, the same numbers in the panel, the BFF and the worker. */
export const VIDEO_LIMITS = {
  /** A longer video is refused before anything is downloaded. */
  maxDurationSec: 4 * 60 * 60,
  /** The recognition providers take 20 MiB (see the Telegram voice setup). */
  maxAudioBytes: 20 * 1024 * 1024,
  /** One job may not hold the queue forever. */
  maxJobSeconds: 20 * 60,
  /** Characters of transcript handed to the agent. */
  maxTranscriptChars: 60_000,
  /** Frames sampled from one video, evenly spaced. */
  maxFrames: 8,
  /** One frame, as a JPEG. */
  maxFrameBytes: 2 * 1024 * 1024,
  /** A kept original. Larger videos are refused rather than filling the disk. */
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  /** A download may take longer than reading subtitles. */
  maxDownloadSeconds: 60 * 60,
} as const;

// Which links the panel will hand to the worker. The rule is narrow on purpose: one video on one
// known site, over HTTPS, with no credentials and no playlist. A validated string is not a
// guarantee on its own — the worker is what actually limits where it may connect — but a link the
// owner mistyped, a playlist, or an address pointing at an internal service stops here.

export class VideoUrlError extends Error {
  constructor(readonly code: VideoJobError) {
    super(code);
    this.name = "VideoUrlError";
  }
}

/** The sites this panel studies today. YouTube first; another site is a deliberate addition. */
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = ["/shorts/", "/live/", "/embed/", "/v/"];

export type VideoLink = { videoId: string; canonical: string };

/**
 * Accepts one video link and returns the canonical form handed on. Query parameters the owner
 * happened to have (tracking, a start time, a playlist) are dropped rather than forwarded.
 */
export function parseVideoUrl(input: string): VideoLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new VideoUrlError("invalid_url");
  }
  if (url.protocol !== "https:") throw new VideoUrlError("invalid_url");
  if (url.username || url.password || url.port) throw new VideoUrlError("invalid_url");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!HOSTS.has(host)) throw new VideoUrlError("unsupported_host");
  // A playlist is many videos: one job is one video, so the link is refused rather than trimmed.
  if (url.searchParams.has("list") || url.pathname === "/playlist") throw new VideoUrlError("playlist_not_allowed");

  const videoId = host.endsWith("youtu.be") ? url.pathname.slice(1) : fromYoutubePath(url);
  if (!VIDEO_ID.test(videoId)) throw new VideoUrlError("invalid_url");
  return { videoId, canonical: `https://www.youtube.com/watch?v=${videoId}` };
}

function fromYoutubePath(url: URL): string {
  if (url.pathname === "/watch") return url.searchParams.get("v") ?? "";
  const prefix = PATH_PREFIXES.find((candidate) => url.pathname.startsWith(candidate));
  return prefix ? url.pathname.slice(prefix.length).split("/")[0]! : "";
}

/** True when the panel can study this link; used to offer the action, never to authorize it. */
export function isVideoUrl(input: string): boolean {
  try {
    parseVideoUrl(input);
    return true;
  } catch {
    return false;
  }
}
