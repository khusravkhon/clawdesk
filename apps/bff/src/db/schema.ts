import { sql } from "drizzle-orm";
import { blob, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const departments = sqliteTable("departments", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  requestPayload: text("request_payload").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(0),
  createdAt: createdAt(),
});

export const companyProjects = sqliteTable("company_projects", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  requestPayload: text("request_payload").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  departmentId: text("department_id").references(() => departments.id),
  status: text("status", { enum: ["draft", "planned", "archived"] }).notNull().default("draft"),
  revision: integer("revision").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("company_projects_department_idx").on(t.departmentId)]);

export const projectBriefs = sqliteTable("project_briefs", {
  projectId: text("project_id").primaryKey().references(() => companyProjects.id, { onDelete: "cascade" }),
  fields: text("fields", { mode: "json" }).$type<import("@clawdesk/shared").ProjectBriefFields>().notNull(),
  step: integer("step").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectBuilders = sqliteTable("project_builders", {
  projectId: text("project_id").primaryKey().references(() => companyProjects.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  plan: text("plan", { mode: "json" }).$type<import("@clawdesk/shared").ProjectBuilderPlanDto | null>(),
});

export const projectBuilderRequests = sqliteTable("project_builder_requests", {
  projectId: text("project_id").notNull().references(() => companyProjects.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  payload: text("payload").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.requestId] })]);

export const projectRules = sqliteTable("project_rules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => companyProjects.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  revision: integer("revision").notNull().default(0),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
}, (t) => [uniqueIndex("project_rules_number_uq").on(t.projectId, t.number), uniqueIndex("project_rules_request_uq").on(t.projectId, t.requestId)]);

export const projectRuleVersions = sqliteTable("project_rule_versions", {
  ruleId: text("rule_id").notNull().references(() => projectRules.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  fields: text("fields", { mode: "json" }).$type<import("@clawdesk/shared").BusinessRuleFields>().notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by", { enum: ["owner"] }).notNull().default("owner"),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
  approvedAt: integer("approved_at"),
  approvedBy: text("approved_by", { enum: ["owner"] }),
  approvalRequestId: text("approval_request_id"),
  approvalPayload: text("approval_payload"),
}, (t) => [primaryKey({ columns: [t.ruleId, t.version] }), uniqueIndex("rule_versions_request_uq").on(t.ruleId, t.requestId)]);

export const acceptanceCases = sqliteTable("acceptance_cases", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => projectRules.id, { onDelete: "cascade" }),
  ruleVersion: integer("rule_version").notNull(),
  number: integer("number").notNull(),
  revision: integer("revision").notNull().default(1),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
}, (t) => [uniqueIndex("acceptance_case_number_uq").on(t.ruleId, t.number), uniqueIndex("acceptance_case_request_uq").on(t.ruleId, t.requestId), foreignKey({ columns: [t.ruleId, t.ruleVersion], foreignColumns: [projectRuleVersions.ruleId, projectRuleVersions.version] })]);

export const acceptanceRevisions = sqliteTable("acceptance_revisions", {
  caseId: text("case_id").notNull().references(() => acceptanceCases.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  fields: text("fields", { mode: "json" }).$type<import("@clawdesk/shared").AcceptanceFields>().notNull(),
  createdAt: integer("created_at").notNull(),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
}, (t) => [primaryKey({ columns: [t.caseId, t.revision] }), uniqueIndex("acceptance_revision_request_uq").on(t.caseId, t.requestId)]);

export const acceptanceChecks = sqliteTable("acceptance_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  caseId: text("case_id").notNull().references(() => acceptanceCases.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  outcome: text("outcome", { enum: ["passed", "failed", "blocked"] }).notNull(),
  context: text("context").notNull(),
  observed: text("observed").notNull(),
  evidence: text("evidence").notNull(),
  source: text("source", { enum: ["manual"] }).notNull().default("manual"),
  checkedBy: text("checked_by", { enum: ["owner"] }).notNull().default("owner"),
  createdAt: integer("created_at").notNull(),
  requestId: text("request_id").notNull(),
  requestPayload: text("request_payload").notNull(),
}, (t) => [uniqueIndex("acceptance_check_request_uq").on(t.caseId, t.requestId), index("acceptance_checks_case_idx").on(t.caseId, t.revision, t.id), foreignKey({ columns: [t.caseId, t.revision], foreignColumns: [acceptanceRevisions.caseId, acceptanceRevisions.revision] })]);

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  telegramGroupId: text("telegram_group_id"),
  departmentId: text("department_id").references(() => departments.id),
  projectId: text("project_id").references(() => companyProjects.id),
  organizationRevision: integer("organization_revision").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("teams_department_idx").on(t.departmentId), index("teams_project_idx").on(t.projectId)]);

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

