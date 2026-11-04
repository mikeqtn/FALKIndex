BEGIN;

-- The spam checks read a member's recent posts and threads each time they post (server/forum.ts).
CREATE INDEX IF NOT EXISTS falk_forum_post_author ON falk_forum_post(author_id, created_at);
CREATE INDEX IF NOT EXISTS falk_forum_thread_author ON falk_forum_thread(author_id, created_at);

COMMIT;
