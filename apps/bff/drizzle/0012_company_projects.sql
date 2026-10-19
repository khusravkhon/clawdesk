CREATE TABLE `company_projects` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL UNIQUE,
  `request_payload` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `department_id` text REFERENCES `departments`(`id`),
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','planned','archived')),
  `revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
--> statement-breakpoint
CREATE INDEX `company_projects_department_idx` ON `company_projects` (`department_id`);
--> statement-breakpoint
ALTER TABLE `teams` ADD COLUMN `project_id` text REFERENCES `company_projects`(`id`);
--> statement-breakpoint
CREATE INDEX `teams_project_idx` ON `teams` (`project_id`);
