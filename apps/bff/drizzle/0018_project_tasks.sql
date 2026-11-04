CREATE TABLE `project_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `number` integer NOT NULL,
  `rule_id` text NOT NULL REFERENCES `project_rules`(`id`) ON DELETE CASCADE,
  `rule_version` integer NOT NULL,
  `title` text NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('qa','dev','review','done','cancelled')),
  `revision` integer DEFAULT 0 NOT NULL,
  `base_files` text NOT NULL,
  `qa_tests` text,
  `dev_files` text,
  `last_check` text,
  `return_comment` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_task_number_uq` ON `project_tasks` (`project_id`, `number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_task_request_uq` ON `project_tasks` (`project_id`, `request_id`);
--> statement-breakpoint
CREATE TABLE `project_task_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `task_id` text NOT NULL REFERENCES `project_tasks`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('created','sent','qa_checked','dev_checked','accepted','returned','cancelled')),
  `note` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_task_event_request_uq` ON `project_task_events` (`task_id`, `request_id`);
