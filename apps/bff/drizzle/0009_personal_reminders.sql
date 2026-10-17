CREATE TABLE `personal_reminders` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL UNIQUE,
  `text` text NOT NULL,
  `due_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `time_zone` text NOT NULL,
  `delivery` text NOT NULL DEFAULT 'pending',
  `action` text NOT NULL DEFAULT 'open',
  `sent_at` integer,
  `message_id` text,
  `parent_id` text,
  `reason` text,
  `action_request_id` text,
  `action_payload` text
);
--> statement-breakpoint
CREATE INDEX `personal_reminders_due_idx` ON `personal_reminders` (`action`, `delivery`, `due_at`);
