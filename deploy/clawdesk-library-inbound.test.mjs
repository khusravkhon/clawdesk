import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentsMentioning, documentType, listInboundDocuments } from "./clawdesk-library-inbound.mjs";

const U1 = "11111111-2222-4333-8444-555555555555";
const U2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const U3 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

async function state(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-library-inbound-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inbound = path.join(dir, "media", "inbound");
  await fs.mkdir(inbound, { recursive: true });
  const put = async (name, at, body = "x") => {
    await fs.writeFile(path.join(inbound, name), body);
    await fs.utimes(path.join(inbound, name), at / 1000, at / 1000);
  };
  const agentFile = async (agent, rel, body) => {
    await fs.mkdir(path.dirname(path.join(dir, "agents", agent, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, "agents", agent, rel), body);
  };
  return { dir, put, agentFile };
}

test("only documents are offered, never voice or photos", () => {
  assert.equal(documentType(`Рецепты---${U1}.pdf`), "application/pdf");
  assert.equal(documentType(`${U1}.DOCX`), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  for (const name of [`${U1}.ogg`, `${U1}.jpg`, `${U1}.doc`, `${U1}`]) assert.equal(documentType(name), null, name);
});

test("lists documents oldest first with the agents whose data names them", async (t) => {
  const s = await state(t);
  await s.put(`Рецепты---${U1}.pdf`, 2_000_000);
  await s.put(`${U2}.docx`, 1_000_000);
  await s.put(`${U3}.ogg`, 3_000_000);
  await s.put(`пусто---${U3}.txt`, 4_000_000, "");
  await s.agentFile("dietitian", "agent/openclaw-agent.sqlite", `…media://inbound/Рецепты---${U1}.pdf…`);
  await s.agentFile("trainer", "sessions/a.jsonl", `{"text":"${U2}"}`);
  await s.agentFile("main", "agent/openclaw-agent.sqlite-wal", `${U2}`);
  const { files, more } = await listInboundDocuments(s.dir);
  assert.equal(more, false);
  assert.deepEqual(files.map(({ id, name, agentIds, modifiedAt }) => ({ id, name, agentIds, modifiedAt })), [
    { id: `${U2}.docx`, name: "документ.docx", agentIds: ["main", "trainer"], modifiedAt: 1_000_000 },
    { id: `Рецепты---${U1}.pdf`, name: "Рецепты.pdf", agentIds: ["dietitian"], modifiedAt: 2_000_000 },
  ]);
  assert.deepEqual((await listInboundDocuments(s.dir, { after: 1_500_000 })).files.map((f) => f.id), [`Рецепты---${U1}.pdf`]);
  assert.deepEqual((await listInboundDocuments(s.dir, { limit: 1 })).more, true);
});

test("a file nobody mentions yet has no agent, and a missing inbox is empty", async (t) => {
  const s = await state(t);
  await s.put(`${U1}.pdf`, 1_000_000);
  assert.deepEqual((await listInboundDocuments(s.dir)).files[0].agentIds, []);
  assert.deepEqual((await agentsMentioning(s.dir, [])).size, 0);
  assert.deepEqual(await listInboundDocuments(path.join(s.dir, "absent")), { files: [], more: false });
});
