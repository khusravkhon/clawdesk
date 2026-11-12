// The Conveyor: everything the install holds, as one map. The assistant is the centre; agents stand around
// it; materials, schedules, reminders and tasks hang on whoever owns them. This file is the model only —
// building the nodes from the panel's data and placing them. No fetching and no DOM here.
import type { AgentListItemDto, DashboardAgentDto, LibraryHitDto, ReminderDto, ScheduleDto, WorkItemDto } from "@clawdesk/shared";
import type { RouteLocationRaw } from "vue-router";

export type FlowKind = "core" | "agent" | "material" | "schedule" | "reminder" | "task";
/** live: working right now; waiting: needs a look; off: paused. */
export type FlowState = "live" | "ok" | "waiting" | "error" | "off";

export type FlowNode = {
  id: string;
  kind: FlowKind;
  parent: string | null;
  title: string;
  emoji: string | null;
  /** One short line under the title. */
  meta: string;
  state: FlowState;
  /** Where "open" leads; null when this install has no page for it. */
  to: RouteLocationRaw | null;
  details: { label: string; value: string }[];
  x: number;
  y: number;
};

export type FlowSources = {
  agents: AgentListItemDto[] | null;
  /** Live state per agent, from the overview. */
  states: DashboardAgentDto[] | null;
  materials: LibraryHitDto[] | null;
  moreMaterials: boolean;
  schedules: ScheduleDto[] | null;
  reminders: ReminderDto[] | null;
  tasks: WorkItemDto[] | null;
};

export type FlowText = {
  t: (key: string, named?: Record<string, unknown>) => string;
  relative: (at: number) => string;
  date: (at: number) => string;
  /** Personal installs have the library page; company installs do not. */
  personal: boolean;
};

