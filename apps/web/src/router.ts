import type { AuthStateDto } from "@clawdesk/shared";
import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api/client";
import { useSpaceStore } from "./stores/space";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/LandingView.vue") },
    { path: "/today", name: "today", component: () => import("./views/TodayView.vue"), meta: { aiOptional: true } },
    { path: "/assistant", name: "assistant", component: () => import("./views/AssistantView.vue") },
    { path: "/agents", name: "agents", component: () => import("./views/AgentsView.vue") },
    { path: "/agents/new", name: "agent-new", component: () => import("./views/AgentBuilderView.vue") },
    { path: "/agents/:agentId/edit", name: "agent-edit", component: () => import("./views/AgentEditView.vue") },
    { path: "/free-models", name: "free-models", component: () => import("./views/FreeModelsView.vue") },
    { path: "/chat/:agentId?", name: "chat", component: () => import("./views/ChatView.vue") },
    { path: "/schedules", name: "schedules", component: () => import("./views/SchedulesView.vue") },
    { path: "/approvals", name: "approvals", component: () => import("./views/ApprovalsView.vue") },
    { path: "/sources", name: "sources", component: () => import("./views/SourcesView.vue") },
    { path: "/skills", name: "skills", component: () => import("./views/SkillsView.vue") },
    { path: "/telegram", name: "telegram", component: () => import("./views/TelegramView.vue") },
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { bare: true, public: true } },
    { path: "/setup", name: "setup", component: () => import("./views/OwnerSetupView.vue"), meta: { bare: true, public: true } },
    { path: "/setup/mode", name: "setup-mode", component: () => import("./views/SetupModeView.vue"), meta: { bare: true } },
    { path: "/setup/ai", name: "setup-ai", component: () => import("./views/SetupAiView.vue"), meta: { bare: true } },
    { path: "/status", name: "status", component: () => import("./views/StatusView.vue"), meta: { aiOptional: true } },
    { path: "/usage", name: "usage", component: () => import("./views/UsageView.vue") },
    { path: "/teams", name: "teams", component: () => import("./views/TeamsView.vue") },
    { path: "/company", name: "company", component: () => import("./views/CompanyView.vue"), meta: { aiOptional: true } },
    { path: "/company/departments/:departmentId", name: "department", component: () => import("./views/CompanyView.vue"), meta: { aiOptional: true } },
    { path: "/company/activity", name: "company-activity", component: () => import("./views/ActivityView.vue"), meta: { aiOptional: true } },
    { path: "/company/office", name: "company-office", component: () => import("./views/OfficeView.vue"), meta: { aiOptional: true } },
    { path: "/company/work-items", name: "company-work-items", component: () => import("./views/WorkItemsView.vue"), meta: { aiOptional: true } },
    { path: "/company/access", name: "company-access", component: () => import("./views/AccessView.vue"), meta: { aiOptional: true } },
    { path: "/company/requests", name: "company-requests", component: () => import("./views/RequestsView.vue"), meta: { aiOptional: true } },
    { path: "/company/projects", name: "company-projects", component: () => import("./views/ProjectsView.vue"), meta: { aiOptional: true } },
    { path: "/company/projects/:projectId", name: "company-project", component: () => import("./views/ProjectsView.vue"), meta: { aiOptional: true } },
    { path: "/system", name: "system", component: () => import("./views/SystemView.vue"), meta: { aiOptional: true } },
  ],
});

// After a panel update an open tab asks for files of the old build; load the new one once.
router.onError((error, to) => {
  if (!/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(String(error))) return;
  const key = "clawdesk.reloadedFor";
  try {
    if (sessionStorage.getItem(key) === to.fullPath) return;
    sessionStorage.setItem(key, to.fullPath);
  } catch {
    // no storage: still try once
  }
  location.assign(to.fullPath);
});

// Sign-in comes first: without a session every page leads to the sign-in screen, and before the
// owner exists — to setting the password with the owner code. Checked until signed in.
let auth: AuthStateDto | null = null;

export function markSignedIn(): void {
  auth = { state: "ok", telegramReset: auth?.telegramReset ?? false };
}

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
  if (to.meta.public) return true;
  if (auth?.state !== "ok") {
    try {
      auth = await api.auth.state();
    } catch {
      return true; // panel server unreachable: the page shows the error
    }
    if (auth.state === "setup") return { name: "setup" };
    if (auth.state === "login") return { name: "login", query: { next: to.fullPath } };
  }
  // Screen 2 comes before connecting an AI: the mode decides the main agent's template.
  const space = useSpaceStore();
  if (!space.loaded) {
    try {
      await space.load();
    } catch {
      return true;
    }
  }
  if (!space.space && to.name !== "setup-mode" && !to.meta.aiOptional) return { name: "setup-mode" };
  if (to.name === "today" && space.mode === "company") return { name: "dashboard" };
  if (["company", "department", "company-projects", "company-project"].includes(String(to.name)) && space.mode !== "company") return { name: "dashboard" };
  if (to.name === "dashboard" && space.mode === "personal") return true;
  if (to.name === "setup-mode" || to.name === "setup-ai" || to.meta.aiOptional || aiConnected === true || devSkipsAiGuard()) return true;
  if (aiConnected === null) {
    try {
      aiConnected = (await api.ai.status("main")).connected;
    } catch {
      return true;
    }
  }
  return aiConnected ? true : { name: "setup-ai" };
});
