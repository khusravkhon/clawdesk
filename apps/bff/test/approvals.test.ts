import { describe, expect, it } from "vitest";
import { applyMode, modeOf, toHistoryItem, toPending } from "../src/approvals/approvals-service.js";

describe("exec modes", () => {
  const allowlist = [{ pattern: "/usr/bin/ls" }];

  it("ask: allowlist + ask on miss, refused when nobody answers; the allowlist stays", () => {
    expect(applyMode({ allowlist }, "ask")).toEqual({ allowlist, security: "allowlist", ask: "on-miss", askFallback: "deny" });
    expect(modeOf(applyMode(undefined, "ask"))).toBe("ask");
  });

  it("full removes the panel's restriction instead of loosening the config", () => {
    expect(applyMode({ allowlist, security: "allowlist", ask: "on-miss", askFallback: "deny" }, "full")).toEqual({ allowlist });
    expect(modeOf({ allowlist })).toBe("full");
  });

  it("deny blocks everything", () => {
    expect(modeOf(applyMode({}, "deny"))).toBe("deny");
  });
});

describe("approval records", () => {
  it("shows the command and who asked", () => {
    expect(
      toPending({
        id: "a1",
        approvalKind: "exec",
        createdAtMs: 1,
        expiresAtMs: 2,
        request: { commandArgv: ["ls", "-la", "files/"], cwd: "/w", agentId: "main", sessionKey: "agent:main:main", warningText: null },
      }),
    ).toEqual({ id: "a1", kind: "exec", command: "ls -la files/", cwd: "/w", warning: null, agentId: "main", sessionKey: "agent:main:main", createdAt: 1, expiresAt: 2 });
  });

  it("keeps only known terminal states in history", () => {
    expect(toHistoryItem({ id: "h", status: "allowed", decision: "allow-once", resolvedAtMs: 5, source: { agentId: "main" }, presentation: { kind: "exec", commandText: "ls" } })).toEqual({
      id: "h",
      command: "ls",
      agentId: "main",
      status: "allowed",
      decision: "allow-once",
      resolvedAt: 5,
    });
    expect(toHistoryItem({ id: "x", status: "weird" })).toBeNull();
  });
});
