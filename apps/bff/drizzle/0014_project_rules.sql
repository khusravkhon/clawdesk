CREATE TABLE `project_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `number` integer NOT NULL,
  `current_version` integer DEFAULT 1 NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_rules_number_uq` ON `project_rules` (`project_id`, `number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_rules_request_uq` ON `project_rules` (`project_id`, `request_id`);
--> statement-breakpoint
CREATE TABLE `project_rule_versions` (
  `rule_id` text NOT NULL REFERENCES `project_rules`(`id`) ON DELETE CASCADE,
  `version` integer NOT NULL,
  `fields` text NOT NULL,
  `created_at` integer NOT NULL,
  `created_by` text DEFAULT 'owner' NOT NULL CHECK (`created_by` = 'owner'),
  `request_id` text NOT NULL,
  `request_payload` text NOT NULL,
  `approved_at` integer,
  `approved_by` text CHECK (`approved_by` IS NULL OR `approved_by` = 'owner'),
  `approval_request_id` text,
  `approval_payload` text,
  PRIMARY KEY (`rule_id`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_versions_request_uq` ON `project_rule_versions` (`rule_id`, `request_id`);
