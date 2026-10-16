CREATE TABLE `library_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`locator` text,
	`text` text NOT NULL,
	`chars` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_items_agent_idx` ON `library_items` (`agent_id`);--> statement-breakpoint
CREATE INDEX `library_items_created_idx` ON `library_items` (`created_at`);--> statement-breakpoint
CREATE TABLE `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text,
	`happened_on` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `memory_notes_agent_idx` ON `memory_notes` (`agent_id`);