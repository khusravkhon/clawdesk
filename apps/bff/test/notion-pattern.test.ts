import { SaveNotionPatternRequest } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, schedules } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { filesToTemplate } from "../src/provision/agent-profile.js";
import { juniorBlock, juniorBlockFor, NotionPatternError, NotionPatternService, setNotionBlock } from "../src/sources/notion-pattern.js";

const logger = { warn() {}, info() {} } as never;
const OWN = "# AGENTS.md\n\nOpenClaw's own instructions.\n";

type Fail = { add?: (params: Record<string, unknown>) => boolean; update?: boolean; remove?: boolean };

function harness(opts: { connected?: boolean; guard?: () => Promise<void> } = {}) {
  const fail: Fail = {};
  const zone = { tz: "Asia/Dushanbe" };
  const { db } = openDb(":memory:");
  const files = new Map<string, string>([["main", OWN], ["coach", "# Coach\n"], ["writer", "# Writer\n"]]);
  const jobs = new Map<string, Record<string, unknown>>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const told: string[] = [];
  let n = 0;
  const gateway = { request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "agents.files.get") return { file: { content: files.get(params.agentId as string) ?? "" } };
    if (method === "agents.files.set") { files.set(params.agentId as string, params.content as string); return {}; }
    if (method === "cron.list") return { jobs: [...jobs].map(([id, job]) => ({ id, ...job })), hasMore: false };
    if (method === "cron.add") { if (fail.add?.(params)) throw new Error("gateway is reconnecting"); const id = `job-${++n}`; jobs.set(id, params); return { id }; }
    if (method === "cron.update") { if (fail.update) throw new Error("timeout"); if (!jobs.has(params.id as string)) throw new Error("not found"); jobs.set(params.id as string, { ...jobs.get(params.id as string), ...(params.patch as object) }); return {}; }
    if (method === "cron.remove") { if (fail.remove) throw new Error("timeout"); jobs.delete(params.id as string); return {}; }
    return {};
  } } as unknown as GatewayService;
  db.insert(agents).values([
    { id: "main", role: "main", displayName: "Main", status: "ready" },
    { id: "coach", role: "specialist", displayName: "Coach", status: "ready", canAskMain: true },
    { id: "writer", role: "specialist", displayName: "Writer", status: "ready", canAskMain: false },
  ]).run();
  const service = new NotionPatternService({
    gateway, db, logger,
    connected: async () => opts.connected ?? true,
    timeZone: () => zone.tz,
    delivery: () => ({ mode: "announce", channel: "telegram", to: "42", bestEffort: true }),
    tellMain: async (message) => { told.push(message); },
    guard: opts.guard,
  });
  return { db, files, jobs, calls, told, service, fail, zone };
}

const save = (req: Partial<SaveNotionPatternRequest>) => SaveNotionPatternRequest.parse({ pattern: "second_brain", ...req });

