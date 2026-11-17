BEGIN;

-- Direct messages can be edited and deleted by their sender, and can carry images (server/messages.ts).
-- As with posts, nothing is removed from the database: an edit files the earlier text in
-- falk_forum_message_edit, and a deleted message keeps its row and text but is shown to no one, along with
-- its images. A deleted message cannot be edited or brought back.
ALTER TABLE falk_forum_message ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE falk_forum_message ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- A message may be only images, so its text may be empty; the API asks for text or an image.
ALTER TABLE falk_forum_message DROP CONSTRAINT IF EXISTS falk_forum_message_body_check;
ALTER TABLE falk_forum_message ADD CONSTRAINT falk_forum_message_body_check CHECK (char_length(body) <= 2000);

CREATE TABLE IF NOT EXISTS falk_forum_message_edit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES falk_forum_message(id),
  body text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS falk_forum_message_edit_message ON falk_forum_message_edit(message_id, replaced_at);
CREATE OR REPLACE TRIGGER falk_forum_message_edit_immutable BEFORE UPDATE OR DELETE ON falk_forum_message_edit
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_forum_message_edit_truncate_guard BEFORE TRUNCATE ON falk_forum_message_edit
  FOR EACH STATEMENT EXECUTE FUNCTION falk_immutable_history();

-- Replaces the append-only guard from 013: who sent a message, where and when stay fixed; only the text
-- (filed as an edit) and deleted_at change, and a deleted message changes no more.
DROP TRIGGER IF EXISTS falk_forum_message_immutable ON falk_forum_message;
DROP TRIGGER IF EXISTS falk_forum_message_truncate_guard ON falk_forum_message;
CREATE OR REPLACE FUNCTION falk_guard_forum_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Messages are never deleted from the database; mark them deleted' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.conversation_id,NEW.sender_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.conversation_id,OLD.sender_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Message % cannot be moved or reassigned', OLD.id USING ERRCODE='55000';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Message % was deleted and cannot be changed', OLD.id USING ERRCODE='55000';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    INSERT INTO falk_forum_message_edit(message_id,body) VALUES(OLD.id,OLD.body);
    NEW.edited_at := clock_timestamp();
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'Message % edit time follows its text', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_message_guard BEFORE UPDATE OR DELETE ON falk_forum_message
  FOR EACH ROW EXECUTE FUNCTION falk_guard_forum_message();
CREATE OR REPLACE TRIGGER falk_forum_message_truncate_guard BEFORE TRUNCATE ON falk_forum_message
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_forum_message();

-- Images in messages use the forum's uploads. An image belongs to a post or a message, never both, and is
-- served only to the two members of the conversation.
ALTER TABLE falk_forum_image ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES falk_forum_message(id);
ALTER TABLE falk_forum_image DROP CONSTRAINT IF EXISTS falk_forum_image_one_place;
ALTER TABLE falk_forum_image ADD CONSTRAINT falk_forum_image_one_place CHECK (post_id IS NULL OR message_id IS NULL);
CREATE INDEX IF NOT EXISTS falk_forum_image_message ON falk_forum_image(message_id, position) WHERE message_id IS NOT NULL;
DROP INDEX IF EXISTS falk_forum_image_unattached;
CREATE INDEX falk_forum_image_unattached ON falk_forum_image(uploader_id, created_at) WHERE post_id IS NULL AND message_id IS NULL;

COMMIT;
