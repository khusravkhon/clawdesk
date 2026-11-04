import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { isSetupBusy, SignInSessionManager } from "../src/ai-setup/signin-sessions.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// "Try again" on a subscription sign-in: OpenClaw runs one setup at a time, so the previous
// sign-in of the agent is cancelled and the new start waits for the lock to be freed.

const LINK_STEP = { done: false, step: { id: "s1", type: "text", message: "Paste the redirect URL", externalUrl: "https://auth.openai.com/oauth/authorize?x=1" } };
const busy = Object.assign(new Error("OpenClaw setup is already in progress; try again when it finishes."), { details: { code: "SETUP_ADMISSION_BUSY" } });

function fakeGateway(busyStarts: number) {
  const calls: string[] = [];
  let running: string | null = null;
  let freeIn = 0;
  const gateway = {
    request: vi.fn(async (method: string, params: { sessionId?: string }) => {
      calls.push(`${method} ${params.sessionId ?? ""}`.trim());
      if (method === "openclaw.setup.auth.start") {
        if (running || freeIn > 0 || busyStarts > 0) {
          if (freeIn > 0) freeIn--;
          else if (busyStarts > 0) busyStarts--;
          throw busy;
        }
        running = params.sessionId!;
        return {};
      }
      if (method === "wizard.next") return params.sessionId === running ? LINK_STEP : { done: true, status: "cancelled" };
      if (method === "wizard.cancel") {
        if (params.sessionId === running) { running = null; freeIn = 1; }
        return { status: "cancelled" };
      }
      return {};
    }),
  } as unknown as GatewayService;
  return { gateway, calls };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("subscription sign-in retry", () => {
  it("cancels the agent's waiting sign-in and starts the new one once OpenClaw frees its lock", async () => {
    const { gateway, calls } = fakeGateway(0);
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, null, 1);
    const first = await manager.start("main", "openai");
    await until(() => manager.get(first.sessionId).status === "waiting_for_user");

    const second = await manager.start("main", "openai");
    expect(manager.get(first.sessionId).status).toBe("cancelled");
    expect(calls).toContain(`wizard.cancel ${first.sessionId}`);
    expect(calls.filter((c) => c === `openclaw.setup.auth.start ${second.sessionId}`)).toHaveLength(2);
    await until(() => manager.get(second.sessionId).status === "waiting_for_user");
  });

  it("gives up after a few busy answers", async () => {
    const { gateway } = fakeGateway(10);
    const manager = new SignInSessionManager(gateway, pino({ level: "silent" }), async () => {}, null, 1);
    await expect(manager.start("main", "openai")).rejects.toThrow(/already in progress/);
  });

  it("recognises OpenClaw's busy answer", () => {
    expect(isSetupBusy(busy)).toBe(true);
    expect(isSetupBusy(new Error("OpenClaw setup is already in progress; try again when it finishes."))).toBe(true);
    expect(isSetupBusy(new Error("unknown auth choice"))).toBe(false);
    expect(isSetupBusy(null)).toBe(false);
  });
});
