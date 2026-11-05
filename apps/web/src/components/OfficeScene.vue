<script setup lang="ts">
// Stages 10–11: the pixel office, drawn in code (original art: rectangles on a 2D canvas, no images, no
// WebGL). Each agent is one character with a desk; a working agent walks to its desk, an idle one to the
// lounge. The label above it is the confirmed state; the exact action only when its run reported the tool.
// The loop runs only while something moves and the tab is visible; with motion off, characters jump.
import type { AgentActivityDto, AgentActivityState } from "@clawdesk/shared";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ agents: AgentActivityDto[]; selected: string | null; motion: boolean; zoom: number; labels: Record<string, string> }>();
const emit = defineEmits<{ select: [agentId: string]; failed: [] }>();

const W = 320, H = 200, TILE = 8;
const canvas = ref<HTMLCanvasElement | null>(null);
type Actor = { id: string; x: number; y: number; tx: number; ty: number; phase: number };
const actors = new Map<string, Actor>();
let frame = 0, raf = 0, hidden = false, pan = { x: 0, y: 0 }, drag: { x: number; y: number; px: number; py: number } | null = null;

// Desks: a 5 × 6 grid in the work area (left, up to 30 places), the lounge on the right.
const DESK_COLS = 5;

const desk = (index: number) => ({ x: 10 + (index % DESK_COLS) * 41, y: 30 + Math.floor(index / DESK_COLS) * 28 });
const lounge = (index: number) => ({ x: 232 + (index % 3) * 22, y: 110 + Math.floor(index / 3) * 18 });
const AT_DESK: AgentActivityState[] = ["working", "error", "blocked", "waiting_for_agent", "waiting_for_owner"];