export const departmentManagers = sqliteTable("department_managers", {
  departmentId: text("department_id").primaryKey().references(() => departments.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().unique().references(() => agents.id, { onDelete: "cascade" }),
});

export const companyAgentAssignments = sqliteTable("company_agent_assignments", {
  agentId: text("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  departmentId: text("department_id").references(() => departments.id),
  revision: integer("revision").notNull().default(0),
}, (t) => [index("company_agent_department_idx").on(t.departmentId)]);

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

/**
 * Templates the owner saved from one of their agents ("My templates"). Built-in templates live in
 * packages/templates; these work the same way in the builder, with the agent's name as {{agentName}}.
 */
export const userTemplates = sqliteTable("user_templates", {
  /** "my-…", so it never collides with a built-in template id. */
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["personal", "company"] }).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  emoji: text("emoji"),
  /** Name suggested for a new agent (the name of the agent it was saved from). */
  defaultName: text("default_name").notNull(),
  /** SOUL.md, AGENTS.md, USER.md. */
  files: text("files", { mode: "json" }).$type<Record<string, string>>().notNull(),
  /** Suggested own folder; null: the template does not use one. */
  folder: text("folder"),
  cronPresets: text("cron_presets", { mode: "json" }).$type<{ id: string; label: string; cron: string; prompt: string }[]>().notNull(),
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull(),
  canAskMain: integer("can_ask_main", { mode: "boolean" }).notNull(),
  createdAt: createdAt(),
});

/**
 * Videos the owner asked an agent to study (screen 9). The row is the durable part: the worker
 * runs outside the panel, so a restart must still know whose job this was and how it ended.
 */
export const videoJobs = sqliteTable(
  "video_jobs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    /** The canonical link, without the owner's tracking parameters. */
    url: text("url").notNull(),
    videoId: text("video_id").notNull(),
    title: text("title"),
    /** What the owner asked for: a summary, the picture, or the file. */
    mode: text("mode", { enum: ["study", "frames", "download"] }).notNull().default("study"),
    state: text("state", { enum: ["queued", "running", "ready", "failed", "canceled"] }).notNull(),
    /** What the material came from: subtitles, speech, frames, the file itself, or nothing. */
    source: text("source", { enum: ["subtitles", "speech", "frames", "file", "none"] }).notNull(),
    language: text("language"),
    durationSec: integer("duration_sec"),
    chars: integer("chars").notNull().default(0),
    /** Frames handed to the agent, for a frames job. */
    frames: integer("frames"),
    /** The kept original in the panel video directory, and its size on disk. */
    fileName: text("file_name"),
    fileBytes: integer("file_bytes"),
    /** A code from VideoJobError; never a raw worker message. */
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("video_jobs_state_idx").on(t.state), index("video_jobs_created_idx").on(t.createdAt)],
);

/** Identical bounded texts share storage; ownership and source metadata stay on library_items. */
export const libraryContents = sqliteTable("library_contents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  hash: text("hash"),
  folded: text("folded"),
}, (t) => [index("library_contents_hash_idx").on(t.hash), index("library_contents_pending_idx").on(t.id).where(sql`${t.folded} IS NULL`)]);

