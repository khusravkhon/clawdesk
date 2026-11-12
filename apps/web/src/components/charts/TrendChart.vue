<script setup lang="ts">
// One measure over days: 2px line, faint area, crosshair tooltip. One axis, one series.
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { graphic, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { computed } from "vue";
import VChart from "vue-echarts";
import { colors } from "../../theme";

use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

const props = defineProps<{
  labels: string[];
  values: number[];
  /** Series name shown in the tooltip. */
  name: string;
  format: (v: number) => string;
  height?: number;
  /** Sparkline in a table row: no axes or grid, the tooltip still names the day and the value. */
  compact?: boolean;
}>();

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const option = computed(() => {
  const c = colors.value;
  return {
    animationDuration: 400,
    grid: props.compact ? { left: 2, right: 2, top: 4, bottom: 4, containLabel: false } : { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: c.surfaceSolid,
      borderColor: c.border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: c.text, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: c.axis, width: 1 } },
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        return `<div style="color:${c.text2};margin-bottom:4px">${escape(props.labels[i] ?? "")}</div>
          <div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:${c.accent}"></span>
          ${escape(props.name)} <b style="margin-left:auto;padding-left:12px">${escape(props.format(props.values[i] ?? 0))}</b></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: props.labels,
      boundaryGap: false,
      axisLine: { show: !props.compact, lineStyle: { color: c.axis } },
      axisTick: { show: false },
      axisLabel: { show: !props.compact, color: c.muted, fontSize: 11, hideOverlap: true, margin: 10 },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      splitNumber: 4,
      axisLabel: { show: !props.compact, color: c.muted, fontSize: 11, formatter: (v: number) => props.format(v) },
      splitLine: { show: !props.compact, lineStyle: { color: c.grid, width: 1 } },
    },
    series: [
      {
        type: "line",
        name: props.name,
        data: props.values,
        smooth: 0.25,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2, color: c.accent },
        itemStyle: { color: c.accent, borderColor: c.surfaceSolid, borderWidth: 2 },
        emphasis: { focus: "none" },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `${c.accent}40` },
            { offset: 1, color: `${c.accent}00` },
          ]),
        },
      },
    ],
  };
});
</script>

<template>
  <v-chart class="chart" :option="option" autoresize :style="{ height: `${height ?? 240}px` }" />
</template>

<style scoped>
.chart {
  width: 100%;
}
</style>