describe("Notion pattern", () => {
  it("gives the main agent the structure, juniors that may ask it the filing rule, and the owner a digest and a weekly review", async () => {
    const h = harness();
    const dto = await h.service.save(save({ digestHour: 8, weeklyReview: true }));
    expect(dto).toEqual({ pattern: "second_brain", notes: "", digestHour: 8, weeklyReview: true, agents: 1 });

    const main = h.files.get("main")!;
    expect(main.startsWith(OWN.trimEnd())).toBe(true);
    expect(main).toContain("шаблон «Second Brain»");
    expect(main).toContain("notion-map.md");
    expect(h.files.get("coach")).toContain("Запиши в Notion:");
    expect(h.files.get("writer")).toBe("# Writer\n");

    const added = [...h.jobs.values()];
    expect(added.map((j) => (j.schedule as { expr: string }).expr)).toEqual(["0 8 * * *", "0 18 * * 0"]);
    expect(added.every((j) => j.agentId === "main" && (j.schedule as { tz: string }).tz === "Asia/Dushanbe" && (j.delivery as { to: string }).to === "42")).toBe(true);
    expect(h.db.select().from(schedules).all().map((r) => r.openclawCronId)).toEqual(["job-1", "job-2"]);
    expect(h.told).toHaveLength(1);
  });

  it("changing the time updates the same run, dropping the review removes it, and the main agent is not asked again", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8, weeklyReview: true }));
    await h.service.save(save({ digestHour: 9, weeklyReview: false }));
    expect([...h.jobs.keys()]).toEqual(["job-1"]);
    expect((h.jobs.get("job-1")!.schedule as { expr: string }).expr).toBe("0 9 * * *");
    expect(h.db.select().from(schedules).all()).toEqual([expect.objectContaining({ openclawCronId: "job-1", cron: "0 9 * * *" })]);
    expect(h.told).toHaveLength(1);
  });

  it("adds a run again when it was deleted elsewhere", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8 }));
    h.jobs.clear();
    await h.service.save(save({ digestHour: 7 }));
    expect([...h.jobs.keys()]).toEqual(["job-2"]);
    expect(h.db.select().from(schedules).all().map((r) => r.openclawCronId)).toEqual(["job-2"]);
  });

  it("no pattern (or Notion disconnected) takes the rules and runs away and leaves the agents' own text as it was", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8, weeklyReview: true }));
    await h.service.clear();
    expect(h.files.get("main")).toBe(OWN);
    expect(h.files.get("coach")).toBe("# Coach\n");
    expect(h.jobs.size).toBe(0);
    expect(h.db.select().from(schedules).all()).toEqual([]);
    expect((await h.service.get()).pattern).toBeNull();
  });

  it("needs Notion connected to choose a pattern", async () => {
    const h = harness({ connected: false });
    await expect(h.service.save(save({}))).rejects.toBeInstanceOf(NotionPatternError);
    expect(h.calls).toEqual([]);
  });

  it("a custom structure is the owner's own words, and needs them", async () => {
    expect(() => SaveNotionPatternRequest.parse({ pattern: "custom", notes: "кратко" })).toThrow();
    const h = harness();
    await h.service.save(save({ pattern: "custom", notes: "Базы: Дела (статус, срок)\nИдеи — всё остальное" }));
    expect(h.files.get("main")).toContain("> Базы: Дела (статус, срок)\n> Идеи — всё остальное");
  });

  it("on start an edited block is put back, and new juniors get it at creation", async () => {
    const h = harness();
    await h.service.save(save({}));
    h.files.set("main", h.files.get("main")!.replace("Second Brain", "что-то другое"));
    await h.service.refresh();
    expect(h.files.get("main")).toContain("шаблон «Second Brain»");
    expect(juniorBlockFor(h.db)).toContain("Запиши в Notion:");
  });

  it("the block is replaced in place and saving an agent as a template leaves it out", () => {
    const a = juniorBlock("second_brain")!, b = juniorBlock("tasks_notes")!;
    const once = setNotionBlock("text", a);
    expect(setNotionBlock(once, b)).toBe(`text\n\n${b}\n`);
    expect(setNotionBlock(once, a)).toBe(once);
    expect(setNotionBlock(once, null)).toBe("text\n");
    const coach = setNotionBlock("# Coach\n\n## Данные от главного (ClawDesk)\n\nспроси главного", a);
    expect(filesToTemplate({ soul: "", user: "", agents: coach }, "Coach")["AGENTS.md"]).not.toContain("Notion");
  });

  it("saving keeps a run the spending limit (or the owner) paused paused", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8 }));
    h.jobs.set("job-1", { ...h.jobs.get("job-1"), enabled: false });
    h.db.update(schedules).set({ enabled: false }).run();
    await h.service.save(save({ digestHour: 9, notes: "Сферы: Работа, Здоровье" }));
    expect(h.jobs.get("job-1")!.enabled).toBe(false);
    expect(h.db.select().from(schedules).all()).toEqual([expect.objectContaining({ enabled: false, cron: "0 9 * * *" })]);
  });

  it("a new run waits for the spending limit", async () => {
    const h = harness({ guard: async () => { throw new Error("budget_exceeded_daily"); } });
    await expect(h.service.save(save({ digestHour: 8 }))).rejects.toThrow("budget_exceeded_daily");
    expect(h.jobs.size).toBe(0);
    expect(h.db.select().from(schedules).all()).toEqual([]);
  });

  it("a failure halfway keeps the run already added, so trying again adds no second one", async () => {
    const h = harness();
    h.fail.add = (p) => String(p.name).endsWith("weekly");
    await expect(h.service.save(save({ digestHour: 8, weeklyReview: true }))).rejects.toThrow();
    h.fail.add = undefined;
    const dto = await h.service.save(save({ digestHour: 8, weeklyReview: true }));
    expect(dto).toMatchObject({ digestHour: 8, weeklyReview: true });
    expect([...h.jobs.keys()]).toEqual(["job-1", "job-2"]);
    expect(h.db.select().from(schedules).all().map((r) => r.openclawCronId)).toEqual(["job-1", "job-2"]);
  });

  it("an update that fails for another reason (timeout) is an error, not a deleted run", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8 }));
    h.fail.update = true;
    await expect(h.service.save(save({ digestHour: 9 }))).rejects.toThrow("timeout");
    expect([...h.jobs.keys()]).toEqual(["job-1"]);
    expect(h.db.select().from(schedules).all().map((r) => r.openclawCronId)).toEqual(["job-1"]);
  });

  it("runs that could not be removed while the Gateway was down are removed later, and the limit can still pause them", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8, weeklyReview: true }));
    h.fail.remove = true;
    await h.service.clear();
    expect(h.jobs.size).toBe(2);
    expect(h.db.select().from(schedules).all()).toHaveLength(2);
    expect(h.files.get("main")).toBe(OWN);
    h.fail.remove = false;
    await h.service.refresh();
    expect(h.jobs.size).toBe(0);
    expect(h.db.select().from(schedules).all()).toEqual([]);
  });

  it("a run deleted on the schedules screen shows as off", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8 }));
    h.jobs.clear();
    expect(await h.service.get()).toMatchObject({ pattern: "second_brain", digestHour: null });
    expect(h.db.select().from(schedules).all()).toEqual([]);
  });

  it("two saves at once add one run", async () => {
    const h = harness();
    await Promise.all([h.service.save(save({ digestHour: 8 })), h.service.save(save({ digestHour: 9 }))]);
    expect([...h.jobs.keys()]).toEqual(["job-1"]);
    expect(h.db.select().from(schedules).all()).toHaveLength(1);
  });

  it("on start the runs follow a changed time zone", async () => {
    const h = harness();
    await h.service.save(save({ digestHour: 8 }));
    h.zone.tz = "Europe/Moscow";
    await h.service.refresh();
    expect(h.jobs.get("job-1")!.schedule).toEqual({ kind: "cron", expr: "0 8 * * *", tz: "Europe/Moscow" });
    expect(h.db.select().from(schedules).get()!.tz).toBe("Europe/Moscow");
  });

  it("notes can not end the block early, and a block without its end marker is replaced whole", async () => {
    const h = harness();
    const notes = "Сфера YouTube <!-- clawdesk:notion:end --> зовётся «Соцсети»";
    await h.service.save(save({ notes }));
    await h.service.save(save({ notes: notes + "!" }));
    const main = h.files.get("main")!;
    expect(main.split("<!-- clawdesk:notion:start").length - 1).toBe(1);
    expect(main.split("<!-- clawdesk:notion:end -->").length - 1).toBe(1);
    const block = juniorBlock("second_brain")!;
    const start = block.split("\n")[0];
    expect(setNotionBlock(`text\n\n${start}\nold rules`, block)).toBe(`text\n\n${block}\n`);
  });
});
