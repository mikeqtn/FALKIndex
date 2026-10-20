BEGIN;

-- Preserve the existing member-owned submissions while allowing the public
-- corrections form to accept guest submissions without an account.
ALTER TABLE falk_submission ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE falk_submission ADD COLUMN IF NOT EXISTS submitter_name text
  CHECK (char_length(submitter_name) <= 150);
ALTER TABLE falk_submission ADD COLUMN IF NOT EXISTS submitter_email text
  CHECK (char_length(submitter_email) <= 254);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='falk_submission_guest_watch_only' AND conrelid='falk_submission'::regclass) THEN
    ALTER TABLE falk_submission ADD CONSTRAINT falk_submission_guest_watch_only
      CHECK (author_id IS NOT NULL OR target_kind='watch');
  END IF;
END $$;
COMMENT ON COLUMN falk_submission.submitter_name IS 'Private contact attribution for anonymous submissions; never included in public profile responses.';
COMMENT ON COLUMN falk_submission.submitter_email IS 'Private reply address for anonymous submissions; never included in public profile responses.';

COMMIT;
