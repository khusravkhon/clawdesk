CREATE TABLE `project_load_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `conditions` text NOT NULL,
  `result` text,
  `error` text,
  `target` text NOT NULL,
  `verdict` text NOT NULL CHECK (`verdict` IN ('confirmed','not_confirmed','no_target','failed','blocked')),
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_load_runs_request_uq` ON `project_load_runs` (`project_id`, `request_id`);
