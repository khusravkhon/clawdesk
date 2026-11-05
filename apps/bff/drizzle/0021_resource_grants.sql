CREATE TABLE `__new_work_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `number` integer NOT NULL,
  `from_agent_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('question','decision','access')),
  `subject` text NOT NULL,
  `subject_key` text NOT NULL,
  `details` text NOT NULL,
  `task_ref` text DEFAULT '' NOT NULL,
  `resource` text,
  `access` text CHECK (`access` IS NULL OR `access` IN ('read','write')),
  `status` text NOT NULL CHECK (`status` IN ('open','clarify','answered','denied','expired','cancelled')),
  `route` text NOT NULL,
  `level` integer DEFAULT 0 NOT NULL,
  `hops` integer DEFAULT 0 NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  `answer_text` text,
  `answered_by` text,
  `deadline_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `spool_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_work_requests` (`id`, `number`, `from_agent_id`, `kind`, `subject`, `subject_key`, `details`, `task_ref`, `status`, `route`, `level`, `hops`, `revision`, `answer_text`, `answered_by`, `deadline_at`, `created_at`, `updated_at`, `spool_id`)
  SELECT `id`, `number`, `from_agent_id`, `kind`, `subject`, `subject_key`, `details`, `task_ref`, `status`, `route`, `level`, `hops`, `revision`, `answer_text`, `answered_by`, `deadline_at`, `created_at`, `updated_at`, `spool_id` FROM `work_requests`;
--> statement-breakpoint
CREATE TABLE `__new_work_request_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_id` text NOT NULL REFERENCES `__new_work_requests`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','routed','skipped','escalated','clarify','reply','answered','denied','expired','cancelled','refused','granted')),
  `actor` text NOT NULL,
  `text` text DEFAULT '' NOT NULL,
  `notify_agent_id` text,
  `notify_text` text,
  `delivered_at` integer,
  `attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `request_key` text
);
--> statement-breakpoint
INSERT INTO `__new_work_request_events` SELECT `id`, `request_id`, `kind`, `actor`, `text`, `notify_agent_id`, `notify_text`, `delivered_at`, `attempts`, `created_at`, `request_key` FROM `work_request_events`;
--> statement-breakpoint
DROP TABLE `work_request_events`;
--> statement-breakpoint
DROP TABLE `work_requests`;
--> statement-breakpoint
ALTER TABLE `__new_work_requests` RENAME TO `work_requests`;
--> statement-breakpoint
ALTER TABLE `__new_work_request_events` RENAME TO `work_request_events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_number_unique` ON `work_requests` (`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_spool_id_unique` ON `work_requests` (`spool_id`);
--> statement-breakpoint
CREATE INDEX `work_requests_from_idx` ON `work_requests` (`from_agent_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_active_uq` ON `work_requests` (`from_agent_id`, `kind`, `subject_key`) WHERE `status` IN ('open','clarify');
--> statement-breakpoint
CREATE INDEX `work_request_events_request_idx` ON `work_request_events` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_request_events_key_uq` ON `work_request_events` (`request_id`, `request_key`);
--> statement-breakpoint
CREATE TABLE `resource_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `resource` text NOT NULL,
  `access` text NOT NULL CHECK (`access` IN ('read','write')),
  `granted_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `revoked_at` integer,
  `revoked_by` text
);
--> statement-breakpoint
CREATE INDEX `resource_grants_agent_idx` ON `resource_grants` (`agent_id`, `resource`);
