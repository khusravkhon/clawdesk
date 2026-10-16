CREATE TABLE `mcp_grants` (
	`server` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`server`, `agent_id`),
	FOREIGN KEY (`server`) REFERENCES `mcp_servers`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`name` text PRIMARY KEY NOT NULL,
	`url` text,
	`auth` text NOT NULL,
	`managed` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`install_ref` text,
	`archive` blob,
	`instructions` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);