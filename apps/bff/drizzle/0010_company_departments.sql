CREATE TABLE `departments` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL UNIQUE,
  `request_payload` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `archived` integer NOT NULL DEFAULT 0,
  `revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
--> statement-breakpoint
ALTER TABLE `teams` ADD COLUMN `department_id` text REFERENCES `departments`(`id`);
--> statement-breakpoint
ALTER TABLE `teams` ADD COLUMN `organization_revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `teams_department_idx` ON `teams` (`department_id`);
--> statement-breakpoint
CREATE TABLE `department_managers` (
  `department_id` text PRIMARY KEY NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL UNIQUE REFERENCES `agents`(`id`) ON DELETE CASCADE
);
