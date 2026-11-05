CREATE TABLE `project_interviews` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('idle','asking','ready','done','failed')),
  `failure` text,
  `revision` integer DEFAULT 0 NOT NULL,
  `round` integer DEFAULT 0 NOT NULL,
  `questions` text NOT NULL,
  `assumptions` text NOT NULL,
  `summary` text,
  `answered` text NOT NULL,
  `started_at` integer,
  `updated_at` integer NOT NULL,
  `request_id` text NOT NULL
);
