import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Panel metadata only. OpenClaw config is the source of truth for how agents
// run; rows here are joined to it by agentId. Secrets (model keys, OAuth
// tokens, bot tokens) never live in this database — only their status.

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

/** One row: a self-hosted install is one Space (one person or one trusting team). */
export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["personal", "company"] }).notNull(),
  name: text("name").notNull(),
  locale: text("locale", { enum: ["ru", "en", "tg"] }).notNull().default("ru"),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
});

export const panelUsers = sqliteTable(
  "panel_users",
  {
    id: text("id").primaryKey(),
    /** The owner signs in with a password only; email is for team members later. */
    email: text("email"),
    passwordHash: text("password_hash"),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("panel_users_email_uq").on(t.email)],
);

/** Signed-in browsers. `id` is the SHA-256 of the cookie token; the token itself is never stored. */
export const panelSessions = sqliteTable(
  "panel_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => panelUsers.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("panel_sessions_user_idx").on(t.userId)],
);

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  telegramGroupId: text("telegram_group_id"),
  createdAt: createdAt(),
});

export const agents = sqliteTable(
  "agents",
  {
    /** Same as the OpenClaw agentId (slug). */
    id: text("id").primaryKey(),
    role: text("role", { enum: ["main", "specialist", "team_member"] }).notNull(),
    parentId: text("parent_id"),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    templateId: text("template_id"),
    displayName: text("display_name").notNull(),
    avatar: text("avatar"),
    purpose: text("purpose"),
    /** provider/model ref chosen in the UI; null = inherit OpenClaw default. */
    model: text("model"),
    canAskMain: integer("can_ask_main", { mode: "boolean" }).notNull().default(false),
    sandbox: integer("sandbox", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["provisioning", "ready", "error", "drift"] }).notNull().default("provisioning"),
    createdAt: createdAt(),
  },
  (t) => [index("agents_parent_idx").on(t.parentId), index("agents_team_idx").on(t.teamId)],
);

export const dataSources = sqliteTable("data_sources", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["notion", "gmail", "gdrive", "github", "figma", "folder"] }).notNull(),
  /** Plugin id / MCP server name / folder path inside the gateway. */
  connectorRef: text("connector_ref").notNull(),
  scope: text("scope"),
  status: text("status", { enum: ["pending", "connected", "error"] }).notNull().default("pending"),
  createdAt: createdAt(),
});

export const agentSourceGrants = sqliteTable(
  "agent_source_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    access: text("access", { enum: ["read", "write"] }).notNull().default("read"),
    /** Subset of the source (folder, repo, database) this agent may see. */
    scope: text("scope"),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.sourceId] })],
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    tz: text("tz").notNull(),
    prompt: text("prompt").notNull(),
    deliverTo: text("deliver_to"),
    openclawCronId: text("openclaw_cron_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_agent_idx").on(t.agentId)],
);

export const channelBindings = sqliteTable(
  "channel_bindings",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    accountId: text("account_id"),
    peerKind: text("peer_kind", { enum: ["direct", "group"] }),
    peerId: text("peer_id"),
    topicId: text("topic_id"),
  },
  (t) => [index("channel_bindings_agent_idx").on(t.agentId)],
);

export const modelCredentialStatus = sqliteTable("model_credential_status", {
  provider: text("provider").primaryKey(),
  method: text("method", { enum: ["api_key", "setup_token", "oauth"] }).notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
});

/** Small panel facts that are not secrets (e.g. the connected Telegram bot's public username). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    result: text("result", { enum: ["ok", "error"] }).notNull(),
    detail: text("detail"),
  },
  (t) => [index("audit_events_at_idx").on(t.at)],
);
