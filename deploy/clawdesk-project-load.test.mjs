import { test } from "node:test";
import assert from "node:assert/strict";
import { LOAD_BOOTSTRAP, parseLoadOutput } from "./clawdesk-project-load.mjs";

test("only the line with the run's nonce counts", () => {
  assert.deepEqual(parseLoadOutput("noise\nabc{\"requests\":3}\n", "abc"), { requests: 3 });
  assert.equal(parseLoadOutput('xyz{"requests":3}', "abc"), null);
  assert.equal(parseLoadOutput("abc{broken", "abc"), null);
});

test("a real run against the template never hits its limit of 100 tasks", { timeout: 60_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await fs.mkdtemp(`${os.tmpdir()}/clawdesk-load-`);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const appUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [new URL("./project-templates/task-board-v1/server.mjs", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), DATA_FILE: `${dir}/tasks.sqlite` }, stdio: "ignore" });
  t.after(() => server.kill());
  const run = (concurrency) => new Promise((resolve) => {
    const client = spawn(process.execPath, ["--input-type=module", "-e", LOAD_BOOTSTRAP, "nonce-", String(concurrency), "3000"], { env: { ...process.env, CLAWDESK_APP_URL: appUrl } });
    let out = "";
    client.stdout.on("data", (chunk) => { out += chunk; });
    client.on("close", () => resolve(parseLoadOutput(out, "nonce-")));
  });
  const result = await run(10);
  assert.ok(result.requests > 0, JSON.stringify(result));
  assert.equal(result.errors, 0, JSON.stringify(result.statuses));
  assert.equal(result.statuses["409"], undefined);
  assert.ok(result.statuses["201"] > 0 && result.statuses["200"] > 0);
  // A slow test host can make fewer than 100 tasks even if the client stops deleting them.
  const remaining = await fetch(`${appUrl}/api/tasks`, { signal: AbortSignal.timeout(5000) });
  assert.equal(remaining.status, 200);
  assert.deepEqual(await remaining.json(), [], "the load client must delete every task it creates");
});