function hue(id: string): number { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function color(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }

function targets(): void {
  let lounged = 0;
  props.agents.forEach((agent, index) => {
    const spot = AT_DESK.includes(agent.state) ? { x: desk(index).x + 14, y: desk(index).y + 16 } : agent.state === "offline" || agent.state === "unknown" ? { x: desk(index).x + 14, y: desk(index).y + 16 } : lounge(lounged++);
    const actor = actors.get(agent.agentId) ?? { id: agent.agentId, x: spot.x, y: spot.y, tx: spot.x, ty: spot.y, phase: hue(agent.agentId) % 7 };
    actor.tx = spot.x; actor.ty = spot.y;
    if (!props.motion) { actor.x = spot.x; actor.y = spot.y; }
    actors.set(agent.agentId, actor);
  });
  for (const id of [...actors.keys()]) if (!props.agents.some((agent) => agent.agentId === id)) actors.delete(id);
}

function room(ctx: CanvasRenderingContext2D): void {
  // Floor and walls.
  ctx.fillStyle = "#d9cdb8"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#cdc0a9"; for (let x = 0; x < W; x += TILE * 2) for (let y = 16; y < H; y += TILE * 2) ctx.fillRect(x + ((y / 16) % 2) * TILE, y, TILE, TILE);
  ctx.fillStyle = "#6f7c8f"; ctx.fillRect(0, 0, W, 14);
  // Windows on the top wall.
  ctx.fillStyle = "#a9d3f0"; for (let x = 20; x < W - 20; x += 60) ctx.fillRect(x, 3, 30, 8);
  // Lounge rug, sofa and table.
  ctx.fillStyle = "#b7c9a8"; ctx.fillRect(220, 96, 92, 96);
  ctx.fillStyle = "#7d5ba6"; ctx.fillRect(226, 98, 80, 10); ctx.fillRect(226, 98, 8, 30);
  ctx.fillStyle = "#8a6a4f"; ctx.fillRect(250, 132, 30, 14);
  // Plants and a shelf.
  for (const [x, y] of [[4, 18], [306, 18], [206, 180]] as const) { ctx.fillStyle = "#8a5a3c"; ctx.fillRect(x + 2, y + 8, 6, 6); ctx.fillStyle = "#3f8f4f"; ctx.fillRect(x, y, 10, 9); }
  ctx.fillStyle = "#7a5b40"; ctx.fillRect(226, 20, 80, 10);
  ctx.fillStyle = "#c95c5c"; ctx.fillRect(230, 22, 6, 6); ctx.fillStyle = "#5c8bc9"; ctx.fillRect(240, 22, 6, 6); ctx.fillStyle = "#d9b44a"; ctx.fillRect(250, 22, 6, 6);
  // Desks, monitors and chairs, one per agent (at least eight places).
  const desks = Math.max(8, props.agents.length);
  for (let index = 0; index < desks; index++) {
    const { x, y } = desk(index);
    ctx.fillStyle = "#9a7652"; ctx.fillRect(x, y, 30, 12);
    ctx.fillStyle = "#2f3542"; ctx.fillRect(x + 9, y - 6, 12, 8);
    ctx.fillStyle = props.agents[index]?.state === "working" ? "#7fd1ff" : "#55606e"; ctx.fillRect(x + 10, y - 5, 10, 5);
    ctx.fillStyle = "#4a4f5c"; ctx.fillRect(x + 11, y + 14, 8, 8);
  }
}

function person(ctx: CanvasRenderingContext2D, agent: AgentActivityDto, actor: Actor, t: number): void {
  const x = Math.round(actor.x), y = Math.round(actor.y);
  const walking = props.motion && (Math.abs(actor.tx - actor.x) > 0.5 || Math.abs(actor.ty - actor.y) > 0.5);
  const step = walking ? Math.floor((t / 6 + actor.phase) % 2) : 0;
  const dim = agent.state === "offline" || agent.state === "unknown";
  ctx.globalAlpha = dim ? 0.45 : 1;
  ctx.fillStyle = `hsl(${hue(agent.agentId)} 55% 45%)`; ctx.fillRect(x - 4, y - 8, 8, 8);
  ctx.fillStyle = "#f1c9a5"; ctx.fillRect(x - 3, y - 14, 6, 6);
  ctx.fillStyle = `hsl(${(hue(agent.agentId) + 160) % 360} 35% 25%)`; ctx.fillRect(x - 3, y - 15, 6, 2);
  ctx.fillStyle = "#3b3b4a"; ctx.fillRect(x - 3, y, 2, 3 - step); ctx.fillRect(x + 1, y, 2, 2 + step);
  ctx.globalAlpha = 1;
  if (props.selected === agent.agentId) { ctx.strokeStyle = "#ffd84a"; ctx.lineWidth = 1; ctx.strokeRect(x - 6.5, y - 16.5, 13, 21); }
  // State marks: a colour is never the only sign — each has a shape too.
  const mark = (fill: string, glyph: string) => { ctx.fillStyle = fill; ctx.fillRect(x + 4, y - 20, 7, 7); ctx.fillStyle = "#fff"; ctx.font = "6px monospace"; ctx.fillText(glyph, x + 5.5, y - 14.6); };
  if (agent.state === "waiting_for_owner") mark("#d98a1f", "?");
  else if (agent.state === "waiting_for_agent") mark("#d9b44a", "…");
  else if (agent.state === "blocked") mark("#b5651d", "!");
  else if (agent.state === "error") mark("#c0392b", "×");
  else if (agent.state === "offline" || agent.state === "unknown") mark("#6b7280", "–");
  if (agent.runs > 1) { ctx.fillStyle = "#1f6feb"; ctx.fillRect(x - 11, y - 20, 7, 7); ctx.fillStyle = "#fff"; ctx.font = "6px monospace"; ctx.fillText(String(Math.min(agent.runs, 9)), x - 9.5, y - 14.6); }
}

function label(ctx: CanvasRenderingContext2D, agent: AgentActivityDto, actor: Actor): void {
  const text = props.labels[agent.agentId] ?? "";
  if (!text) return;
  ctx.font = "5px sans-serif";
  const width = Math.min(70, ctx.measureText(text).width + 4);
  const x = Math.round(actor.x - width / 2), y = Math.round(actor.y) - 27;
  ctx.fillStyle = "rgba(20, 24, 33, 0.85)"; ctx.fillRect(x, y, width, 7);
  ctx.fillStyle = "#fff"; ctx.fillText(text.length > 26 ? `${text.slice(0, 25)}…` : text, x + 2, y + 5.3);
}

function lines(ctx: CanvasRenderingContext2D): void {
  // A request filed by one agent to another one in the scene: a dashed line between them.
  ctx.setLineDash([2, 2]); ctx.strokeStyle = "rgba(217, 138, 31, 0.9)"; ctx.lineWidth = 1;
  for (const agent of props.agents) {
    if (agent.state !== "waiting_for_agent" || !agent.request) continue;
    const target = props.agents.find((other) => other.name === agent.request!.addressee && other.agentId !== agent.agentId);
    const from = actors.get(agent.agentId), to = target ? actors.get(target.agentId) : undefined;
    if (!from || !to) continue;
    ctx.beginPath(); ctx.moveTo(from.x, from.y - 10); ctx.lineTo(to.x, to.y - 10); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function draw(): boolean {
  const el = canvas.value;
  const ctx = el?.getContext("2d");
  if (!el || !ctx) return false;
  const scale = props.zoom * (window.devicePixelRatio || 1);
  if (el.width !== Math.round(W * scale) || el.height !== Math.round(H * scale)) { el.width = Math.round(W * scale); el.height = Math.round(H * scale); }
  ctx.setTransform(scale, 0, 0, scale, pan.x * scale, pan.y * scale);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = color("--surface") || "#111"; ctx.fillRect(-W, -H, W * 3, H * 3);
  room(ctx);
  let moving = false;
  for (const agent of props.agents) {
    const actor = actors.get(agent.agentId);
    if (!actor) continue;
    if (props.motion) {
      const dx = actor.tx - actor.x, dy = actor.ty - actor.y, distance = Math.hypot(dx, dy);
      if (distance > 0.5) { const speed = Math.min(1.2, distance); actor.x += (dx / distance) * speed; actor.y += (dy / distance) * speed; moving = true; }
      else { actor.x = actor.tx; actor.y = actor.ty; }
    }
  }
  lines(ctx);
  for (const agent of [...props.agents].sort((a, b) => (actors.get(a.agentId)?.y ?? 0) - (actors.get(b.agentId)?.y ?? 0))) { const actor = actors.get(agent.agentId); if (actor) person(ctx, agent, actor, frame); }
  for (const agent of props.agents) { const actor = actors.get(agent.agentId); if (actor) label(ctx, agent, actor); }
  return moving || props.agents.some((agent) => agent.state === "working");
}

function loop(): void {
  raf = 0;
  if (hidden) return;
  frame++;
  let again = false;
  try { again = draw(); }
  catch { emit("failed"); return; }
  // Only while something moves (walking, or a working agent's monitor); otherwise redraw on changes only.
  if (again && props.motion) raf = requestAnimationFrame(loop);
}
const kick = () => { if (!raf && !hidden) raf = requestAnimationFrame(loop); };
const visibility = () => { hidden = document.visibilityState === "hidden"; if (hidden && raf) { cancelAnimationFrame(raf); raf = 0; } else kick(); };

function point(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * W - pan.x, y: ((event.clientY - rect.top) / rect.height) * H - pan.y };
}
function down(event: PointerEvent): void { drag = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }; }
function move(event: PointerEvent): void {
  if (!drag || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  pan = { x: drag.px + ((event.clientX - drag.x) / rect.width) * W, y: drag.py + ((event.clientY - drag.y) / rect.height) * H };
  kick();
}
function up(event: PointerEvent): void {
  const moved = drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4;
  drag = null;
  if (moved) return;
  const p = point(event);
  let best: { id: string; d: number } | null = null;
  for (const actor of actors.values()) { const d = Math.hypot(actor.x - p.x, actor.y - 6 - p.y); if (d < 12 && (!best || d < best.d)) best = { id: actor.id, d }; }
  if (best) emit("select", best.id);
}

watch(() => [props.agents, props.motion], () => { targets(); kick(); }, { deep: true });
watch(() => [props.selected, props.zoom, props.labels], () => kick(), { deep: true });
onMounted(() => {
  if (!canvas.value?.getContext("2d")) { emit("failed"); return; }
  document.addEventListener("visibilitychange", visibility);
  targets(); kick();
});
onBeforeUnmount(() => { document.removeEventListener("visibilitychange", visibility); if (raf) cancelAnimationFrame(raf); });
defineExpose({ resetPan: () => { pan = { x: 0, y: 0 }; kick(); } });
</script>

<template>
  <canvas ref="canvas" class="scene" :style="{ aspectRatio: `${W} / ${H}`, maxWidth: `${W * zoom * 2}px` }" aria-hidden="true" @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="drag = null" />
</template>

<style scoped>
.scene { width: 100%; image-rendering: pixelated; border-radius: 8px; cursor: grab; touch-action: none; display: block; }
</style>
