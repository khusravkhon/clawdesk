// The panel's "what changed" stream: one event names the areas to reload, never their data.
// Screens reload those areas at once instead of waiting for their next timer; a slow timer stays as a
// safety net for changes the panel cannot see (a reminder delivered, a request filed through Telegram).
export const CHANGE_TOPICS = ["agents", "schedules", "reminders", "library", "requests", "workItems", "teams", "projects"] as const;
export type ChangeTopic = (typeof CHANGE_TOPICS)[number];

export type ChangeEventDto = { topics: ChangeTopic[] };
