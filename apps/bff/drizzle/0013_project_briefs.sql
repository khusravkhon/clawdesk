CREATE TABLE `project_briefs` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `fields` text NOT NULL,
  `step` integer DEFAULT 0 NOT NULL CHECK (`step` BETWEEN 0 AND 3),
  `revision` integer DEFAULT 1 NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL,
  `updated_at` integer NOT NULL
);
