// What the video worker side decides on its own: which requests it accepts, which subtitle file it
// takes, and what a failure is called. The worker container itself is not started here: these are
// the decisions made before and after it runs.
import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, parseInfo, pickSubtitle, studyVideo, subtitleLanguage, VideoError } from "./clawdesk-video.mjs";

const JOB = "11111111-1111-4111-8111-111111111111";
const URL_OK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

test("takes only a canonical single-video link and a real job id", async () => {
  const refused = [
    { jobId: JOB, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1" },
    { jobId: JOB, url: "http://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { jobId: JOB, url: "https://evil.example/watch?v=dQw4w9WgXcQ" },
    { jobId: JOB, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ; rm -rf /" },
    { jobId: "not-a-job", url: URL_OK },
    {},
  ];
  for (const body of refused) {
    await assert.rejects(() => studyVideo(body), (error) => error instanceof VideoError && error.code === "invalid_url", JSON.stringify(body));
  }
});

test("prefers a requested subtitle language over an automatic one, and reads its tag", () => {
  assert.equal(pickSubtitle(["video.en.vtt", "video.ru.vtt"]), "video.ru.vtt");
  assert.equal(pickSubtitle(["video.auto.en.vtt", "video.en.vtt"]), "video.en.vtt");
  assert.equal(pickSubtitle(["video.mp4", "thumb.jpg"]), null);
  assert.equal(subtitleLanguage("video.ru-orig.vtt"), "ru-orig");
  assert.equal(subtitleLanguage("video.srt"), null);
});

test("names a failure by its reason, and never passes the tool's own text on", () => {
  assert.equal(errorCode("ERROR: Sign in to confirm your age"), "site_refused");
  assert.equal(errorCode("ERROR: Private video. Sign in if you've been granted access"), "site_refused");
  assert.equal(errorCode("ERROR: Video unavailable"), "not_found");
  assert.equal(errorCode("ERROR: [download] socket timed out"), "timeout");
  assert.equal(errorCode("ERROR: something new in a later release"), "download_failed");
});

test("reads only title and duration out of the tool's JSON, and survives junk", () => {
  assert.deepEqual(parseInfo('{"title":"Разбор","duration":125.4,"formats":[{"url":"x"}]}'), { title: "Разбор", durationSec: 125 });
  assert.deepEqual(parseInfo('[debug] a line first\n{"title":"T","duration":0}'), { title: "T", durationSec: null });
  assert.deepEqual(parseInfo("not json"), { title: null, durationSec: null });
  assert.equal(parseInfo(`{"title":"${"x".repeat(500)}"}`).title.length, 300);
});
