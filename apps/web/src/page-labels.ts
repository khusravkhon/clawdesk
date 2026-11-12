// Names of the panel's pages, for "back" links that lead to wherever the person came from.
// Keys are the same ones the menu uses (SidebarNav, personal-settings.ts).
const LABELS: Record<string, string> = {
  "/": "nav.overview",
  "/conveyor": "conveyor.title",
  "/today": "today.title",
  "/chat": "nav.chat",
  "/library": "nav.materials",
  "/assistant": "nav.assistant",
  "/approvals": "nav.approvals",
  "/settings": "personalSettings.title",
  "/agents": "nav.agents",
  "/free-models": "nav.freeModels",
  "/company": "company.title",
  "/teams": "nav.teams",
  "/schedules": "nav.schedules",
  "/sources": "nav.sources",
  "/skills": "nav.extensions",
  "/telegram": "personalSettings.telegram",
  "/usage": "nav.usage",
  "/status": "nav.status",
  "/system": "nav.system",
};

const COMPANY_PAGES: [path: string, labelKey: string][] = [
  ["/company/projects", "projects.title"],
  ["/company/work-items", "workItems.title"],
  ["/company/requests", "requests.title"],
  ["/company/activity", "activity.title"],
  ["/company/office", "office.title"],
  ["/company/documents", "documents.title"],
  ["/company/access", "access.title"],
  ["/company/capabilities", "capabilities.title"],
];

/** Every page the command palette can open in this mode, as [path, i18n key]. */
export function palettePages(mode: "personal" | "company"): [path: string, labelKey: string][] {
  const hidden = mode === "personal" ? ["/company", "/teams"] : ["/today", "/library", "/settings"];
  const pages = Object.entries(LABELS).filter(([path]) => !hidden.includes(path));
  return mode === "company" ? [...pages, ...COMPANY_PAGES] : pages;
}

/** The i18n key naming the page at `path`, or null when it has no short name. */
export function pageLabelKey(path: string): string | null {
  return LABELS[path] ?? (path.startsWith("/chat/") ? LABELS["/chat"] ?? null : null);
}

/** The in-app page the browser came from (vue-router keeps it in history.state.back), without query or hash. */
export function previousPagePath(): string | null {
  const back: unknown = window.history.state?.back;
  if (typeof back !== "string" || !back.startsWith("/")) return null;
  const path = back.split(/[?#]/)[0] || "/";
  // Sign-in and first setup are not places to go back to.
  return path === "/login" || path.startsWith("/setup") ? null : path;
}
