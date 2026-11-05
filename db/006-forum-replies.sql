BEGIN;

-- Replies to replies. A post with no parent is the thread's opening post or a direct reply to the
-- thread, so existing posts need no backfill. The composite key keeps a parent in the same thread.
-- depth counts levels below a direct reply (0), and the API caps it; see MAX_REPLY_DEPTH.
ALTER TABLE falk_forum_post ADD COLUMN IF NOT EXISTS parent_id uuid;
ALTER TABLE falk_forum_post ADD COLUMN IF NOT EXISTS depth smallint NOT NULL DEFAULT 0;
ALTER TABLE falk_forum_post DROP CONSTRAINT IF EXISTS falk_forum_post_parent_fkey;
ALTER TABLE falk_forum_post DROP CONSTRAINT IF EXISTS falk_forum_post_id_thread_key;
ALTER TABLE falk_forum_post ADD CONSTRAINT falk_forum_post_id_thread_key UNIQUE (id, thread_id);
ALTER TABLE falk_forum_post ADD CONSTRAINT falk_forum_post_parent_fkey
  FOREIGN KEY (parent_id, thread_id) REFERENCES falk_forum_post(id, thread_id);
CREATE INDEX IF NOT EXISTS falk_forum_post_parent ON falk_forum_post(parent_id) WHERE parent_id IS NOT NULL;

-- As in 005, with the post's place in the conversation fixed too.
CREATE OR REPLACE FUNCTION falk_guard_forum_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Forum posts are never deleted; hide them with a reason' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.thread_id,NEW.author_id,NEW.created_at,NEW.parent_id,NEW.depth) IS DISTINCT FROM
     (OLD.id,OLD.thread_id,OLD.author_id,OLD.created_at,OLD.parent_id,OLD.depth) THEN
    RAISE EXCEPTION 'Post % cannot be moved or reassigned', OLD.id USING ERRCODE='55000';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    INSERT INTO falk_forum_post_edit(post_id,body) VALUES(OLD.id,OLD.body);
    NEW.edited_at := now();
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'Post % edit time follows its body', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
