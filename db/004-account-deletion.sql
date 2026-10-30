BEGIN;

-- A member can delete their account (deleteAccount in server/accounts.ts). Their personal details are
-- erased and their sign-in is closed, but the row stays, marked here, so contributions and the audit
-- history keep an author, shown as a deleted member.
ALTER TABLE falk_account ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMIT;
