import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateAgentRequest, FolderName } from "@clawdesk/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { createJuniorAgent, slugBase, uniqueSlug } from "../src/provision/create-agent.js";
import { listAgents } from "../src/routes/agents.js";

describe("agent ids", () => {
  it("uses the template id, or a latin slug of the name for custom agents", () => {
    expect(slugBase({ id: "dietitian" }, "Диетолог")).toBe("dietitian");
    expect(slugBase({ id: "custom" }, "Sales Helper 2!")).toBe("sales-helper-2");
    expect(slugBase({ id: "custom" }, "Помощник по продажам")).toBe("agent");
  });

  it("never collides with existing agents or main", () => {
    expect(uniqueSlug("dietitian", new Set(["main"]))).toBe("dietitian");
    expect(uniqueSlug("dietitian", new Set(["dietitian", "dietitian-2"]))).toBe("dietitian-3");
    expect(uniqueSlug("main", new Set(["main"]))).toBe("main-2");
  });
});

describe("CreateAgentRequest", () => {
  const base = { templateId: "dietitian", mode: "personal", values: { goal: "x" }, canAskMain: true, ai: "inherit", timezone: "Asia/Dushanbe" } as const;

  it("accepts daily and weekday schedules", () => {
    const ok = CreateAgentRequest.safeParse({
      ...base,
      schedules: [
        { presetId: "daily-menu", label: "07:30", cron: "30 7 * * *", prompt: "menu" },
        { presetId: null, label: "Sun", cron: "0 20 * * 0", prompt: "sum" },
        { presetId: null, label: "Weekdays", cron: "5 9 * * 1,2,3,4,5", prompt: "plan" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects schedules outside what the builder can express", () => {
    for (const cron of ["*/5 * * * *", "0 25 * * *", "0 8 1 * *", "0 8 * * 7", "rm -rf"]) {
      const res = CreateAgentRequest.safeParse({ ...base, schedules: [{ presetId: null, label: "x", cron, prompt: "p" }] });
      expect(res.success, cron).toBe(false);
    }
  });
});

describe("junior agent folders", () => {
  it("accepts folder names people type, rejects ones that break a bind or a path", () => {
    for (const name of ["Питание", "Идеи для YouTube", "Training 2", "a.b-c_d"]) expect(FolderName.safeParse(name).success, name).toBe(true);
    for (const name of ["", "../etc", "a/b", "C:x", "a,b", ".hidden", "x".repeat(61)]) expect(FolderName.safeParse(name).success, name).toBe(false);
  });

  it("binds only the agent's own folder into its sandbox and tells the agent where it is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-agent-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "agents.list") return { agents: [{ id: "main", model: { primary: "google/gemini-flash-latest" } }] };
        if (method === "agents.create") return { agentId: params.name };
        if (method === "config.get") return { hash: "h", config: {} };
        if (method === "cron.add") return { id: "job-1" };
        return { ok: true };
      },
    } as unknown as GatewayService;
    const ensured: string[] = [];
    const folders = {
      ensureFolder: async (name: string) => {
        ensured.push(name);
        return { hostPath: `/var/lib/clawdesk/files/${name}`, gatewayPath: `/var/lib/clawdesk/openclaw/workspace/files/${name}` };
      },
    };
    try {
      const res = await createJuniorAgent(
        { gateway, db, logger: pino({ level: "silent" }), sandboxEnabled: true, folders },
        CreateAgentRequest.parse({ templateId: "dietitian", mode: "personal", values: { goal: "меньше сахара" }, canAskMain: true, ai: "inherit", schedules: [], timezone: "Asia/Dushanbe", folder: "Питание" }),
      );
      expect(ensured).toEqual(["Питание"]);
      const patch = JSON.parse(calls.find((c) => c.method === "config.patch")!.params.raw as string);
      expect(patch.agents.entries[res.agentId].sandbox).toEqual({
        mode: "all",
        scope: "agent",
        workspaceAccess: "rw",
        docker: { binds: ["/var/lib/clawdesk/files/Питание:/workspace/folders/Питание:rw"] },
      });
      const agentsMd = calls.find((c) => c.method === "agents.files.set" && c.params.name === "AGENTS.md")!.params.content as string;
      expect(agentsMd).toContain("Твоя папка: `/workspace/folders/Питание`");
      expect(agentsMd).toContain("спрашивай главного ассистента");
      const listed = await listAgents({ gateway: { request: async () => ({ defaultId: "main", agents: [{ id: res.agentId }] }) } as unknown as GatewayService, db, sandboxEnabled: true });
      expect(listed.agents[0]!.folder).toBe("Питание");
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
