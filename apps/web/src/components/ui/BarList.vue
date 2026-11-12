<script setup lang="ts">
// Ranked horizontal bars (one series, one color): label left, value right, bar under.
// Plain HTML so labels never collide and screen readers get a list.
import { computed } from "vue";

export type BarItem = { key: string; label: string; sublabel?: string; value: number; display: string; title?: string };

const props = defineProps<{ items: BarItem[]; max?: number }>();
const top = computed(() => Math.max(props.max ?? 0, ...props.items.map((i) => i.value), 0));
const width = (v: number) => (top.value > 0 ? `${Math.max((v / top.value) * 100, v > 0 ? 2 : 0)}%` : "0%");
</script>

<template>
  <ul class="bars">
    <li v-for="item in items" :key="item.key" :title="item.title ?? `${item.label}: ${item.display}`">
      <div class="row">
        <span class="label">
          {{ item.label }}<span v-if="item.sublabel" class="sub">{{ item.sublabel }}</span>
        </span>
        <span class="value num">{{ item.display }}</span>
      </div>
      <div class="track"><div class="fill" :style="{ width: width(item.value) }" /></div>
    </li>
  </ul>
</template>

<style scoped>
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
li {
  border-radius: 6px;
}
li:hover .fill {
  filter: brightness(1.15);
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 6px;
}
.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  color: var(--muted);
  margin-left: 6px;
}
.value {
  color: var(--text-2);
  flex: none;
}
.track {
  height: 6px;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent-gradient);
  transition: width 0.4s ease;
}
</style>
