CREATE TABLE `chat_conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `title` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_conversations_agent_idx` ON `chat_conversations` (`agent_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `chat_sends` (
  `id` text PRIMARY KEY NOT NULL,
  `session_key` text NOT NULL,
  `fingerprint` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('ready','dispatched','accepted')),
  `accepted_at` integer,
  `result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_sends_state_session_idx` ON `chat_sends` (`state`, `session_key`, `accepted_at`);
