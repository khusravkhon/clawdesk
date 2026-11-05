CREATE TABLE `work_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `number` integer NOT NULL,
  `from_agent_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('question','decision')),
  `subject` text NOT NULL,
  `subject_key` text NOT NULL,
  `details` text NOT NULL,
  `task_ref` text DEFAULT '' NOT NULL,
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
CREATE UNIQUE INDEX `work_requests_number_unique` ON `work_requests` (`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_spool_id_unique` ON `work_requests` (`spool_id`);
--> statement-breakpoint
CREATE INDEX `work_requests_from_idx` ON `work_requests` (`from_agent_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_requests_active_uq` ON `work_requests` (`from_agent_id`, `kind`, `subject_key`) WHERE `status` IN ('open','clarify');
--> statement-breakpoint
CREATE TABLE `work_request_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_id` text NOT NULL REFERENCES `work_requests`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','routed','skipped','escalated','clarify','reply','answered','denied','expired','cancelled','refused')),
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
CREATE INDEX `work_request_events_request_idx` ON `work_request_events` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_request_events_key_uq` ON `work_request_events` (`request_id`, `request_key`);
--> statement-breakpoint
CREATE TABLE `work_request_spool` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `outcome` text NOT NULL,
  `notify_text` text,
  `delivered_at` integer,
  `attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
