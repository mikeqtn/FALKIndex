BEGIN;

-- Images attached to forum posts. The bytes live in object storage under the row's id; only images the
-- server has rebuilt ever get a row. Moderators hide with a reason. Administrators can purge, which
-- deletes the bytes for good and keeps this row as the record that the image existed.
CREATE TABLE IF NOT EXISTS falk_forum_image (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id uuid NOT NULL REFERENCES falk_account(id),
  post_id uuid REFERENCES falk_forum_post(id),
  position smallint NOT NULL DEFAULT 0,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  bytes integer NOT NULL CHECK (bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  hidden_by uuid REFERENCES falk_account(id),
  hidden_reason text,
  purged_at timestamptz,
  purged_by uuid REFERENCES falk_account(id),
  CHECK (num_nulls(hidden_at,hidden_by,hidden_reason) IN (0,3)),
  CHECK (num_nulls(purged_at,purged_by) IN (0,2))
);
CREATE INDEX IF NOT EXISTS falk_forum_image_post ON falk_forum_image(post_id, position) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS falk_forum_image_unattached ON falk_forum_image(uploader_id, created_at) WHERE post_id IS NULL;

COMMIT;
