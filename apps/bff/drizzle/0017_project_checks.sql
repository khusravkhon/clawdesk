CREATE TABLE `project_check_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('completed','blocked')),
  `reason` text CHECK (`reason` IS NULL OR `reason` IN ('runner_failed','timeout','no_tests')),
  `files_fingerprint` text NOT NULL,
  `duration_ms` integer NOT NULL,
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_check_run_request_uq` ON `project_check_runs` (`project_id`, `request_id`);
--> statement-breakpoint
CREATE INDEX `project_check_runs_project_idx` ON `project_check_runs` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `project_check_results` (
  `run_id` text NOT NULL REFERENCES `project_check_runs`(`id`) ON DELETE CASCADE,
  `test_id` text NOT NULL,
  `file` text NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('passed','failed','flaky','skipped')),
  `message` text DEFAULT '' NOT NULL,
  `file_hash` text,
  PRIMARY KEY (`run_id`, `test_id`)
);
--> statement-breakpoint
CREATE TABLE `acceptance_test_links` (
  `case_id` text NOT NULL,
  `revision` integer NOT NULL,
  `test_id` text NOT NULL,
  `file_hash` text NOT NULL,
  `run_id` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`case_id`, `revision`),
  FOREIGN KEY (`case_id`, `revision`) REFERENCES `acceptance_revisions` (`case_id`, `revision`) ON DELETE CASCADE
);
