BEGIN;

-- Direct messages between two forum members (server/messages.ts). A conversation is one pair of
-- members, stored with the lower account id first so a pair has exactly one conversation. Messages
-- are private to the two members and, like posts, never edited or deleted. Each member's read time
-- lives on the conversation; a block stops new messages in both directions.
CREATE TABLE IF NOT EXISTS falk_forum_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_a uuid NOT NULL REFERENCES falk_account(id),
  member_b uuid NOT NULL REFERENCES falk_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  read_a timestamptz,
  read_b timestamptz,
  CHECK (member_a < member_b),
  UNIQUE (member_a, member_b)
);
CREATE INDEX IF NOT EXISTS falk_forum_conversation_a ON falk_forum_conversation(member_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS falk_forum_conversation_b ON falk_forum_conversation(member_b, last_message_at DESC);

CREATE TABLE IF NOT EXISTS falk_forum_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES falk_forum_conversation(id),
  sender_id uuid NOT NULL REFERENCES falk_account(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  -- Clock time, as for posts, so messages written in one transaction keep their order.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS falk_forum_message_conversation ON falk_forum_message(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS falk_forum_message_sender ON falk_forum_message(sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS falk_forum_block (
  blocker_id uuid NOT NULL REFERENCES falk_account(id),
  blocked_id uuid NOT NULL REFERENCES falk_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE OR REPLACE TRIGGER falk_forum_message_immutable BEFORE UPDATE OR DELETE ON falk_forum_message
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_forum_message_truncate_guard BEFORE TRUNCATE ON falk_forum_message
  FOR EACH STATEMENT EXECUTE FUNCTION falk_immutable_history();

-- Conversations: the pair and when it began are fixed, and last_message_at only moves forward.
CREATE OR REPLACE FUNCTION falk_guard_forum_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Conversations are never deleted' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.member_a,NEW.member_b,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.member_a,OLD.member_b,OLD.created_at)
     OR NEW.last_message_at < OLD.last_message_at THEN
    RAISE EXCEPTION 'Conversation % cannot be rewritten', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_conversation_guard BEFORE UPDATE OR DELETE ON falk_forum_conversation
  FOR EACH ROW EXECUTE FUNCTION falk_guard_forum_conversation();
CREATE OR REPLACE TRIGGER falk_forum_conversation_truncate_guard BEFORE TRUNCATE ON falk_forum_conversation
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_forum_conversation();

-- A new message moves its conversation to the top, and counts as read by its sender.
CREATE OR REPLACE FUNCTION falk_forum_message_bumps_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE falk_forum_conversation SET last_message_at=greatest(last_message_at,NEW.created_at),
    read_a=CASE WHEN member_a=NEW.sender_id THEN NEW.created_at ELSE read_a END,
    read_b=CASE WHEN member_b=NEW.sender_id THEN NEW.created_at ELSE read_b END
    WHERE id=NEW.conversation_id;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER falk_forum_message_bump AFTER INSERT ON falk_forum_message
  FOR EACH ROW EXECUTE FUNCTION falk_forum_message_bumps_conversation();

COMMIT;
