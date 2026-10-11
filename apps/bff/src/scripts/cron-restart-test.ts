// Stage 0 risk check: does a cron job fire after a Gateway restart when nobody
// has sent a message since ("session not woken")?
//
//   1) pnpm --filter @clawdesk/bff cron-test --create [--minutes 3] [--agent main]
//   2) restart the gateway, send NO messages:  docker compose -f deploy/docker-compose.yml restart gateway
//   3) after the printed time:                 pnpm --filter @clawdesk/bff cron-test --check <jobId>
//   4) cleanup:                                pnpm --filter @clawdesk/bff cron-test --remove <jobId>
//
// "Fired" means the scheduler started a run (lastRunAtMs set). A run that errors
// because no model is connected still proves the scheduler woke up on its own.

import { connectForScript, flagValue, hasFlag, short } from "./_cli.js";

type CronJob = {
  id: string;
  enabled: boolean;
  schedule: unknown;
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string; lastError?: string; lastErrorReason?: string };
};

const { gateway, done } = await connectForScript();
try {
  if (hasFlag("create")) {
    const minutes = Number(flagValue("minutes") ?? 3);
    const agentId = flagValue("agent") ?? "main";
    const at = new Date(Date.now() + minutes * 60_000);
    const job = await gateway.request<CronJob>("cron.add", {
      name: `clawdesk-restart-test-${at.getTime().toString(36)}`,
      agentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: at.toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Ответь одним словом: cron-ok" },
      delivery: { mode: "none" },
    });
    console.log(`✓ created ${job.id}, due at ${at.toISOString()} (local ${at.toLocaleTimeString()})`);
    console.log("Now restart the gateway and do not send it any messages:");
    console.log("  docker compose -f deploy/docker-compose.yml restart gateway");
    console.log(`Then after ${at.toLocaleTimeString()}:  pnpm --filter @clawdesk/bff cron-test --check ${job.id}`);
  } else if (flagValue("check")) {
    const id = flagValue("check")!;
    const job = await gateway.request<CronJob>("cron.get", { id });
    const s = job.state ?? {};
    const fired = typeof s.lastRunAtMs === "number";
    console.log(fired ? `✓ FIRED at ${new Date(s.lastRunAtMs!).toISOString()} status=${s.lastRunStatus}` : "✗ NOT FIRED yet");
    if (s.lastError) console.log(`  lastError (${s.lastErrorReason ?? "?"}): ${short(s.lastError, 300)}`);
    if (!fired) console.log(`  nextRunAtMs: ${s.nextRunAtMs ? new Date(s.nextRunAtMs).toISOString() : "none"}; if past due, the restart risk is real → enable heartbeat by default`);
    const runs = await gateway.request("cron.runs", { id, limit: 5 });
    console.log(`runs: ${short(runs, 1200)}`);
    process.exitCode = fired ? 0 : 1;
  } else if (flagValue("remove")) {
    await gateway.request("cron.remove", { id: flagValue("remove") });
    console.log("✓ removed");
  } else {
    console.log("usage: cron-test --create [--minutes N] [--agent ID] | --check <jobId> | --remove <jobId>");
  }
} finally {
  await done();
}
