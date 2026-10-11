// Stage 0 spike: the "create a junior agent" chain, entirely over RPC.
//
//   agents.create → agents.files.set ×3 → config.patch → cron.add → chat.send
//
// Any failing step rolls back the earlier ones. The agent and its cron job are
// removed at the end unless --keep is passed. --no-chat skips the model call
// (useful before a model is connected).

import crypto from "node:crypto";
import { loadTemplate, renderTemplateFiles, WORKSPACE_FILES } from "@clawdesk/templates";
import type { EventFrame } from "@openclaw/gateway-protocol/frame-guards";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { runSaga, SagaError } from "../provision/saga.js";
import { connectForScript, flagValue, hasFlag, short } from "./_cli.js";

type Ctx = {
  name: string;
  agentId?: string;
  cronJobId?: string;
  sessionKey?: string;
  reply?: string;
};

const keep = hasFlag("keep");
const skipChat = hasFlag("no-chat");
const tz = flagValue("tz") ?? "UTC";

const { gateway, done } = await connectForScript();
const timings: [string, number][] = [];
const timed = <T>(label: string, fn: () => Promise<T>) => async () => {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings.push([label, Math.round(performance.now() - t0)]);
  }
};

const template = loadTemplate("personal", "dietitian");
const files = renderTemplateFiles(template, { goal: "Сбросить 3 кг к лету без жёстких диет", restrictions: "без орехов" });
const ctx: Ctx = { name: `clawdesk-spike-${Date.now().toString(36)}` };

try {
  const before = await gateway.request<{ agents: { id: string }[] }>("agents.list", {});
  console.log(`agents before: ${before.agents.map((a) => a.id).join(", ") || "(none)"}`);

  await runSaga(ctx, [
    {
      name: "agents.create",
      run: timed("agents.create", async () => {
        const res = await gateway.request<{ agentId: string; workspace: string }>("agents.create", { name: ctx.name, emoji: template.emoji });
        ctx.agentId = res.agentId;
        console.log(`✓ agents.create → ${res.agentId} (workspace ${res.workspace})`);
      }),
      undo: async () => {
        await gateway.request("agents.delete", { agentId: ctx.agentId, deleteFiles: true });
        console.log(`↺ agents.delete ${ctx.agentId}`);
      },
    },
    {
      name: "agents.files.set",
      run: timed("agents.files.set ×3", async () => {
        for (const name of WORKSPACE_FILES) {
          await gateway.request("agents.files.set", { agentId: ctx.agentId, name, content: files[name] });
        }
        const back = await gateway.request<{ file: { content?: string; missing: boolean } }>("agents.files.get", { agentId: ctx.agentId, name: "SOUL.md" });
        if (back.file.content !== files["SOUL.md"]) throw new Error(`SOUL.md read-back mismatch: ${short(back.file, 300)}`);
        console.log(`✓ agents.files.set ${WORKSPACE_FILES.join(", ")} (read-back ok)`);
      }),
    },
    {
      name: "config.patch",
      // Removed together with the agent by agents.delete; no separate undo.
      run: timed("config.patch", async () => {
        const id = ctx.agentId!;
        await patchConfig(gateway, { agents: { entries: { [id]: { skills: template.skills } } } }, { note: "clawdesk spike" });
        const { config } = await getConfig<{ agents?: { entries?: Record<string, unknown> } }>(gateway);
        console.log(`✓ config.patch → agents.entries.${id} = ${short(config.agents?.entries?.[id], 400)}`);
      }),
    },
    {
      name: "cron.add",
      run: timed("cron.add", async () => {
        const res = await gateway.request<{ id?: string; job?: { id: string } }>("cron.add", {
          name: `${ctx.name}-menu`,
          agentId: ctx.agentId,
          enabled: false,
          schedule: { kind: "cron", expr: template.cronPresets[0]?.cron ?? "30 7 * * *", tz },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: template.cronPresets[0]?.prompt ?? "Составь меню на сегодня." },
          delivery: { mode: "none" },
        });
        ctx.cronJobId = res.id ?? res.job?.id;
        if (!ctx.cronJobId) throw new Error(`cron.add returned no job id: ${short(res, 300)}`);
        console.log(`✓ cron.add → ${ctx.cronJobId} (disabled)`);
      }),
      undo: async () => {
        await gateway.request("cron.remove", { id: ctx.cronJobId });
        console.log(`↺ cron.remove ${ctx.cronJobId}`);
      },
    },
    {
      name: "chat.send",
      run: timed("chat.send → final", async () => {
        if (skipChat) {
          console.log("· chat.send skipped (--no-chat)");
          return;
        }
        ctx.sessionKey = `agent:${ctx.agentId}:main`;
        ctx.reply = await sendAndWait(gateway, ctx.agentId!, ctx.sessionKey, "Привет! Ответь одной короткой фразой: кто ты?");
        console.log(`✓ chat.send → reply: ${short(ctx.reply, 300)}`);
      }),
    },
  ]);

  console.log("\nSPIKE OK");
} catch (error) {
  console.error(`\nSPIKE FAILED: ${error instanceof SagaError ? error.message : (error as Error).stack}`);
  if (error instanceof SagaError && error.cause instanceof Error) console.error(`cause: ${error.cause.message}`);
  process.exitCode = 1;
} finally {
  if (!keep && ctx.agentId && process.exitCode !== 1) {
    if (ctx.cronJobId) await gateway.request("cron.remove", { id: ctx.cronJobId }).catch((e: Error) => console.error(`cleanup cron.remove: ${e.message}`));
    await gateway.request("agents.delete", { agentId: ctx.agentId, deleteFiles: true }).catch((e: Error) => console.error(`cleanup agents.delete: ${e.message}`));
    console.log(`cleanup: removed ${ctx.agentId}`);
  } else if (keep && ctx.agentId) {
    console.log(`kept agent ${ctx.agentId}${ctx.cronJobId ? ` and cron job ${ctx.cronJobId}` : ""}`);
  }
  console.log(`\ntimings: ${timings.map(([l, ms]) => `${l} ${ms}ms`).join(" · ")}`);
  await done();
}

