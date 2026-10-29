BEGIN;

-- The FALK Forum (forum.falkindex.com). Members post under their FALK account. Nothing is
-- deleted: moderators hide posts and threads with a reason, an edited post keeps its earlier
-- text, and a report is resolved once. Moderation decisions are also written to falk_audit_event.
CREATE TABLE IF NOT EXISTS falk_forum_category (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  description text NOT NULL,
  position integer NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_forum_thread (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id text NOT NULL REFERENCES falk_forum_category(id),
  author_id uuid NOT NULL REFERENCES falk_account(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 150),
  watch_id text REFERENCES falk_watch(id),
  pinned boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  hidden_at timestamptz,
  hidden_by uuid REFERENCES falk_account(id),
  hidden_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_post_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED,
  CHECK (num_nulls(hidden_at,hidden_by,hidden_reason) IN (0,3))
);
CREATE INDEX IF NOT EXISTS falk_forum_thread_listing ON falk_forum_thread(category_id, pinned DESC, last_post_at DESC);
CREATE INDEX IF NOT EXISTS falk_forum_thread_watch ON falk_forum_thread(watch_id) WHERE watch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS falk_forum_thread_search ON falk_forum_thread USING gin(search);
CREATE TABLE IF NOT EXISTS falk_forum_post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES falk_forum_thread(id),
  author_id uuid NOT NULL REFERENCES falk_account(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  hidden_at timestamptz,
  hidden_by uuid REFERENCES falk_account(id),
  hidden_reason text,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  CHECK (num_nulls(hidden_at,hidden_by,hidden_reason) IN (0,3))
);
CREATE INDEX IF NOT EXISTS falk_forum_post_thread ON falk_forum_post(thread_id, created_at);
CREATE INDEX IF NOT EXISTS falk_forum_post_search ON falk_forum_post USING gin(search);
-- Earlier text of edited posts, written by the post guard below.
CREATE TABLE IF NOT EXISTS falk_forum_post_edit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES falk_forum_post(id),
  body text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS falk_forum_post_edit_post ON falk_forum_post_edit(post_id, replaced_at);
CREATE TABLE IF NOT EXISTS falk_forum_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES falk_forum_post(id),
  reporter_id uuid NOT NULL REFERENCES falk_account(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES falk_account(id),
  resolution text CHECK (resolution IN ('hidden','dismissed')),
  UNIQUE (post_id, reporter_id),
  CHECK (num_nulls(resolved_at,resolved_by,resolution) IN (0,3))
);
CREATE INDEX IF NOT EXISTS falk_forum_report_open ON falk_forum_report(created_at) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS falk_forum_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES falk_account(id),
  post_id uuid NOT NULL REFERENCES falk_forum_post(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (account_id, post_id)
);
CREATE INDEX IF NOT EXISTS falk_forum_notification_unread ON falk_forum_notification(account_id, created_at DESC) WHERE read_at IS NULL;

-- Threads: who started them, where and when is fixed; moderators change pinned, locked and hidden.
-- last_post_at only moves forward, from new posts.
CREATE OR REPLACE FUNCTION falk_guard_forum_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Forum threads are never deleted; hide them with a reason' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.category_id,NEW.author_id,NEW.title,NEW.watch_id,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.category_id,OLD.author_id,OLD.title,OLD.watch_id,OLD.created_at)
     OR NEW.last_post_at < OLD.last_post_at THEN
    RAISE EXCEPTION 'Thread % cannot be rewritten', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_thread_guard BEFORE UPDATE OR DELETE ON falk_forum_thread
  FOR EACH ROW EXECUTE FUNCTION falk_guard_forum_thread();
CREATE OR REPLACE TRIGGER falk_forum_thread_truncate_guard BEFORE TRUNCATE ON falk_forum_thread
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_forum_thread();

-- Posts: only the body (by its author, through the API) and the hidden fields change. Changing
-- the body files the earlier text in falk_forum_post_edit and stamps edited_at.
CREATE OR REPLACE FUNCTION falk_guard_forum_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Forum posts are never deleted; hide them with a reason' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.thread_id,NEW.author_id,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.thread_id,OLD.author_id,OLD.created_at) THEN
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
CREATE OR REPLACE TRIGGER falk_forum_post_guard BEFORE UPDATE OR DELETE ON falk_forum_post
  FOR EACH ROW EXECUTE FUNCTION falk_guard_forum_post();
CREATE OR REPLACE TRIGGER falk_forum_post_truncate_guard BEFORE TRUNCATE ON falk_forum_post
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_forum_post();

CREATE OR REPLACE FUNCTION falk_forum_post_bumps_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE falk_forum_thread SET last_post_at=greatest(last_post_at,NEW.created_at) WHERE id=NEW.thread_id;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_post_bump AFTER INSERT ON falk_forum_post
  FOR EACH ROW EXECUTE FUNCTION falk_forum_post_bumps_thread();

CREATE OR REPLACE TRIGGER falk_forum_post_edit_immutable BEFORE UPDATE OR DELETE ON falk_forum_post_edit
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_forum_post_edit_truncate_guard BEFORE TRUNCATE ON falk_forum_post_edit
  FOR EACH STATEMENT EXECUTE FUNCTION falk_immutable_history();

-- Reports: the report itself is fixed, and it is resolved exactly once.
CREATE OR REPLACE FUNCTION falk_guard_forum_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Forum reports are never deleted' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.post_id,NEW.reporter_id,NEW.reason,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.post_id,OLD.reporter_id,OLD.reason,OLD.created_at) OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Report % cannot be changed once made or resolved', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_report_guard BEFORE UPDATE OR DELETE ON falk_forum_report
  FOR EACH ROW EXECUTE FUNCTION falk_guard_forum_report();
CREATE OR REPLACE TRIGGER falk_forum_report_truncate_guard BEFORE TRUNCATE ON falk_forum_report
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_forum_report();

COMMIT;
