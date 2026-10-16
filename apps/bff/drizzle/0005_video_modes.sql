ALTER TABLE `video_jobs` ADD `mode` text DEFAULT 'study' NOT NULL;--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `frames` integer;--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `file_name` text;--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `file_bytes` integer;