/** Sends one message and resolves with the final assistant text from the `chat` event stream. */
async function sendAndWait(gateway: GatewayService, agentId: string, sessionKey: string, message: string, timeoutMs = 120_000): Promise<string> {
  let runId: string | undefined;
  let text = "";
  const finished = Promise.withResolvers<string>();
  const off = gateway.onEvent((event: EventFrame) => {
    if (event.event !== "chat") return;
    const p = event.payload as { runId?: string; sessionKey?: string; state?: string; deltaText?: string; replace?: boolean; message?: unknown; errorMessage?: string };
    const mine = runId ? p.runId === runId : p.sessionKey?.toLowerCase() === sessionKey.toLowerCase();
    if (!mine) return;
    if (p.state === "delta" && typeof p.deltaText === "string") text = p.replace ? p.deltaText : text + p.deltaText;
    if (p.state === "final") finished.resolve(text || extractText(p.message) || "(empty)");
    if (p.state === "error" || p.state === "aborted") finished.reject(new Error(`chat ${p.state}: ${p.errorMessage ?? "no details"}`));
  });
  const timer = setTimeout(() => finished.reject(new Error(`no final chat event within ${timeoutMs}ms`)), timeoutMs);
  try {
    await gateway.request("sessions.messages.subscribe", { key: sessionKey }).catch(() => undefined);
    const res = await gateway.request<{ runId?: string }>("chat.send", {
      sessionKey,
      agentId,
      message,
      idempotencyKey: crypto.randomUUID(),
    });
    runId = res.runId;
    return await finished.promise;
  } finally {
    clearTimeout(timer);
    off();
  }
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
  return "";
}
