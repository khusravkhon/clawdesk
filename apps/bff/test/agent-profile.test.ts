import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateAgentRequest } from "@clawdesk/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, schedules } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { filesToTemplate, findTemplate, listUserTemplates, readProfile, saveAsTemplate, saveProfile, templateId } from "../src/provision/agent-profile.js";
import { createJuniorAgent } from "../src/provision/create-agent.js";

const logger = pino({ level: "silent" });

describe("agent → template", () => {
  it("turns the agent's name into {{agentName}}, drops the folder block and defuses stray braces", () => {
    const files = filesToTemplate(
      {
        soul: "# Копилка\n\nКопилка считает {{не плейсхолдер}}.",
        user: "О владельце",
        agents: "# Учёт\n\nФайлы.\n\n## Твоя папка (ClawDesk)\n\nТвоя папка: `/workspace/folders/Копилка`.",
      },
      "Копилка",
    );
    expect(files["SOUL.md"]).toBe("# {{agentName}}\n\n{{agentName}} считает { {не плейсхолдер}}.");
    expect(files["AGENTS.md"]).toBe("# Учёт\n\nФайлы.\n");
    expect(files["USER.md"]).toBe("О владельце");
  });

  it("also drops the block about data from the main agent", () => {
    const files = filesToTemplate({ soul: "", user: "", agents: "Своё.\n\n## Данные от главного (ClawDesk)\n\nСпрашивай главного." }, "Агент");
    expect(files["AGENTS.md"]).toBe("Своё.\n");
  });

  it("does not replace very short names inside ordinary words", () => {
    expect(filesToTemplate({ soul: "# Я\n\nЯблоко", user: "", agents: "" }, "Я")["SOUL.md"]).toBe("# Я\n\nЯблоко");
  });

  it("makes ids that never collide with built-in templates", () => {
    expect(templateId("Money Box")).toMatch(/^my-money-box-[0-9a-f]{6}$/);
    expect(templateId("Копилка")).toMatch(/^my-[0-9a-f]{6}$/);
  });
});

describe("editing an agent and reusing it", () => {
  it("saves files and name, saves it as a template, and creates a new agent from that template", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-profile-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const files: Record<string, Record<string, string>> = {
      piggy: { "SOUL.md": "# Копилка\n\nСчитаю деньги.", "USER.md": "Валюта: TJS", "AGENTS.md": "Учёт в файле." },
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        const id = params.agentId as string;
        if (method === "agents.files.get") return { file: { content: files[id]?.[params.name as string] ?? "" } };
        if (method === "agents.files.set") (files[id] ??= {})[params.name as string] = params.content as string;
        if (method === "agents.list") return { agents: [{ id: "main" }, { id: "piggy" }] };
        if (method === "agents.create") return { agentId: params.name };
        if (method === "config.get") return { hash: "h", config: {} };
        if (method === "cron.add") return { id: `job-${calls.length}` };
        return { ok: true };
      },
    } as unknown as GatewayService;
    try {
      db.insert(agents).values({ id: "piggy", role: "specialist", parentId: "main", templateId: "custom", displayName: "Копилка", avatar: "🐷", model: null, status: "ready" }).run();
      db.insert(schedules)
        .values([
          { id: "j1", agentId: "piggy", cron: "0 21 * * *", tz: "Asia/Dushanbe", prompt: "Спроси про траты за день" },
          { id: "j2", agentId: "piggy", cron: "0 9 1 * *", tz: "Asia/Dushanbe", prompt: "Не для конструктора: раз в месяц" },
        ])
        .run();
      const deps = { gateway, db, logger };

      // Edit: new instruction and name.
      const saved = await saveProfile(deps, "piggy", { name: "Копилка", emoji: "🐖", files: { soul: "# Копилка\n\nСчитаю деньги и цели.", user: "Валюта: TJS", agents: "Учёт в файле." } });
      expect(saved.files.soul).toContain("цели");
      expect(saved.emoji).toBe("🐖");
      expect(calls.some((c) => c.method === "agents.update" && c.params.emoji === "🐖")).toBe(true);
      expect((await readProfile(deps, "piggy")).name).toBe("Копилка");

      // Save as a template: the name becomes a field, the builder-friendly schedule a preset.
      const tpl = await saveAsTemplate({ ...deps, mode: "personal" }, "piggy", { title: "Копилка", description: "Считает деньги" });
      expect(tpl.own).toBe(true);
      expect(tpl.fields).toEqual([{ key: "agentName", type: "text", label: { ru: "Имя", en: "Name", tg: "Ном" }, required: true, default: "Копилка" }]);
      expect(tpl.cronPresets.map((p) => p.cron)).toEqual(["0 21 * * *"]);
      expect(listUserTemplates(db, "company")).toEqual([]);
      expect(findTemplate(db, "company", tpl.id)).toBeNull();

      // A new agent from it gets its own name everywhere the old one had it.
      const res = await createJuniorAgent(
        { gateway, db, logger, sandboxEnabled: false },
        CreateAgentRequest.parse({
          templateId: tpl.id,
          mode: "personal",
          values: { agentName: "Сейф" },
          canAskMain: false,
          ai: "own",
          schedules: tpl.cronPresets.map((p) => ({ presetId: p.id, label: p.label.ru, cron: p.cron, prompt: p.prompt })),
          timezone: "Asia/Dushanbe",
        }),
      );
      expect(res.agentId).toBe("seyf");
      expect(files[res.agentId]!["SOUL.md"]).toBe("# Сейф\n\nСчитаю деньги и цели.");
      expect(res.cronJobIds).toHaveLength(1);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the main agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-profile-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    try {
      db.insert(agents).values({ id: "main", role: "main", displayName: "Ассистент", status: "ready" }).run();
      await expect(readProfile({ gateway: {} as GatewayService, db, logger }, "main")).rejects.toThrow(/assistant screen/);
      await expect(readProfile({ gateway: {} as GatewayService, db, logger }, "nobody")).rejects.toThrow(/not managed/);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
