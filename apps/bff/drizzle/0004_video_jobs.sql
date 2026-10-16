CREATE TABLE `video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`url` text NOT NULL,
	`video_id` text NOT NULL,
	`title` text,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`language` text,
	`duration_sec` integer,
	`chars` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `video_jobs_state_idx` ON `video_jobs` (`state`);--> statement-breakpoint
CREATE INDEX `video_jobs_created_idx` ON `video_jobs` (`created_at`);