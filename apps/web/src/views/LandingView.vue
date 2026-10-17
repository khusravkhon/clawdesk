<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { useSpaceStore } from "../stores/space";
const space = useSpaceStore();
const Today = defineAsyncComponent(() => import("./TodayView.vue"));
const Dashboard = defineAsyncComponent(() => import("./DashboardView.vue"));
</script>
<template><component :is="space.mode === 'personal' ? Today : Dashboard" /></template>
