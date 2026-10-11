CREATE TABLE `agent_source_grants` (
	`agent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`scope` text,
	PRIMARY KEY(`agent_id`, `source_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `data_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`parent_id` text,
	`team_id` text,
	`template_id` text,
	`display_name` text NOT NULL,
	`avatar` text,
	`purpose` text,
	`model` text,
	`can_ask_main` integer DEFAULT false NOT NULL,
	`sandbox` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agents_parent_idx` ON `agents` (`parent_id`);--> statement-breakpoint
CREATE INDEX `agents_team_idx` ON `agents` (`team_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`result` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel` text NOT NULL,
	`account_id` text,
	`peer_kind` text,
	`peer_id` text,
	`topic_id` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_bindings_agent_idx` ON `channel_bindings` (`agent_id`);--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`connector_ref` text NOT NULL,
	`scope` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_credential_status` (
	`provider` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`ok` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `panel_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `panel_users_email_uq` ON `panel_users` (`email`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cron` text NOT NULL,
	`tz` text NOT NULL,
	`prompt` text NOT NULL,
	`deliver_to` text,
	`openclaw_cron_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_agent_idx` ON `schedules` (`agent_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`name` text NOT NULL,
	`locale` text DEFAULT 'ru' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_url` text,
	`telegram_group_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
