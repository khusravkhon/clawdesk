CREATE TABLE `google_doc_copies` (
  `agent_id` text NOT NULL,
  `doc_id` text NOT NULL,
  `title` text NOT NULL,
  `revision` text,
  `sha` text NOT NULL,
  `copied_at` integer NOT NULL,
  PRIMARY KEY (`agent_id`, `doc_id`)
);
