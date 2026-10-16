import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/gateway/bridge-client.js";

const status = {
  folders: [{ agentId: "trainer", folder: "Training", state: "partial", lastAttempt: 1000, lastSuccess: null, conflicts: 0, skipped: 1,
    issues: [{ code: "file_too_large", path: "video.mp4" }], hashes: { private: "secret" }, workspaceIdentity: "secret" }],
};

describe("folder sync status bridge boundary", () => {
  it("requests the protected read-only endpoint and strips registry internals", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const bridge = new BridgeClient("http://bridge", "test-token", (async (url, init) => {
      request = { url: String(url), ...(init ? { init } : {}) };
      return new Response(JSON.stringify(status), { status: 200 });
    }) as typeof fetch);
    const result = await bridge.folderSyncStatus();
    expect(request?.url).toBe("http://bridge/files/sync-status");
    expect(request?.init?.method).toBe("GET");
    expect(request?.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.folders[0]?.issues[0]).toEqual({ code: "file_too_large", path: "video.mp4" });
  });

  it.each(["/private/file", "C:/private/file", "../file", "unsafe\nfile", "x".repeat(501)])("rejects unsafe diagnostic path %s", async (unsafe) => {
    const data = structuredClone(status);
    data.folders[0]!.issues[0]!.path = unsafe;
    const bridge = new BridgeClient("http://bridge", "test-token", (async () => new Response(JSON.stringify(data))) as typeof fetch);
    await expect(bridge.folderSyncStatus()).rejects.toThrow();
  });

  it("rejects unknown diagnostic codes", async () => {
    const data = structuredClone(status);
    data.folders[0]!.issues[0]!.code = "private raw error";
    const bridge = new BridgeClient("http://bridge", "test-token", (async () => new Response(JSON.stringify(data))) as typeof fetch);
    await expect(bridge.folderSyncStatus()).rejects.toThrow();
  });
});
