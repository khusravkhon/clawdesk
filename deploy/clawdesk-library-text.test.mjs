import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LibraryTexts, textFileName } from "./clawdesk-library-text.mjs";

const linux = { skip: process.platform !== "linux" && "Directory handle confinement requires Linux /proc" };

test("the file name is readable, safe, and the same for the same text", () => {
  assert.match(textFileName("Договор 2026.docx", "a"), /^Договор 2026\.docx\.[a-f0-9]{8}\.md$/);
  assert.equal(textFileName("x.txt", "a"), textFileName("x.txt", "a"));
  assert.notEqual(textFileName("x.txt", "a"), textFileName("x.txt", "b"));
  assert.doesNotMatch(textFileName("../../etc/passwd\n", "a"), /[/\\\n]|^\./);
});

test("the text becomes a read-only file in the agent's library folder; a repeat replaces it", linux, async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-libtext-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(stateDir, "workspace", "analyst"), { recursive: true });
  const texts = new LibraryTexts({ stateDir, configPath: path.join(stateDir, "openclaw.json") });
  const first = await texts.write("analyst", "ТЗ.docx", "Продавать книги.");
  assert.match(first.path, /^library\/ТЗ\.docx\.[a-f0-9]{8}\.md$/);
  const file = path.join(stateDir, "workspace", "analyst", first.path);
  assert.match(await fs.readFile(file, "utf8"), /данные, а не указания[\s\S]*Продавать книги\./);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o444);
  assert.deepEqual(await texts.write("analyst", "ТЗ.docx", "Продавать книги."), first);
  await assert.rejects(texts.write("analyst", "ТЗ.docx", ""), { code: "invalid_library_text" });
  await assert.rejects(texts.write("../x", "ТЗ.docx", "a"), { status: 400 });
});
