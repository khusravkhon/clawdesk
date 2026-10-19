CREATE TABLE `acceptance_cases` (
  `id` text PRIMARY KEY NOT NULL,
  `rule_id` text NOT NULL REFERENCES `project_rules`(`id`) ON DELETE CASCADE,
  `rule_version` integer NOT NULL,
  `number` integer NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL,
  FOREIGN KEY (`rule_id`, `rule_version`) REFERENCES `project_rule_versions` (`rule_id`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_case_number_uq` ON `acceptance_cases` (`rule_id`, `number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_case_request_uq` ON `acceptance_cases` (`rule_id`, `request_id`);
--> statement-breakpoint
CREATE TABLE `acceptance_revisions` (
  `case_id` text NOT NULL REFERENCES `acceptance_cases`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL,
  `fields` text NOT NULL,
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL,
  PRIMARY KEY (`case_id`, `revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_revision_request_uq` ON `acceptance_revisions` (`case_id`, `request_id`);
--> statement-breakpoint
CREATE TABLE `acceptance_checks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `case_id` text NOT NULL REFERENCES `acceptance_cases`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL,
  `outcome` text NOT NULL CHECK (`outcome` IN ('passed','failed','blocked')),
  `context` text NOT NULL,
  `observed` text NOT NULL,
  `evidence` text NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL CHECK (`source` = 'manual'),
  `checked_by` text DEFAULT 'owner' NOT NULL CHECK (`checked_by` = 'owner'),
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL,
  FOREIGN KEY (`case_id`, `revision`) REFERENCES `acceptance_revisions` (`case_id`, `revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_check_request_uq` ON `acceptance_checks` (`case_id`, `request_id`);
--> statement-breakpoint
CREATE INDEX `acceptance_checks_case_idx` ON `acceptance_checks` (`case_id`, `revision`, `id`);
