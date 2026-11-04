ALTER TABLE `project_check_results` ADD `test_hash` text;
--> statement-breakpoint
ALTER TABLE `acceptance_test_links` ADD `test_hash` text;
--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `previous_version` integer;
--> statement-breakpoint
ALTER TABLE `project_tasks` ADD `rolled_back_at` integer;
--> statement-breakpoint
CREATE TABLE `__new_project_task_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `task_id` text NOT NULL REFERENCES `project_tasks`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','sent','qa_checked','dev_checked','accepted','returned','cancelled','rolled_back')),
  `note` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_project_task_events` (`id`, `task_id`, `kind`, `note`, `created_at`, `request_id`) SELECT `id`, `task_id`, `kind`, `note`, `created_at`, `request_id` FROM `project_task_events`;
--> statement-breakpoint
DROP TABLE `project_task_events`;
--> statement-breakpoint
ALTER TABLE `__new_project_task_events` RENAME TO `project_task_events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `project_task_event_request_uq` ON `project_task_events` (`task_id`, `request_id`);
