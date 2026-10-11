import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api/client";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/status" },
    { path: "/setup/ai", name: "setup-ai", component: () => import("./views/SetupAiView.vue") },
    { path: "/status", name: "status", component: () => import("./views/StatusView.vue") },
  ],
});

// First run: until the main agent has an AI connected, every page leads to the
// "connect AI" window. Checked once per page load; unreachable Gateway lets the
// status page explain the problem instead.
let aiConnected: boolean | null = null;

export function markAiConnected(): void {
  aiConnected = true;
}

router.beforeEach(async (to) => {
  if (to.name === "setup-ai" || aiConnected === true) return true;
  if (aiConnected === null) {
    try {
      aiConnected = (await api.ai.status("main")).connected;
    } catch {
      return true;
    }
  }
  return aiConnected ? true : { name: "setup-ai" };
});
