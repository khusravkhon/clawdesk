<script setup lang="ts">
// KPI tile: label, headline number, a short note under it. The number is the chart.
import type { Component } from "vue";

defineProps<{ label: string; value: string; note?: string; icon?: Component }>();
</script>

<template>
  <div class="tile">
    <div class="head">
      <component :is="icon" v-if="icon" :size="15" :stroke-width="1.75" class="icon" />
      <span>{{ label }}</span>
    </div>
    <div class="value">{{ value }}</div>
    <div v-if="note || $slots.note" class="note"><slot name="note">{{ note }}</slot></div>
  </div>
</template>

<style scoped>
.tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px 20px;
  min-width: 0;
  box-shadow: var(--card-shadow);
  transition:
    transform 0.25s var(--ease-out),
    box-shadow 0.25s ease;
}
.tile:hover {
  transform: translateY(-3px);
  box-shadow: var(--card-shadow-hover);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
}
.icon {
  color: var(--muted);
}
.value {
  margin-top: 10px;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 600px) {
  .tile {
    padding: 12px 14px;
  }
  .value {
    font-size: 22px;
    margin-top: 8px;
  }
}
</style>
