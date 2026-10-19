CREATE TABLE `company_agent_assignments` (
  `agent_id` text PRIMARY KEY NOT NULL REFERENCES `agents`(`id`) ON DELETE CASCADE,
  `department_id` text REFERENCES `departments`(`id`),
  `revision` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `company_agent_department_idx` ON `company_agent_assignments` (`department_id`);
--> statement-breakpoint
INSERT INTO `company_agent_assignments` (`agent_id`, `department_id`, `revision`)
SELECT `agent_id`, `department_id`, 1 FROM `department_managers`;
