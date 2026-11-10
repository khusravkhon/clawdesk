// Personal mode keeps the daily sections in the menu and the rest under "Settings" (PersonalSettingsView).
// The pages listed here are reached from Settings, so their header leads back there (PageHeader).
export const PERSONAL_SETTINGS_GROUPS: { key: string; links: [path: string, labelKey: string][] }[] = [
  { key: "assistant", links: [["/agents", "nav.agents"], ["/schedules", "nav.schedules"], ["/free-models", "nav.freeModels"]] },
  { key: "connections", links: [["/sources", "nav.sources"], ["/skills", "nav.extensions"], ["/telegram", "personalSettings.telegram"]] },
  { key: "system", links: [["/usage", "nav.usage"], ["/status", "nav.status"], ["/system", "system.backups"]] },
];

export const PERSONAL_SETTINGS_PATHS = new Set(PERSONAL_SETTINGS_GROUPS.flatMap((group) => group.links.map(([path]) => path)));