export const FLOW_KINDS: Exclude<FlowKind, "core">[] = ["agent", "material", "schedule", "reminder", "task"];
const MATERIALS = 10, REMINDERS = 8, TASKS = 12, SCHEDULES = 12;
const clip = (text: string, max = 46) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function buildFlow(src: FlowSources, text: FlowText, now = Date.now()): FlowNode[] {
  const { t } = text;
  const nodes: FlowNode[] = [];
  const add = (node: Omit<FlowNode, "x" | "y">) => nodes.push({ ...node, x: 0, y: 0 });
  const agents = src.agents ?? [];
  const main = agents.find((a) => a.role === "main") ?? agents.find((a) => a.isDefault) ?? null;
  const stateOf = (id: string) => src.states?.find((s) => s.id === id) ?? null;
  const flowState = (id: string): FlowState => {
    const s = stateOf(id)?.state;
    return s === "working" ? "live" : s === "failed" ? "error" : "ok";
  };
  const agentDetails = (a: AgentListItemDto) => {
    const s = stateOf(a.id);
    return [
      { label: t("conveyor.fields.model"), value: a.model ?? t("agents.noModel") },
      ...(a.purpose ? [{ label: t("conveyor.fields.purpose"), value: a.purpose }] : []),
      ...(s?.lastActivityAt ? [{ label: t("conveyor.fields.lastActivity"), value: text.relative(s.lastActivityAt) }] : []),
      ...(s?.lastError ? [{ label: t("conveyor.fields.error"), value: s.lastError }] : []),
    ];
  };

  add({
    id: "core", kind: "core", parent: null,
    title: main && main.name !== main.id ? main.name : t("agents.main"),
    emoji: main?.emoji ?? null,
    meta: main?.model ?? "",
    state: main ? flowState(main.id) : "ok",
    to: main ? `/chat/${main.id}` : "/chat",
    details: main ? agentDetails(main) : [],
  });

  const agentNode = new Map<string, string>();
  if (main) agentNode.set(main.id, "core");
  for (const a of agents) {
    if (a === main) continue;
    agentNode.set(a.id, `agent:${a.id}`);
    add({
      id: `agent:${a.id}`, kind: "agent", parent: "core", title: a.name, emoji: a.emoji,
      meta: a.model ?? t("agents.noModel"), state: flowState(a.id), to: `/chat/${a.id}`, details: agentDetails(a),
    });
  }
  const owner = (agentId: string | null | undefined) => (agentId && agentNode.get(agentId)) || "core";
  const ownerName = (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId;

  for (const m of (src.materials ?? []).slice(0, MATERIALS)) {
    add({
      id: `material:${m.id}`, kind: "material", parent: owner(m.agentId), title: clip(m.title), emoji: m.kind === "video" ? "🎬" : "📄",
      meta: `${t(`library.kind.${m.kind}`)} · ${text.relative(m.at)}`, state: "ok",
      to: text.personal ? { name: "library", query: { material: m.id } } : null,
      details: [
        { label: t("conveyor.fields.owner"), value: ownerName(m.agentId) },
        { label: t("conveyor.fields.source"), value: m.source },
        { label: t("conveyor.fields.saved"), value: text.date(m.at) },
        { label: t("conveyor.fields.size"), value: t("conveyor.fields.chars", { n: m.chars.toLocaleString() }) },
      ],
    });
  }
  if (src.moreMaterials && text.personal) {
    add({ id: "material:more", kind: "material", parent: "core", title: t("conveyor.more"), emoji: "🗂️", meta: t("conveyor.moreMeta"), state: "ok", to: "/library", details: [] });
  }

  const schedules = [...(src.schedules ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  for (const s of schedules.slice(0, SCHEDULES)) {
    const soon = s.enabled && s.nextRunAt !== null && s.nextRunAt - now < 3_600_000;
    add({
      id: `schedule:${s.id}`, kind: "schedule", parent: owner(s.agentId), title: clip(s.label), emoji: "⏰",
      meta: !s.enabled ? t("conveyor.paused") : s.nextRunAt ? text.relative(s.nextRunAt) : "—",
      state: !s.enabled ? "off" : s.lastStatus === "error" ? "error" : soon ? "live" : "ok",
      to: "/schedules",
      details: [
        { label: t("conveyor.fields.owner"), value: ownerName(s.agentId) },
        { label: t("conveyor.fields.prompt"), value: clip(s.prompt, 220) },
        ...(s.nextRunAt ? [{ label: t("conveyor.fields.next"), value: text.date(s.nextRunAt) }] : []),
        ...(s.lastRunAt ? [{ label: t("conveyor.fields.last"), value: text.date(s.lastRunAt) }] : []),
        ...(s.lastError ? [{ label: t("conveyor.fields.error"), value: s.lastError }] : []),
      ],
    });
  }

  // Open reminders; of a repeating one only the latest occurrence, as on the Today page.
  const latest = new Map<string, number>();
  for (const r of src.reminders ?? []) if (r.seriesId) latest.set(r.seriesId, Math.max(latest.get(r.seriesId) ?? 0, r.dueAt));
  const reminders = (src.reminders ?? [])
    .filter((r) => r.action === "open" && (!r.seriesId || r.dueAt === latest.get(r.seriesId)))
    .sort((a, b) => a.dueAt - b.dueAt);
  for (const r of reminders.slice(0, REMINDERS)) {
    add({
      id: `reminder:${r.id}`, kind: "reminder", parent: "core", title: clip(r.text), emoji: "🔔",
      meta: text.relative(r.dueAt), state: r.dueAt <= now ? "waiting" : "ok", to: "/today",
      details: [{ label: t("conveyor.fields.due"), value: text.date(r.dueAt) }, { label: t("conveyor.fields.text"), value: clip(r.text, 300) }],
    });
  }

  const tasks = (src.tasks ?? []).filter((w) => w.status !== "done" && w.status !== "cancelled").sort((a, b) => b.updatedAt - a.updatedAt);
  for (const w of tasks.slice(0, TASKS)) {
    add({
      id: `task:${w.id}`, kind: "task", parent: owner(w.executor.agentId), title: clip(`${w.code} · ${w.title}`), emoji: "✅",
      meta: t(`workItems.status.${w.status}`),
      state: w.status === "running" ? "live" : w.status === "failed" ? "error" : w.status === "blocked" || w.status === "review" || w.overdue ? "waiting" : "ok",
      to: "/company/work-items",
      details: [
        { label: t("conveyor.fields.executor"), value: w.executor.name },
        { label: t("conveyor.fields.status"), value: t(`workItems.status.${w.status}`) },
        ...(w.block ? [{ label: t("conveyor.fields.waits"), value: w.block.text }] : []),
        { label: t("conveyor.fields.updated"), value: text.relative(w.updatedAt) },
      ],
    });
  }
  return nodes;
}

/** Card size on the map, for placing and for fitting the view. */
export function sizeOf(kind: FlowKind): { w: number; h: number } {
  return kind === "core" ? { w: 210, h: 220 } : kind === "agent" ? { w: 196, h: 60 } : { w: 188, h: 54 };
}

/**
 * Places the nodes: the centre at 0,0, its children on a ring, their items on an outer ring within the
 * owner's sector; then overlapping cards push each other apart. The same nodes always get the same places.
 */
export function layoutFlow(nodes: FlowNode[]): void {
  const core = nodes.find((n) => n.kind === "core");
  if (!core) return;
  core.x = 0; core.y = 0;
  const kids = new Map<string, FlowNode[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  // Agents are spread evenly between the centre's own things, so the map does not lean to one side.
  const own = kids.get(core.id) ?? [];
  const agents = own.filter((n) => n.kind === "agent"), loose = own.filter((n) => n.kind !== "agent");
  const first: FlowNode[] = [];
  for (let i = 0, a = 0, l = 0; i < own.length; i++) {
    const agentTurn = Math.floor(((i + 1) * agents.length) / own.length) > Math.floor((i * agents.length) / own.length);
    first.push(agentTurn ? agents[a++]! : loose[l++]!);
  }
  const weight = (n: FlowNode) => Math.max(1, kids.get(n.id)?.length ?? 0) + (n.kind === "agent" ? 0.6 : 0);
  const total = first.reduce((sum, n) => sum + weight(n), 0) || 1;
  const STRETCH = 1.45; // screens are wide: the rings are ellipses
  let angle = -Math.PI / 2;
  for (const n of first) {
    const span = (2 * Math.PI * weight(n)) / total;
    const mid = angle + span / 2;
    const inner = n.kind === "agent" ? 215 : 265;
    n.x = Math.cos(mid) * inner * STRETCH; n.y = Math.sin(mid) * inner;
    const items = kids.get(n.id) ?? [];
    items.forEach((item, i) => {
      const a = angle + (span * (i + 0.5)) / items.length;
      const outer = 370 + (i % 2) * 64;
      item.x = Math.cos(a) * outer * STRETCH; item.y = Math.sin(a) * outer;
    });
    angle += span;
  }
  // Push overlapping cards apart along the axis where they overlap less; the centre never moves.
  const GAP = 18;
  for (let pass = 0; pass < 400; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!;
        const sa = sizeOf(a.kind), sb = sizeOf(b.kind);
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (sa.w + sb.w) / 2 + GAP - Math.abs(dx), oy = (sa.h + sb.h) / 2 + GAP - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const fa = a.kind === "core" ? 0 : b.kind === "core" ? 1 : 0.5, fb = 1 - fa;
        if (ox < oy) { const dir = dx >= 0 ? 1 : -1; a.x -= dir * ox * fa; b.x += dir * ox * fb; }
        else { const dir = dy >= 0 ? 1 : -1; a.y -= dir * oy * fa; b.y += dir * oy * fb; }
      }
    }
    if (!moved) break;
  }
}

/** Sample data for the demo switch: shows what the map looks like on a busy install. Never real data. */
export function demoSources(now = Date.now()): FlowSources {
  const agent = (id: string, name: string, emoji: string, model: string, purpose: string, role: "main" | "specialist" = "specialist"): AgentListItemDto => ({
    id, name, emoji, model, isDefault: role === "main", role, parentId: role === "main" ? null : "main", status: "ready", purpose, canAskMain: true, sandbox: true, folder: null,
  });
  const state = (id: string, s: "working" | "idle" | "failed", ago: number): DashboardAgentDto => ({ id, name: id, emoji: null, role: null, model: null, state: s, sessions: 1, lastActivityAt: now - ago, lastError: s === "failed" ? "rate limited" : null, tokens: 0 });
  const material = (id: string, agentId: string, title: string, kind: "document" | "video", ago: number): LibraryHitDto => ({ id, agentId, kind, title, source: kind === "video" ? "https://youtu.be/demo" : `${title}.pdf`, locator: null, chars: 18_400, at: now - ago, snippets: [] });
  const schedule = (id: string, agentId: string, label: string, inMs: number, enabled = true, lastStatus: "ok" | "error" | null = "ok"): ScheduleDto => ({
    id, agentId, label, prompt: label, cron: "0 8 * * *", everyMs: null, tz: "UTC", enabled, nextRunAt: enabled ? now + inMs : null, lastRunAt: now - 86_400_000, lastStatus, lastError: lastStatus === "error" ? "model timeout" : null, deliversToTelegram: true,
  });
  const reminder = (id: string, text: string, inMs: number): ReminderDto => ({ id, requestId: id, text, dueAt: now + inMs, timeZone: "UTC", delivery: "pending", action: "open", sentAt: null, messageId: null, parentId: null, reason: null });
  const H = 3_600_000, D = 24 * H;
  return {
    agents: [
      agent("main", "Клав", "🧭", "claude-opus-5-5", "Главный ассистент", "main"),
      agent("dietitian", "Диетолог", "🥗", "deepseek-chat", "Меню на день и список покупок"),
      agent("trainer", "Тренер", "🏋️", "qwen-plus", "Тренировка дня и дневник нагрузок"),
      agent("finance", "Финансы", "💰", "glm-4.6", "Учёт трат и итог недели"),
      agent("youtube", "YouTube", "🎬", "kimi-k2", "Идеи и сценарии роликов"),
    ],
    states: [state("main", "working", 20_000), state("dietitian", "idle", 2 * H), state("trainer", "working", 60_000), state("finance", "failed", 5 * H), state("youtube", "idle", D)],
    materials: [
      material("m1", "main", "Договор аренды", "document", 2 * H),
      material("m2", "main", "План на квартал", "document", D),
      material("m3", "dietitian", "Анализы за октябрь", "document", 3 * D),
      material("m4", "youtube", "Разбор: как снимать интервью", "video", 5 * H),
      material("m5", "youtube", "Конкуренты: 5 каналов", "video", 2 * D),
      material("m6", "finance", "Выписка за октябрь", "document", 4 * D),
      material("m7", "trainer", "Программа на 8 недель", "document", 6 * D),
    ],
    moreMaterials: true,
    schedules: [
      schedule("s1", "main", "План на день", 20 * 60_000),
      schedule("s2", "dietitian", "Меню и покупки", 9 * H),
      schedule("s3", "trainer", "Тренировка дня", 8 * H),
      schedule("s4", "finance", "Итог недели", 3 * D, true, "error"),
      schedule("s5", "youtube", "Идеи на неделю", 0, false),
    ],
    reminders: [reminder("r1", "Позвонить в банк", -30 * 60_000), reminder("r2", "Оплатить интернет", 5 * H), reminder("r3", "Записаться к врачу", 2 * D)],
    tasks: null,
  };
}
