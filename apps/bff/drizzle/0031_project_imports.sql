CREATE TABLE `project_imports` (
  `package_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `state` text NOT NULL CHECK (`state` IN ('imported','folder_failed')),
  `created_at` integer NOT NULL
);