/**
 * The owner's library: what the panel has already read for an agent — a document from the chat or
 * a video transcript. The row belongs to the agent the material was sent to, so a search only ever
 * finds what that agent was actually given.
 */
export const libraryItems = sqliteTable(
  "library_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind", { enum: ["document", "video"] }).notNull(),
    /** The file name or the video title. */
    title: text("title").notNull(),
    /** Where it came from: the file name, or the canonical video link. */
    source: text("source").notNull(),
    /** How to point back into it: "страница", "лист", "таймкод" — set by whoever read it. */
    locator: text("locator"),
    /** Legacy text column; the text the panel read now lives once in library_contents. */
    text: text("text").notNull(),
    contentId: integer("content_id").references(() => libraryContents.id),
    chars: integer("chars").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("library_items_agent_idx").on(t.agentId), index("library_items_created_idx").on(t.createdAt), index("library_items_content_idx").on(t.contentId)],
);

/**
 * Notes the owner keeps for an agent, with where each one came from and when. The panel writes
 * them into that agent's USER.md between its own markers, so the agent reads them as its own
 * knowledge while the owner stays able to correct or delete any of them.
 */
export const memoryNotes = sqliteTable(
  "memory_notes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    text: text("text").notNull(),
    /** Where this came from, in the owner's words: a document, a conversation, a link. */
    source: text("source"),
    /** The day the fact is about (YYYY-MM-DD), which is not always the day it was written. */
    happenedOn: text("happened_on"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("memory_notes_agent_idx").on(t.agentId)],
);

/**
 * Skills the owner added on the "Skills & MCP" screen. Which agents have one is not stored here:
 * it is whatever each agent's workspace holds (skills/<slug>), read back from the Gateway.
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["clawhub", "own"] }).notNull(),
  /** Folder name in an agent's workspace: skills/<slug>. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** ClawHub reference (`@owner/slug`) for kind "clawhub". */
  installRef: text("install_ref"),
  /** Own skills: the zip OpenClaw installs from (a written skill is a zip with one SKILL.md). */
  archive: blob("archive", { mode: "buffer" }),
  /** Own skills written in the panel, so the owner can edit them; null for uploaded archives. */
  instructions: text("instructions"),
  createdAt: createdAt(),
});

/**
 * MCP servers in OpenClaw's config the panel knows about, and which agents may use each one.
 * Agents without a grant get `<name>__*` in their tool deny list.
 */
export const mcpServers = sqliteTable("mcp_servers", {
  name: text("name").primaryKey(),
  url: text("url"),
  auth: text("auth", { enum: ["oauth", "token", "none"] }).notNull(),
  /** Added on the Skills & MCP screen (removable there); false for Notion from data sources. */
  managed: integer("managed", { mode: "boolean" }).notNull(),
  createdAt: createdAt(),
});

export const mcpGrants = sqliteTable(
  "mcp_grants",
  {
    server: text("server")
      .notNull()
      .references(() => mcpServers.name, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.server, t.agentId] })],
);

/** Fixed owner reminders. A durable sending claim is never replayed after an uncertain send. */
export const personalReminders = sqliteTable("personal_reminders", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  text: text("text").notNull(),
  dueAt: integer("due_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  timeZone: text("time_zone").notNull(),
  delivery: text("delivery", { enum: ["pending", "deferred", "sending", "sent", "unknown", "expired"] }).notNull().default("pending"),
  action: text("action", { enum: ["open", "done", "skipped", "snoozed"] }).notNull().default("open"),
  sentAt: integer("sent_at"),
  messageId: text("message_id"),
  parentId: text("parent_id"),
  reason: text("reason"),
  actionRequestId: text("action_request_id"),
  actionPayload: text("action_payload"),
}, (t) => [index("personal_reminders_due_idx").on(t.action, t.delivery, t.dueAt)]);
