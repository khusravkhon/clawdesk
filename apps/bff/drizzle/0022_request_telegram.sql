CREATE TABLE `__new_work_request_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_id` text NOT NULL REFERENCES `work_requests`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','routed','skipped','escalated','clarify','reply','answered','denied','expired','cancelled','refused','granted','notified')),
  `actor` text NOT NULL,
  `text` text DEFAULT '' NOT NULL,
  `notify_agent_id` text,
  `notify_owner` integer DEFAULT 0 NOT NULL,
  `notify_text` text,
  `delivered_at` integer,
  `attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `request_key` text
);
--> statement-breakpoint
INSERT INTO `__new_work_request_events` (`id`, `request_id`, `kind`, `actor`, `text`, `notify_agent_id`, `notify_text`, `delivered_at`, `attempts`, `created_at`, `request_key`)
  SELECT `id`, `request_id`, `kind`, `actor`, `text`, `notify_agent_id`, `notify_text`, `delivered_at`, `attempts`, `created_at`, `request_key` FROM `work_request_events`;
--> statement-breakpoint
DROP TABLE `work_request_events`;
--> statement-breakpoint
ALTER TABLE `__new_work_request_events` RENAME TO `work_request_events`;
--> statement-breakpoint
CREATE INDEX `work_request_events_request_idx` ON `work_request_events` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_request_events_key_uq` ON `work_request_events` (`request_id`, `request_key`);
--> statement-breakpoint
CREATE TABLE `work_request_buttons` (
  `token` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL REFERENCES `work_requests`(`id`) ON DELETE CASCADE,
  `event_id` integer NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('grant','deny','cancel')),
  `created_at` integer NOT NULL,
  `used_at` integer
);
--> statement-breakpoint
CREATE INDEX `work_request_buttons_request_idx` ON `work_request_buttons` (`request_id`);
