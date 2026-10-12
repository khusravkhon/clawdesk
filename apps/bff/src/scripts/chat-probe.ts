// Chat: send one message to an agent, print the events it streams, then the history page.
//
//   pnpm --filter @clawdesk/bff chat-probe [--agent main] [--text "..."] [--history-only]

import { randomUUID } from "node:crypto";
import { connectForScript, flagValue, hasFlag, short } from "./_cli.js";

const agentId = flagValue("agent") ?? "main";
const text = flagValue("text") ?? "Привет! Ответь одним коротким предложением: ты на связи?";
const sessionKey = `agent:${agentId}:main`;

const { gateway, done } = await connectForScript();
try {
  if (!hasFlag("history-only")) {
    const events: string[] = [];
    const finished = new Promise<void>((resolve) => {
      const off = gateway.onEvent((event) => {
        const payload = event.payload as { sessionKey?: string; state?: string; runId?: string } | undefined;
        if (event.event === "agent") {
          const p = event.payload as { stream?: string; sessionKey?: string; data?: unknown };
          if (p?.sessionKey === sessionKey && p.stream !== "assistant") console.log(`← agent/${p.stream} ${short(p.data, 400)}`);
          return;
        }
        if (event.event !== "chat" && !event.event.startsWith("session")) {
          events.push(`(other) ${event.event}`);
          return;
        }
        if (payload?.sessionKey && payload.sessionKey !== sessionKey) return;
        console.log(`← ${event.event} ${short(payload, 700)}`);
        if (event.event === "chat" && ["final", "error", "aborted"].includes(payload?.state ?? "")) {
          off();
          resolve();
        }
      });
    });
    const t0 = Date.now();
    const sent = await gateway.request("chat.send", { sessionKey, agentId, message: text, idempotencyKey: randomUUID() }, { timeoutMs: 60_000 });
    console.log(`→ chat.send: ${short(sent, 800)}`);
    await Promise.race([finished, new Promise((r) => setTimeout(r, 120_000))]);
    console.log(`done in ${Date.now() - t0} ms; other events: ${[...new Set(events)].join(", ")}`);
  }

  type Part = { type: string; text?: string; name?: string; arguments?: unknown };
  type Msg = { role: string; timestamp?: number; content: string | Part[]; [k: string]: unknown };
  const history = await gateway.request<{ messages?: Msg[]; [k: string]: unknown }>("chat.history", { sessionKey, agentId, limit: 12 });
  console.log(`\nchat.history keys: ${Object.keys(history).join(", ")}`);
  for (const m of history.messages ?? []) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const summary = parts
      .map((p) => (p.type === "text" ? `text: ${(p.text ?? "").replace(/\s+/g, " ").slice(0, 160)}` : p.type === "toolCall" ? `tool ${p.name} ${short(p.arguments, 120)}` : p.type))
      .join(" | ");
    console.log(`  ${m.role.padEnd(10)} ${m.timestamp ? new Date(m.timestamp).toISOString() : "-"} ${String(m.stopReason ?? "").padEnd(8)} ${short(m.__openclaw ?? null, 160).replace(/\s+/g, " ")}  ${summary}`);
  }
  console.log(`message fields: ${Object.keys(history.messages?.[0] ?? {}).join(", ")}`);
} finally {
  await done();
}
