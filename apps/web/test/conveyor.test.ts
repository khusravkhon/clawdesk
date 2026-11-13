import { describe, expect, it } from "vitest";
import { buildFlow, demoSources, layoutFlow, sizeOf } from "../src/conveyor";

const NOW = Date.UTC(2026, 10, 13, 12);
const text = { t: (key: string) => key, relative: (at: number) => String(at), date: (at: number) => String(at), personal: true };

describe("Conveyor map", () => {
  it("builds one centre and hangs every node on an existing owner", () => {
    const nodes = buildFlow(demoSources(NOW), text, NOW);
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
    expect(nodes.filter((n) => n.kind === "core")).toHaveLength(1);
    for (const n of nodes) if (n.kind !== "core") expect(ids.has(n.parent!)).toBe(true);
    // The demo is a personal install: no company tasks.
    for (const kind of ["agent", "material", "schedule", "reminder"]) expect(nodes.some((n) => n.kind === kind)).toBe(true);
  });

  it("works on an empty install", () => {
    const nodes = buildFlow({ agents: null, states: null, materials: null, moreMaterials: false, schedules: null, reminders: null, tasks: null }, text, NOW);
    expect(nodes.filter((n) => n.kind === "core")).toHaveLength(1);
    layoutFlow(nodes);
  });

  it("places cards without overlaps, the centre at 0,0, the same way every time", () => {
    const place = () => { const nodes = buildFlow(demoSources(NOW), text, NOW); layoutFlow(nodes); return nodes; };
    const nodes = place();
    const core = nodes.find((n) => n.kind === "core")!;
    expect([core.x, core.y]).toEqual([0, 0]);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!, sa = sizeOf(a.kind), sb = sizeOf(b.kind);
        const overlapX = (sa.w + sb.w) / 2 - Math.abs(a.x - b.x), overlapY = (sa.h + sb.h) / 2 - Math.abs(a.y - b.y);
        expect(overlapX <= 0.5 || overlapY <= 0.5, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
    expect(place().map((n) => [n.id, n.x, n.y])).toEqual(nodes.map((n) => [n.id, n.x, n.y]));
  });
});
