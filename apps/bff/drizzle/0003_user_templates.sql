CREATE TABLE `user_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`emoji` text,
	`default_name` text NOT NULL,
	`files` text NOT NULL,
	`folder` text,
	`cron_presets` text NOT NULL,
	`skills` text NOT NULL,
	`can_ask_main` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
