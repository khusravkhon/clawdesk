CREATE TABLE `project_builders` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `revision` integer DEFAULT 0 NOT NULL,
  `plan` text
);
--> statement-breakpoint
CREATE TABLE `project_builder_requests` (
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `request_id` text NOT NULL,
  `payload` text NOT NULL,
  PRIMARY KEY (`project_id`, `request_id`)
);
