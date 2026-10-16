import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, agentSourceGrants, dataSources } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { repairAgentFolders } from "../src/provision/agent-folders.js";

describe("managed agent folder migration", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>["db"];
  let close: () => void;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-folder-migration-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
    db.insert(agents).values({ id: "trainer", displayName: "Trainer", role: "specialist", sandbox: true }).run();
    db.insert(dataSources).values({ id: "folder:Training", kind: "folder", connectorRef: "Training", scope: "/run/desktop/mnt/host/c/Users/owner/Training", status: "connected" }).run();
    db.insert(agentSourceGrants).values({ agentId: "trainer", sourceId: "folder:Training", access: "write" }).run();
  });
  afterEach(() => { close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("imports first and removes only the old folder bind, explicitly preserving isolation and other mounts", async () => {
    const binds = ["/run/desktop/mnt/host/c/Users/owner/Training:/workspace/folders/Training:rw", "/safe/project:/project:ro"];
    const writes: Record<string, any>[] = [];
    let imported = false;
    const gateway = { request: async (method: string, params: Record<string, any>) => {
      if (method === "config.get") return { hash: "h", config: { agents: { entries: { trainer: { sandbox: { mode: "all", docker: { binds } } } } } } };
      if (method === "config.patch") { expect(imported).toBe(true); writes.push(params); }
      return { ok: true };
    } } as unknown as GatewayService;
    await repairAgentFolders({ gateway, db, logger: pino({ level: "silent" }), bridge: { ensureAgentFolder: async (id, name) => {
      expect([id, name]).toEqual(["trainer", "Training"]); imported = true; return { hostPath: "host", gatewayPath: "managed" };
    } } });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.replacePaths).toEqual(["agents.entries.trainer.sandbox.docker.binds"]);
    expect(JSON.parse(writes[0]!.raw)).toEqual({ agents: { entries: { trainer: { sandbox: { docker: { binds: ["/safe/project:/project:ro"] } } } } } });
    expect(db.select().from(agentSourceGrants).all()).toHaveLength(1);
  });

  it("never removes the old bind if file import fails", async () => {
    let writes = 0;
    const gateway = { request: async (method: string) => {
      if (method === "config.patch") writes++;
      return { config: { agents: { entries: { trainer: { sandbox: { docker: { binds: ["/old:/workspace/folders/Training:rw"] } } } } } } };
    } } as unknown as GatewayService;
    await repairAgentFolders({ gateway, db, logger: pino({ level: "silent" }), bridge: { ensureAgentFolder: async () => { throw new Error("unsafe symlink"); } } });
    expect(writes).toBe(0);
  });

  it("re-registers synchronization on restart without rewriting already migrated config", async () => {
    let imports = 0, writes = 0;
    const gateway = { request: async (method: string) => {
      if (method === "config.patch") writes++;
      return { config: { agents: { entries: { trainer: { sandbox: { docker: { binds: [] } } } } } } };
    } } as unknown as GatewayService;
    await repairAgentFolders({ gateway, db, logger: pino({ level: "silent" }), bridge: { ensureAgentFolder: async () => { imports++; return { hostPath: "host", gatewayPath: "managed" }; } } });
    expect(imports).toBe(1); expect(writes).toBe(0);
  });
});
