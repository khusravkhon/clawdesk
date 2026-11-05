CREATE TABLE `project_existing_plans` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('idle','planning','ready','failed')),
  `failure` text,
  `revision` integer DEFAULT 0 NOT NULL,
  `plan` text,
  `basis` text,
  `started_at` integer,
  `updated_at` integer NOT NULL,
  `request_id` text NOT NULL
);
