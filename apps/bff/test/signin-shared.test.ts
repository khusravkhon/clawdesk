import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SignInSessionManager } from "../src/ai-setup/signin-sessions.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// The main agent's subscription sign-in runs OpenClaw's setup wizard, which saves the credential in the
// shared store every agent reads through. Steps as recorded on a live OpenClaw 2026.8.1 Gateway.

const STEPS = [
  { type: "note", title: "OpenClaw setup" },
  { type: "confirm", message: "I understand this is personal-by-default… Continue?" },
  { type: "select", message: "Help make OpenClaw better?", options: [false, true] },
  { type: "select", message: "Setup mode", options: ["quickstart", "advanced", "import"] },
  { type: "note", title: "QuickStart" },
  { type: "select", message: "Model/auth provider", options: ["openai", "openrouter", "google", "skip"] },
  { type: "select", message: "OpenAI auth method", options: ["openai", "openai-device-code", "openai-api-key", "__back"] },
  { type: "progress", message: "Starting OAuth flow..." },
  { type: "note", title: "OAuth sign-in", message: "Open this URL in your LOCAL browser:\n\nhttps://auth.openai.com/oauth/authorize?x=1" },
  { type: "text", message: "Paste the redirect URL" },
  { type: "note", title: "Model configured", message: "Default model set to openai/gpt-5.6-sol" },
  { type: "select", message: "Default model", options: ["__keep__", "__manual__"] },
  { type: "confirm", message: "Test AI access now with a live completion?" },
  { type: "note", title: "How channels work" },
];

function fakeGateway() {
  const answers: { step: string; value: unknown }[] = [];
  let at = 0, chain = { primary: "openai/gpt-5.6-sol@openai:setup-old", fallbacks: ["deepseek/deepseek-chat"] } as { primary: string; fallbacks: string[] };
  const step = () => ({ done: false, step: { id: `s${at}`, ...STEPS[at], options: STEPS[at]!.options?.map(value => ({ value, label: String(value) })) } });
  const calls: string[] = [];
  const gateway = {
    request: vi.fn(async (method: string, params: { answer?: { stepId: string; value?: unknown }; raw?: string }) => {
      calls.push(method);
      if (method === "wizard.start") return { sessionId: "w1", ...step() };
      if (method === "wizard.next") {
        if (params.answer) { answers.push({ step: STEPS[at]!.message ?? STEPS[at]!.title ?? "", value: params.answer.value }); at++; }
        return step();
      }
      if (method === "wizard.cancel") return {};
      if (method === "config.get") return { hash: "h", config: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } }, entries: { main: { model: chain } } } } };
      if (method === "config.patch") { chain = JSON.parse(params.raw!).agents.entries.main.model; return {}; }
      throw new Error(method);
    }),
  } as unknown as GatewayService;
  return { gateway, answers, calls, chain: () => chain };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("main agent subscription sign-in through the setup wizard", () => {
  it("answers the wizard's own steps, asks the person only for the redirect, then shares the model", async () => {
    const { gateway, answers, calls, chain } = fakeGateway();
    let followed = 0;
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => { followed++; });
    const started = await manager.start("main", "openai");
    expect(calls[0]).toBe("wizard.start");
    await until(() => manager.get(started.sessionId).status === "waiting_for_user");
    const waiting = manager.get(started.sessionId);
    expect(waiting.prompt).toMatchObject({ kind: "text", message: "Paste the redirect URL" });
    expect(waiting.note).toContain("https://auth.openai.com/oauth/authorize");
    expect(answers.map(a => a.value)).toEqual([undefined, true, false, "quickstart", undefined, "openai", "openai", undefined, undefined]);

    await manager.answer(started.sessionId, { stepId: waiting.prompt!.stepId, value: "http://localhost:1455/auth/callback?code=abc" });
    await until(() => manager.get(started.sessionId).status === "done");
    expect(answers.slice(9).map(a => [a.step, a.value])).toEqual([
      ["Paste the redirect URL", "http://localhost:1455/auth/callback?code=abc"],
      ["Default model set to openai/gpt-5.6-sol", undefined],
      ["Default model", "__keep__"],
      ["Test AI access now with a live completion?", false],
    ]);
    expect(calls).toContain("wizard.cancel");
    // No pinned agent-local profile any more: main and its followers read the shared credential.
    expect(chain()).toEqual({ primary: "openai/gpt-5.6-sol", fallbacks: ["deepseek/deepseek-chat"] });
    expect(manager.get(started.sessionId).modelRef).toBe("openai/gpt-5.6-sol");
    expect(followed).toBe(1);
  });

  it("fails clearly when the wizard does not offer the chosen sign-in", async () => {
    const { gateway } = fakeGateway();
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {});
    const started = await manager.start("main", "minimax-portal");
    await until(() => manager.get(started.sessionId).status === "error");
    expect(manager.get(started.sessionId).error).toContain("minimax-portal");
  });
});
