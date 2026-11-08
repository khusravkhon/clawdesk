CREATE TABLE `reminder_series` (
  `id` text PRIMARY KEY NOT NULL,
  `text` text NOT NULL,
  `time_zone` text NOT NULL,
  `days` text NOT NULL,
  `clock` text NOT NULL,
  `next_at` integer,
  `stop_request_id` text UNIQUE
);
--> statement-breakpoint
CREATE INDEX `reminder_series_next_idx` ON `reminder_series` (`next_at`);
--> statement-breakpoint
ALTER TABLE `personal_reminders` ADD `series_id` text REFERENCES `reminder_series`(`id`);
