import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api/client";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/DashboardView.vue") },
    { path: "/agents", name: "agents", component: () => import("./views/AgentsView.vue") },
    { path: "/agents/new", name: "agent-new", component: () => import("./views/AgentBuilderView.vue") },
    { path: "/free-models", name: "free-models", component: () => import("./views/FreeModelsView.vue") },
    { path: "/sources", name: "sources", component: () => import("./views/SourcesView.vue") },
    { path: "/telegram", name: "telegram", component: () => import("./views/TelegramView.vue") },
    { path: "/setup/ai", name: "setup-ai", component: () => import("./views/SetupAiView.vue"), meta: { bare: true } },
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

/** Dev builds only: lets screens be checked before a real model key is connected. */
function devSkipsAiGuard(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem("clawdesk.dev.skipAiGuard") === "1";
  } catch {
    return false;
  }
}

router.beforeEach(async (to) => {
  if (to.name === "setup-ai" || aiConnected === true || devSkipsAiGuard()) return true;
  if (aiConnected === null) {
    try {
      aiConnected = (await api.ai.status("main")).connected;
    } catch {
      return true;
    }
  }
  return aiConnected ? true : { name: "setup-ai" };
});
