CREATE TABLE `agent_charter_versions` (
  `agent_id` text NOT NULL REFERENCES `agents`(`id`) ON DELETE CASCADE,
  `version` integer NOT NULL,
  `fields` text NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('owner','restore')),
  `note` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `request_id` text NOT NULL,
  PRIMARY KEY (`agent_id`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_charter_request_uq` ON `agent_charter_versions` (`agent_id`, `request_id`);
--> statement-breakpoint
ALTER TABLE `work_items` ADD `charter_version` integer;
