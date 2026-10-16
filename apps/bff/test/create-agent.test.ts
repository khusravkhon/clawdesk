import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateAgentRequest, FolderName } from "@clawdesk/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, schedules } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { createJuniorAgent, slugBase, uniqueSlug } from "../src/provision/create-agent.js";
import { SagaError } from "../src/provision/saga.js";
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

  it("uses a managed workspace folder without any host bind and tells the agent where it is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-agent-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "agents.list") return { agents: [{ id: "main", model: { primary: "google/gemini-flash-latest" } }] };
        if (method === "agents.create") return { agentId: params.name };
        if (method === "config.get") return { hash: "h", config: { agents: { entries: { dietitian: {}, main: { model: { primary: "google/gemini-flash-latest", fallbacks: ["deepseek/deepseek-v4-flash"] } } } } } };
        if (method === "cron.add") return { id: "job-1" };
        return { ok: true };
      },
    } as unknown as GatewayService;
    const ensured: string[] = [];
    const folders = {
      ensureAgentFolder: async (agentId: string, name: string) => {
        expect(calls.some((call) => call.method === "agents.create" && call.params.name === agentId)).toBe(true);
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
      expect(patch.tools.agentToAgent).toEqual({ enabled: true, allow: ["main", res.agentId] });
      expect(patch.tools.sessions.visibility).toBe("all");
      expect(patch.agents.entries[res.agentId].tools.deny).toContain("sessions_history");
      expect(patch.agents.entries[res.agentId].tools.alsoAllow).toEqual(["clawdesk_ask_main"]);
      // "Same as main": the whole chain, so the junior switches to the same backups.
      expect(patch.agents.entries[res.agentId].model).toEqual({ primary: "google/gemini-flash-latest", fallbacks: ["deepseek/deepseek-v4-flash"] });
      expect(res.model).toBe("google/gemini-flash-latest");
      expect(patch.agents.entries[res.agentId].sandbox).toEqual({
        mode: "all",
        scope: "agent",
        workspaceAccess: "rw",
      });
      const agentsMd = calls.find((c) => c.method === "agents.files.set" && c.params.name === "AGENTS.md")!.params.content as string;
      expect(agentsMd).toContain("Твоя папка: `/workspace/folders/Питание`");
      expect(agentsMd).toContain("спрашивай главного ассистента");
      // Data from the main agent is kept in the folder and reused.
      expect(agentsMd).toContain("сохрани в папку `/workspace/folders/Питание/данные`");
      const listed = await listAgents({ gateway: { request: async () => ({ defaultId: "main", agents: [{ id: res.agentId }] }) } as unknown as GatewayService, db, sandboxEnabled: true });
      expect(listed.agents[0]!.folder).toBe("Питание");
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("junior agent rollback", () => {
  type Call = { method: string; params: Record<string, unknown> };
  const request = CreateAgentRequest.parse({
    templateId: "dietitian", mode: "personal", values: { goal: "меньше сахара" },
    canAskMain: false, ai: "free", schedules: [], timezone: "Asia/Dushanbe",
  });

  async function scenario(
    respond: (call: Call, calls: Call[]) => unknown,
    verify: (create: (req?: typeof request) => ReturnType<typeof createJuniorAgent>, calls: Call[]) => Promise<void>,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-rollback-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const calls: Call[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        const call = { method, params };
        calls.push(call);
        const override = await respond(call, calls);
        if (override !== undefined) return override;
        if (method === "agents.list") return { agents: [{ id: "main" }] };
        if (method === "agents.create") return { agentId: params.name };
        if (method === "config.get") return { hash: "h", config: { agents: { entries: { dietitian: {} } } } };
        if (method === "cron.add") return { id: `job-${calls.filter((c) => c.method === method).length}` };
        return { ok: true };
      },
    } as unknown as GatewayService;
    try {
      await verify((req = request) => createJuniorAgent({ gateway, db, logger: pino({ level: "silent" }), sandboxEnabled: true }, req), calls);
      expect(db.select().from(agents).all().filter((agent) => agent.id !== "main")).toEqual([]);
      expect(db.select().from(schedules).all()).toEqual([]);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("deletes the confirmed created agent when setting its display name fails", async () => {
    await scenario(({ method }) => {
      if (method === "agents.update") throw new Error("update failed");
    }, async (create, calls) => {
      await expect(create()).rejects.toMatchObject({ failedStep: "agents.update", rollbackErrors: [] });
      expect(calls.filter((c) => c.method === "agents.delete")).toEqual([
        { method: "agents.delete", params: { agentId: "dietitian", deleteFiles: true } },
      ]);
      expect(calls.some((c) => c.method === "agents.files.set")).toBe(false);
    });
  });

  it("does not delete an unconfirmed resource when creation fails", async () => {
    await scenario(({ method }) => {
      if (method === "agents.create") throw new Error("connection lost");
    }, async (create, calls) => {
      await expect(create()).rejects.toMatchObject({ failedStep: "agents.create" });
      expect(calls.some((c) => c.method === "agents.delete")).toBe(false);
    });
  });

  it("cleans up the returned agent id if the gateway assigns an unexpected id", async () => {
    await scenario(({ method }) => method === "agents.create" ? { agentId: "assigned-id" } : undefined, async (create, calls) => {
      await expect(create()).rejects.toThrow('gateway assigned id "assigned-id" instead of "dietitian"');
      expect(calls.find((c) => c.method === "agents.delete")?.params.agentId).toBe("assigned-id");
      expect(calls.some((c) => c.method === "agents.update")).toBe(false);
    });
  });

  it.each([false, true])("removes the first schedule when the second fails; reports removal failure=%s", async (removeFails) => {
    const schedules = [
      { presetId: null, label: "Morning", cron: "0 8 * * *", prompt: "menu" },
      { presetId: null, label: "Evening", cron: "0 20 * * *", prompt: "summary" },
    ];
    await scenario(({ method }, calls) => {
      if (method === "cron.add" && calls.filter((c) => c.method === method).length === 2) throw new Error("second schedule failed");
      if (method === "cron.remove" && removeFails) throw new Error("remove failed");
    }, async (create, calls) => {
      const error = await create({ ...request, schedules }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SagaError);
      expect((error as SagaError).failedStep).toBe("cron.add:2");
      expect((error as SagaError).rollbackErrors.map((e) => e.step)).toEqual(removeFails ? ["cron.add:1"] : []);
      expect(calls.filter((c) => ["cron.remove", "agents.delete"].includes(c.method))).toEqual([
        { method: "cron.remove", params: { id: "job-1" } },
        { method: "agents.delete", params: { agentId: "dietitian", deleteFiles: true } },
      ]);
    });
  });
});
