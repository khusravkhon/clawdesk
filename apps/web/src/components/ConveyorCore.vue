<script setup lang="ts">
// The centre of the Conveyor: a slowly turning globe of dots, drawn in code. It turns faster while the
// assistant is working. The loop stops when the tab is hidden; with motion off the globe is drawn once.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { themeMode } from "../theme";

const props = defineProps<{ live: boolean; size?: number }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const SIZE = props.size ?? 150;
const DOTS = 260;
// Evenly spread points on a sphere (golden-angle spiral).
const points = Array.from({ length: DOTS }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / DOTS;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r };
});
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
let raf = 0, turn = 0, speed = 0.004;

function draw(): void {
  const el = canvas.value;
  const ctx = el?.getContext("2d");
  if (!el || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  if (el.width !== SIZE * dpr) { el.width = SIZE * dpr; el.height = SIZE * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);
  const dark = themeMode.value === "dark";
  const R = SIZE * 0.42, c = SIZE / 2, tilt = 0.35;
  const cosT = Math.cos(turn), sinT = Math.sin(turn), cosX = Math.cos(tilt), sinX = Math.sin(tilt);
  for (const p of points) {
    const x = p.x * cosT + p.z * sinT, z0 = p.z * cosT - p.x * sinT;
    const y = p.y * cosX - z0 * sinX, z = p.y * sinX + z0 * cosX;
    const depth = (z + 1) / 2; // 0 far … 1 near
    // Lime at the top of the globe, green at the bottom; far dots fade.
    const mix = (y + 1) / 2;
    const [top, bottom] = dark ? [[200, 245, 66], [52, 208, 88]] : [[132, 204, 22], [21, 128, 61]];
    const rgb = top!.map((value, i) => Math.round(value + (bottom![i]! - value) * mix));
    ctx.fillStyle = `rgba(${rgb.join(", ")}, ${0.18 + depth * 0.82})`;
    ctx.beginPath();
    ctx.arc(c + x * R, c + y * R, 0.7 + depth * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function loop(): void {
  raf = 0;
  if (document.hidden) return;
  // Ease towards the target speed, so the change of pace is felt, not jumped.
  speed += ((props.live ? 0.016 : 0.004) - speed) * 0.04;
  turn += speed;
  draw();
  if (!reduced) raf = requestAnimationFrame(loop);
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

watch(themeMode, kick);
onMounted(() => { document.addEventListener("visibilitychange", kick); kick(); });
onBeforeUnmount(() => { document.removeEventListener("visibilitychange", kick); if (raf) cancelAnimationFrame(raf); });
</script>

<template>
  <canvas ref="canvas" class="globe" :style="{ width: `${SIZE}px`, height: `${SIZE}px` }" aria-hidden="true" />
</template>

<style scoped>
.globe {
  display: block;
  pointer-events: none;
}
</style>
