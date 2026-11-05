CREATE TABLE `work_items` (
  `id` text PRIMARY KEY NOT NULL,
  `number` integer NOT NULL,
  `title` text NOT NULL,
  `description` text NOT NULL,
  `criteria` text NOT NULL,
  `executor_agent_id` text NOT NULL,
  `created_by` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('draft','queued','running','blocked','review','done','failed','cancelled')),
  `block_text` text,
  `block_request_id` text,
  `result` text DEFAULT '' NOT NULL,
  `return_comment` text DEFAULT '' NOT NULL,
  `deadline_at` integer,
  `queued_at` integer,
  `revision` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_number_unique` ON `work_items` (`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_request_unique` ON `work_items` (`request_id`);
--> statement-breakpoint
CREATE INDEX `work_items_executor_idx` ON `work_items` (`executor_agent_id`, `status`);
--> statement-breakpoint
CREATE TABLE `work_item_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `item_id` text NOT NULL REFERENCES `work_items`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','queued','started','reported','blocked','unblocked','accepted','returned','failed','cancelled','refused')),
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
CREATE INDEX `work_item_events_item_idx` ON `work_item_events` (`item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_events_key_uq` ON `work_item_events` (`item_id`, `request_key`);
