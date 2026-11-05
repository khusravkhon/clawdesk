CREATE TABLE `project_rule_audits` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('idle','checking','checked','failed')),
  `failure` text,
  `revision` integer DEFAULT 0 NOT NULL,
  `started_at` integer,
  `checked_at` integer,
  `checked_rules` text DEFAULT '' NOT NULL,
  `updated_at` integer NOT NULL,
  `request_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_rule_conflicts` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_projects`(`id`) ON DELETE CASCADE,
  `rules` text NOT NULL,
  `explanation` text NOT NULL,
  `example` text DEFAULT '' NOT NULL,
  `question` text DEFAULT '' NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','dismissed','superseded')),
  `note` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `project_rule_conflicts_project_idx` ON `project_rule_conflicts` (`project_id`, `status`);
