import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchVerified } from "./fetch-verified.mjs";

const FILE = Buffer.from("the real release archive");
const SHA = createHash("sha256").update(FILE).digest("hex");
const answer = (status, body) => async () => new Response(body, { status });

async function target(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-fetch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "out.tgz");
}

test("a 504 error page is retried, never written; the pinned bytes are", async (t) => {
  const out = await target(t);
  const replies = [answer(504, "<html>504 Gateway Time-out</html>"), answer(200, "a different file"), answer(200, FILE)];
  const logs = [];
  const result = await fetchVerified("https://example.test/gog.tgz", SHA, out, { delayMs: 1, fetchImpl: async (...args) => replies.shift()(...args), log: (line) => logs.push(line) });
  assert.deepEqual(result, { attempt: 3, size: FILE.length });
  assert.deepEqual(await fs.readFile(out), FILE);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /HTTP 504/);
});

test("a changed release or a dead link still fails the build, and nothing is written", async (t) => {
  const out = await target(t);
  await assert.rejects(fetchVerified("https://example.test/gog.tgz", SHA, out, { attempts: 3, delayMs: 1, fetchImpl: answer(200, "tampered"), log: () => {} }), /no file with sha256/);
  await assert.rejects(fetchVerified("https://example.test/gog.tgz", SHA, out, { attempts: 2, delayMs: 1, fetchImpl: async () => { throw new Error("TLS handshake timeout"); }, log: () => {} }), /TLS handshake timeout/);
  await assert.rejects(fs.stat(out), { code: "ENOENT" });
  await assert.rejects(fetchVerified("http://example.test/x", SHA, out), /usage/);
  await assert.rejects(fetchVerified("https://example.test/x", "abc", out), /usage/);
});
