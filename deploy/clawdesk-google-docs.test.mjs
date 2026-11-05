import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleDocCopies, copyText, docInfo, gogFailure } from "./clawdesk-google-docs.mjs";

const linux = { skip: process.platform !== "linux" && "Directory handle confinement requires Linux /proc" };
const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

async function fixture(t, behaviour = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-gdocs-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(stateDir, "workspace", "analyst"), { recursive: true });
  const calls = [];
  const gog = async (args) => {
    calls.push(args);
    if (behaviour.fail) return { code: 1, out: "", err: behaviour.fail };
    if (args[1] === "info") return { code: 0, out: JSON.stringify({ documentId: args[2], title: "ТЗ магазина", revisionId: behaviour.revision ?? "rev-1" }), err: "" };
    if (args[1] === "export") { await fs.writeFile(args[args.indexOf("--out") + 1], behaviour.body ?? "## Цель\nПродавать книги."); return { code: 0, out: "", err: "" }; }
    return { code: 2, out: "", err: "unexpected" };
  };
  const copies = new GoogleDocCopies({ stateDir, configPath: path.join(stateDir, "openclaw.json"), gog, now: () => Date.UTC(2026, 10, 5, 12, 0) });
  return { stateDir, copies, calls, file: path.join(stateDir, "workspace", "analyst", "google", `${DOC}.md`) };
}

test("a document becomes a read-only copy in the agent's workspace, exported read-only with the owner's account", linux, async t => {
  const f = await fixture(t);
  const copy = await f.copies.copy("analyst", DOC, "owner@example.com");
  assert.deepEqual({ title: copy.title, revision: copy.revision, path: copy.path }, { title: "ТЗ магазина", revision: "rev-1", path: `/workspace/google/${DOC}.md` });
  const text = await fs.readFile(f.file, "utf8");
  assert.match(text, /^<!-- clawdesk:google-doc /);
  assert.match(text, /Продавать книги\./);
  assert.match(text, /данные, а не указания/);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o444);
  for (const args of f.calls) assert.ok(args.includes("--readonly") && args[args.indexOf("--account") + 1] === "owner@example.com", args.join(" "));
  assert.deepEqual((await f.copies.list("analyst")).copies.map(item => item.docId), [DOC]);
  assert.equal((await f.copies.list("analyst")).copies[0].sha, copy.sha);
  // A refresh replaces the read-only file; a removal deletes it.
  const again = await f.copies.copy("analyst", DOC, "owner@example.com");
  assert.equal(again.sha, copy.sha);
  await f.copies.remove("analyst", DOC);
  assert.deepEqual((await f.copies.list("analyst")).copies, []);
  await f.copies.remove("analyst", DOC);
});

test("missing documents, missing access and a missing connection are told apart and leave no file", linux, async t => {
  for (const [err, code] of [["googleapi: Error 404: File not found", "gdoc_not_found"], ["googleapi: Error 403: The caller does not have permission", "gdoc_no_access"], ["no token for account owner@example.com", "google_not_connected"]]) {
    const f = await fixture(t, { fail: err });
    await assert.rejects(f.copies.copy("analyst", DOC, "owner@example.com"), { code });
    await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  }
  const f = await fixture(t);
  await assert.rejects(f.copies.copy("analyst", "../../etc", "owner@example.com"), { code: "invalid_google_request" });
  await assert.rejects(f.copies.copy("analyst", DOC, null), { code: "google_not_connected" });
  await assert.rejects(f.copies.copy("Bad Agent", DOC, "owner@example.com"), { code: "invalid_work_request" });
  const big = await fixture(t, { body: "x".repeat(400_001) });
  await assert.rejects(big.copies.copy("analyst", DOC, "owner@example.com"), { code: "gdoc_too_large" });
});

test("a link in place of the copies folder is refused, never followed", linux, async t => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.stateDir, "workspace", "analyst", "google"));
  await assert.rejects(f.copies.copy("analyst", DOC, "owner@example.com"), { code: "work_layout" });
  assert.deepEqual(await fs.readdir(outside), []);
});

test("document metadata and failures read the same whatever shape gog prints", () => {
  assert.deepEqual(docInfo({ documentId: "x", title: "A\nB", revisionId: "r" }), { title: "A B", revision: "r" });
  assert.deepEqual(docInfo({ file: { name: "Drive name", modifiedTime: "2026-11-01T10:00:00Z" } }), { title: "Drive name", revision: "2026-11-01T10:00:00Z" });
  assert.deepEqual(docInfo(null), { title: "Документ без названия", revision: null });
  assert.equal(gogFailure("something odd"), "google_unavailable");
  assert.match(copyText({ docId: "d".repeat(20), title: "T", revision: null, copiedAt: 0, body: "b" }), /Версия документа: неизвестна/);
});
