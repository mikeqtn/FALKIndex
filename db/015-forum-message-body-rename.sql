BEGIN;

-- 014 let a message be only images (empty text) by redefining falk_forum_message_body_check in place. Publish
-- copies the schema to production by comparing constraint names, so the old "1 to 2000 characters" rule stayed
-- there and every image-only message failed. The new rule gets a new name, so the old one is dropped everywhere.
ALTER TABLE falk_forum_message DROP CONSTRAINT IF EXISTS falk_forum_message_body_check;
ALTER TABLE falk_forum_message DROP CONSTRAINT IF EXISTS falk_forum_message_body_length;
ALTER TABLE falk_forum_message ADD CONSTRAINT falk_forum_message_body_length CHECK (char_length(body) <= 2000);

COMMIT;
