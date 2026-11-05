BEGIN;

-- Each index serves a query that otherwise reads the whole table.
-- Forum home: recentThreads.
CREATE INDEX IF NOT EXISTS falk_forum_thread_recent ON falk_forum_thread(last_post_at DESC, id) WHERE hidden_at IS NULL;
-- Public profiles: publicProfile's contribution counts and activity lists.
CREATE INDEX IF NOT EXISTS falk_submission_author ON falk_submission(author_id, status) WHERE author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS falk_revision_actor ON falk_revision(actor_id, created_at DESC) WHERE kind<>'import';
CREATE INDEX IF NOT EXISTS falk_audit_actor_public ON falk_audit_event(actor_id, created_at DESC) WHERE public;
-- Every signed-in request: the check for a waiting invitation in unchangedAccount.
CREATE INDEX IF NOT EXISTS falk_invitation_open ON falk_invitation(realm, email) WHERE accepted_by IS NULL;

COMMIT;
