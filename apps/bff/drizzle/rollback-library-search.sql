-- Offline rollback of 0008 only: stop the BFF and back up SQLite with its WAL first.
BEGIN IMMEDIATE;
-- RAISE(ROLLBACK) needs a trigger; the temporary guard disappears on refusal too.
-- Removing an older journal entry while a newer entry remains prevents reapplication.
CREATE TEMP TABLE clawdesk_library_rollback_guard (checked integer);
CREATE TEMP TRIGGER clawdesk_library_rollback_guard_check
BEFORE INSERT ON clawdesk_library_rollback_guard
WHEN EXISTS (SELECT 1 FROM __drizzle_migrations WHERE created_at > 1792230000000)
BEGIN
  SELECT RAISE(ROLLBACK, 'Cannot roll back 0008 while newer migrations are applied; restore a coherent database and application backup');
END;
INSERT INTO clawdesk_library_rollback_guard VALUES (1);
DROP TRIGGER clawdesk_library_rollback_guard_check;
DROP TABLE clawdesk_library_rollback_guard;
UPDATE library_items SET text = (SELECT text FROM library_contents WHERE id = library_items.content_id) WHERE content_id IS NOT NULL;
DROP TRIGGER library_items_delete_content;
DROP TRIGGER library_contents_insert;
DROP TRIGGER library_contents_update;
DROP TRIGGER library_contents_delete;
DROP TABLE library_search;
DROP INDEX library_items_content_idx;
ALTER TABLE library_items DROP COLUMN content_id;
DROP TABLE library_contents;
DELETE FROM __drizzle_migrations WHERE created_at = 1792230000000;
COMMIT;
