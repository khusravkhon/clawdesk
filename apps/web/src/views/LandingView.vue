<script setup lang="ts">
import { defineAsyncComponent } from "vue";
const Dashboard = defineAsyncComponent(() => import("./DashboardView.vue"));
</script>
<template><Dashboard /></template>
