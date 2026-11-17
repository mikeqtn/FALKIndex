BEGIN;

-- A member can delete a conversation for themselves only (server/messages.ts clearConversation). Nothing is
-- removed: each member has a cleared time, and sees only the messages after it. The other member keeps the whole
-- conversation, and a new message from either side brings it back to the inbox with only what came after.
ALTER TABLE falk_forum_conversation ADD COLUMN IF NOT EXISTS cleared_a timestamptz;
ALTER TABLE falk_forum_conversation ADD COLUMN IF NOT EXISTS cleared_b timestamptz;

-- Replaces the guard from 013, adding that a cleared time only moves forward, so cleared messages stay cleared.
CREATE OR REPLACE FUNCTION falk_guard_forum_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Conversations are never deleted' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.member_a,NEW.member_b,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.member_a,OLD.member_b,OLD.created_at)
     OR NEW.last_message_at < OLD.last_message_at
     OR NEW.cleared_a < OLD.cleared_a OR (OLD.cleared_a IS NOT NULL AND NEW.cleared_a IS NULL)
     OR NEW.cleared_b < OLD.cleared_b OR (OLD.cleared_b IS NOT NULL AND NEW.cleared_b IS NULL) THEN
    RAISE EXCEPTION 'Conversation % cannot be rewritten', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
