import type { GatewayService } from "../gateway/gateway-service.js";
import { toChatMessages, type RawChatMessage } from "./chat-service.js";

// One question to the main agent's model, answered in a session of its own (never the owner's chat): send,
// wait for the turn's final event, read the reply from the session's history. Used where the panel needs
// the model's text back (the requirements interview), not a conversation.

export class OneShotError extends Error {
  constructor(readonly code: "timeout" | "model_unavailable") { super(code); }
}

export type OneShot = (message: string, key: string) => Promise<string>;

export function oneShot(gateway: Pick<GatewayService, "request" | "onEvent">, { timeoutMs = 150_000 } = {}): OneShot {
  return async (message, key) => {
    const sessionKey = `agent:main:clawdesk-${key}`;
    let off = () => {};
    // Listening starts before the message goes out, so a quick reply is not missed.
    const ended = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new OneShotError("timeout")); }, timeoutMs);
      off = gateway.onEvent((event) => {
        const payload = event.payload as { sessionKey?: string; state?: string } | undefined;
        if (event.event !== "chat" || payload?.sessionKey !== sessionKey || !["final", "error", "aborted"].includes(payload.state ?? "")) return;
        clearTimeout(timer); off(); resolve(payload.state!);
      });
    });
    try {
      await gateway.request("chat.send", { sessionKey, agentId: "main", message, idempotencyKey: `clawdesk-${key}` }, { timeoutMs: 60_000 });
    } catch {
      off();
      throw new OneShotError("model_unavailable");
    }
    if ((await ended) !== "final") throw new OneShotError("model_unavailable");
    const history = await gateway.request<{ messages?: RawChatMessage[] }>("chat.history", { sessionKey, agentId: "main", limit: 8 });
    const reply = toChatMessages(history.messages ?? []).filter((item) => item.role === "assistant" && item.status === "ok").at(-1)?.text;
    if (!reply) throw new OneShotError("model_unavailable");
    return reply;
  };
}
