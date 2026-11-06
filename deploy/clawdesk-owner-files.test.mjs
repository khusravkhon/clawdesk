import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyName, fileSegments, inboundName, OwnerFiles, safeName } from "./clawdesk-owner-files.mjs";

async function setup(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-owner-files-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(stateDir, "workspace", "files"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "workspace", "analyst"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { analyst: { workspace: path.join(stateDir, "workspace", "analyst") } } } }));
  return { stateDir, files: new OwnerFiles({ stateDir, configPath, now: () => 1000 }) };
}

test("names: one folder deep at most, no dots or slashes to escape, inbound names restored", () => {
  assert.deepEqual(fileSegments("Входящие/ТЗ доски.pdf"), ["Входящие", "ТЗ доски.pdf"]);
  for (const bad of ["a/b/c", "../x", "Входящие/..", ".env", "x/", "", "a\\b", "Входящие/ТЗ · 2.pdf"]) assert.equal(fileSegments(bad), null, bad);
  assert.equal(copyName("Входящие/ТЗ.pdf"), "Входящие · ТЗ.pdf");
  assert.equal(inboundName("ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf"), "ТЗ_доски.pdf");
  assert.equal(inboundName("0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.jpg"), null);
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("..."), "файл");
});

test("a file sent to the bot lands in «Входящие» under its own name, never over another", async (t) => {
  const { stateDir, files } = await setup(t);
  const id = "ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf";
  await fs.writeFile(path.join(stateDir, "media", "inbound", id), "техническое задание");
  assert.equal((await files.storeInbound(id)).path, "Входящие/ТЗ_доски.pdf");
  assert.equal((await files.storeInbound(id)).path, "Входящие/ТЗ_доски (2).pdf");
  assert.equal((await files.storeInbound(id, "ТЗ проекта")).path, "Входящие/ТЗ проекта.pdf", "the given name keeps the real extension");
  await assert.rejects(files.storeInbound("нет-такого.pdf"), { code: "file_missing" });
  await assert.rejects(files.storeInbound("../openclaw.json"), { code: "invalid_file_request" });
  const uploaded = await files.upload("План.docx", Buffer.from("план").toString("base64"));
  assert.equal(uploaded.path, "Входящие/План.docx");
  const listed = (await files.list()).files.map((file) => file.path).sort();
  assert.deepEqual(listed, ["Входящие/ТЗ проекта.pdf", "Входящие/ТЗ_доски (2).pdf", "Входящие/ТЗ_доски.pdf", "Входящие/План.docx"].sort());
});

test("an agent gets a read-only copy in its inbox; the copy is checked by hash and removed on revocation", async (t) => {
  const { stateDir, files } = await setup(t);
  await files.upload("ТЗ.pdf", Buffer.from("версия 1").toString("base64"));
  const copy = await files.copy("analyst", "Входящие/ТЗ.pdf");
  assert.equal(copy.path, "/workspace/inbox/Входящие · ТЗ.pdf");
  const onDisk = path.join(stateDir, "workspace", "analyst", "inbox", "Входящие · ТЗ.pdf");
  assert.equal(await fs.readFile(onDisk, "utf8"), "версия 1");
  assert.equal((await fs.stat(onDisk)).mode & 0o777, 0o444);
  assert.deepEqual((await files.copies("analyst")).copies, [{ file: "Входящие/ТЗ.pdf", sha: copy.sha }]);
  await files.remove("analyst", "Входящие/ТЗ.pdf");
  assert.deepEqual((await files.copies("analyst")).copies, []);
  await assert.rejects(files.copy("analyst", "Входящие/нет.pdf"), { code: "file_missing" });
});

test("a link in the shared folder is never followed into a copy", async (t) => {
  const { stateDir, files } = await setup(t);
  await fs.symlink(path.join(stateDir, "openclaw.json"), path.join(stateDir, "workspace", "files", "config.json"));
  await assert.rejects(files.copy("analyst", "config.json"), (error) => ["file_missing", "invalid_file_request"].includes(error.code) || error.code === "ELOOP");
  await assert.rejects(fs.access(path.join(stateDir, "workspace", "analyst", "inbox", "config.json")));
});

test("files over 20 MB are refused", async (t) => {
  const { stateDir, files } = await setup(t);
  await fs.writeFile(path.join(stateDir, "workspace", "files", "big.bin"), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(files.copy("analyst", "big.bin"), { code: "file_too_large" });
});
