BEGIN;

-- One vote per member per comment. Readers see only the total, and taking a vote back removes its row.
CREATE TABLE IF NOT EXISTS falk_forum_vote (
  post_id uuid NOT NULL REFERENCES falk_forum_post(id),
  account_id uuid NOT NULL REFERENCES falk_account(id),
  value smallint NOT NULL CHECK (value IN (-1,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, account_id)
);

-- Why a member was notified. Rows from before this column have no kind: those told everyone in a
-- thread about every reply, so the inbox keeps only the ones on threads the member started.
ALTER TABLE falk_forum_notification ADD COLUMN IF NOT EXISTS kind text CHECK (kind IN ('thread','comment'));

COMMIT;
