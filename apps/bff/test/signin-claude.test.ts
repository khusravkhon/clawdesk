import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SignInSessionManager, type ClaudeCodeLogin } from "../src/ai-setup/signin-sessions.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// Claude plan: Claude Code's own sign-in in the Gateway, then OpenClaw's "claude-cli" activation.

const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=s";

function fakeGateway(activation: unknown = { ok: true, status: "ok", modelRef: "anthropic/claude-opus-5" }) {
  const calls: { method: string; params: unknown }[] = [];
  const gateway = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "openclaw.setup.activate") return activation;
      return {};
    }),
  } as unknown as GatewayService;
  return { gateway, calls };
}

function fakeClaude(loggedIn: boolean, accept = true): ClaudeCodeLogin & { codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    claudeStatus: async () => ({ installed: true, loggedIn, subscription: loggedIn ? "max" : null }),
    claudeLoginStart: async () => ({ authorizationUrl: LINK }),
    claudeLoginComplete: async (code) => {
      codes.push(code);
      if (!accept) throw new Error("Login failed: Request failed with status code 400");
      return { installed: true, loggedIn: true, subscription: "max" };
    },
  };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("Claude plan sign-in", () => {
  it("shows the link, takes the code, then activates the Claude CLI route for that agent", async () => {
    const { gateway, calls } = fakeGateway();
    const claude = fakeClaude(false);
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, claude);
    const state = await manager.start("main", "claude-plan");
    expect(state).toMatchObject({ url: LINK, paste: "code" });
    await until(() => manager.get(state.sessionId).status === "waiting_for_user");
    expect(calls.find((c) => c.method === "openclaw.setup.activate")).toBeUndefined();

    const prompt = manager.get(state.sessionId).prompt!;
    expect(prompt).toMatchObject({ kind: "text", sensitive: true });
    manager.answer(state.sessionId, { stepId: prompt.stepId, value: "code#state" });
    await until(() => manager.get(state.sessionId).status === "done");

    expect(claude.codes).toEqual(["code#state"]);
    expect(calls.find((c) => c.method === "openclaw.setup.activate")?.params).toEqual({ agentId: "main", kind: "claude-cli" });
    expect(manager.get(state.sessionId)).toMatchObject({ modelRef: "anthropic/claude-opus-5", url: null, paste: null });
  });

  it("skips the login when Claude Code is already signed in (another agent)", async () => {
    const { gateway, calls } = fakeGateway();
    const claude = fakeClaude(true);
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, claude);
    const state = await manager.start("finance", "claude-plan");
    expect(state.url).toBeNull();
    await until(() => manager.get(state.sessionId).status === "done");
    expect(claude.codes).toEqual([]);
    expect(calls.find((c) => c.method === "openclaw.setup.activate")?.params).toEqual({ agentId: "finance", kind: "claude-cli" });
  });

  it("reports a login Claude refuses (expired plan, revoked sign-in) as a known error", async () => {
    const { gateway } = fakeGateway({ ok: false, status: "auth", error: "401 invalid token" });
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, fakeClaude(true));
    const state = await manager.start("main", "claude-plan");
    await until(() => manager.get(state.sessionId).status === "error");
    expect(manager.get(state.sessionId)).toMatchObject({ errorCode: "claude_auth", modelRef: null });
  });

  it("a rejected code ends with a known error and never touches the agent's models", async () => {
    const { gateway, calls } = fakeGateway();
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, fakeClaude(false, false));
    const state = await manager.start("main", "claude-plan");
    await until(() => manager.get(state.sessionId).status === "waiting_for_user");
    manager.answer(state.sessionId, { stepId: manager.get(state.sessionId).prompt!.stepId, value: "old" });
    await until(() => manager.get(state.sessionId).status === "error");
    expect(manager.get(state.sessionId).errorCode).toBe("claude_code_rejected");
    expect(calls.map((c) => c.method)).not.toContain("openclaw.setup.activate");
  });

  it("is refused when the Gateway has no Claude Code", async () => {
    const { gateway } = fakeGateway();
    await expect(new SignInSessionManager(gateway, pino({ level: "silent" })).start("main", "claude-plan")).rejects.toThrow(/Claude Code/);
  });
});
