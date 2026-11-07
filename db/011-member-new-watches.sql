BEGIN;

-- Guests may correct an existing record; only members propose a new one (DECISIONS.md Q16).
-- Every guest submission so far names its record, so existing rows already satisfy this.
ALTER TABLE falk_submission DROP CONSTRAINT IF EXISTS falk_submission_guest_watch_only;
ALTER TABLE falk_submission ADD CONSTRAINT falk_submission_guest_watch_only
  CHECK (author_id IS NOT NULL OR (target_kind='watch' AND watch_id IS NOT NULL));

COMMIT;
