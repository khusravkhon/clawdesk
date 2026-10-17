CREATE TABLE library_contents (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  text text NOT NULL,
  hash text,
  folded text
);
--> statement-breakpoint
CREATE INDEX library_contents_hash_idx ON library_contents(hash);
--> statement-breakpoint
CREATE INDEX library_contents_pending_idx ON library_contents(id) WHERE folded IS NULL;
--> statement-breakpoint
ALTER TABLE library_items ADD COLUMN content_id integer REFERENCES library_contents(id);
--> statement-breakpoint
CREATE INDEX library_items_content_idx ON library_items(content_id);
--> statement-breakpoint
INSERT INTO library_contents(text) SELECT DISTINCT text FROM library_items;
--> statement-breakpoint
CREATE INDEX library_contents_migration_text_idx ON library_contents(text);
--> statement-breakpoint
UPDATE library_items SET content_id = (SELECT id FROM library_contents WHERE library_contents.text = library_items.text), text = '';
--> statement-breakpoint
DROP INDEX library_contents_migration_text_idx;
--> statement-breakpoint
CREATE VIRTUAL TABLE library_search USING fts5(folded, content='library_contents', content_rowid='id', tokenize='trigram case_sensitive 1');
--> statement-breakpoint
INSERT INTO library_search(library_search) VALUES('rebuild');
--> statement-breakpoint
CREATE TRIGGER library_contents_insert AFTER INSERT ON library_contents BEGIN
  INSERT INTO library_search(rowid, folded) VALUES(new.id, new.folded);
END;
--> statement-breakpoint
CREATE TRIGGER library_contents_update AFTER UPDATE OF folded ON library_contents BEGIN
  INSERT INTO library_search(library_search, rowid, folded) VALUES('delete', old.id, old.folded);
  INSERT INTO library_search(rowid, folded) VALUES(new.id, new.folded);
END;
--> statement-breakpoint
CREATE TRIGGER library_contents_delete AFTER DELETE ON library_contents BEGIN
  INSERT INTO library_search(library_search, rowid, folded) VALUES('delete', old.id, old.folded);
END;
--> statement-breakpoint
CREATE TRIGGER library_items_delete_content AFTER DELETE ON library_items BEGIN
  DELETE FROM library_contents WHERE id = old.content_id AND NOT EXISTS (SELECT 1 FROM library_items WHERE content_id = old.content_id);
END;
