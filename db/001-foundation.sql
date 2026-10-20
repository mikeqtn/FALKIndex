-- Additive development migration. Production schema changes use Replit Publish.
CREATE TABLE IF NOT EXISTS falk_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm text NOT NULL,
  clerk_id text NOT NULL UNIQUE,
  username text,
  role text NOT NULL DEFAULT 'contributor' CHECK (role IN ('contributor','editor','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, username),
  CHECK (username IS NULL OR username ~ '^[a-z][a-z0-9_]{2,29}$')
);
CREATE TABLE IF NOT EXISTS falk_account_private (
  account_id uuid PRIMARY KEY REFERENCES falk_account(id),
  email text NOT NULL,
  real_name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS falk_member_profile (
  account_id uuid PRIMARY KEY REFERENCES falk_account(id),
  display_name text NOT NULL DEFAULT '',
  show_real_name boolean NOT NULL DEFAULT false,
  bio text NOT NULL DEFAULT '',
  qualifications text[] NOT NULL DEFAULT '{}',
  qualification_details text NOT NULL DEFAULT '',
  professional_affiliations text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS falk_methodology (
  id text PRIMARY KEY,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_organization (
  id text PRIMARY KEY,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_source (
  id text PRIMARY KEY,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_watch (
  id text PRIMARY KEY,
  brand_id text NOT NULL REFERENCES falk_organization(id),
  payload jsonb NOT NULL,
  current_revision_id uuid
);
CREATE TABLE IF NOT EXISTS falk_claim (
  id text PRIMARY KEY,
  source_id text REFERENCES falk_source(id),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_watch_claim (
  watch_id text NOT NULL REFERENCES falk_watch(id),
  claim_id text NOT NULL REFERENCES falk_claim(id),
  position integer NOT NULL,
  PRIMARY KEY (watch_id, claim_id)
);
CREATE TABLE IF NOT EXISTS falk_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id text NOT NULL REFERENCES falk_watch(id),
  performer_id text REFERENCES falk_organization(id),
  position integer NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS falk_provenance_claim (
  provenance_id uuid NOT NULL REFERENCES falk_provenance(id),
  claim_id text NOT NULL REFERENCES falk_claim(id),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (provenance_id, claim_id)
);
CREATE TABLE IF NOT EXISTS falk_profile_version (
  watch_id text NOT NULL REFERENCES falk_watch(id),
  version integer NOT NULL CHECK (version > 0),
  methodology_id text NOT NULL REFERENCES falk_methodology(id),
  status text NOT NULL CHECK (status IN ('draft','published','superseded')),
  payload jsonb NOT NULL,
  PRIMARY KEY (watch_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS falk_one_published_profile ON falk_profile_version(watch_id) WHERE status='published';
CREATE TABLE IF NOT EXISTS falk_dimension_score (
  watch_id text NOT NULL,
  version integer NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('MA','MM','EX','DH','CF','WE','PD')),
  value integer CHECK (value BETWEEN 0 AND 5),
  rationale text,
  PRIMARY KEY (watch_id,version,dimension),
  FOREIGN KEY (watch_id,version) REFERENCES falk_profile_version(watch_id,version)
);
CREATE TABLE IF NOT EXISTS falk_score_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id text NOT NULL,
  version integer NOT NULL,
  dimension text NOT NULL,
  claim_id text NOT NULL REFERENCES falk_claim(id),
  stance text NOT NULL CHECK (stance IN ('supports','contradicts','context')),
  note text,
  position integer NOT NULL,
  FOREIGN KEY (watch_id,version,dimension) REFERENCES falk_dimension_score(watch_id,version,dimension)
);
CREATE TABLE IF NOT EXISTS falk_affiliation (
  account_id uuid NOT NULL REFERENCES falk_account(id),
  organization_id text NOT NULL REFERENCES falk_organization(id),
  disclosed_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (account_id,organization_id,disclosed_at)
);
CREATE TABLE IF NOT EXISTS falk_professional_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES falk_account(id),
  label text NOT NULL,
  organization_id text REFERENCES falk_organization(id),
  evidence_url text NOT NULL,
  verified_by uuid NOT NULL REFERENCES falk_account(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text
);
CREATE TABLE IF NOT EXISTS falk_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id text NOT NULL REFERENCES falk_watch(id),
  parent_id uuid REFERENCES falk_revision(id),
  actor_id uuid REFERENCES falk_account(id),
  reviewer_id uuid REFERENCES falk_account(id),
  before_payload jsonb,
  after_payload jsonb NOT NULL,
  reason text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('import','approval','revert')),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='falk_watch_revision_fk') THEN
    ALTER TABLE falk_watch ADD CONSTRAINT falk_watch_revision_fk FOREIGN KEY (current_revision_id) REFERENCES falk_revision(id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS falk_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES falk_account(id),
  target_kind text NOT NULL CHECK (target_kind IN ('watch','organization','evidence')),
  watch_id text REFERENCES falk_watch(id),
  organization_id text REFERENCES falk_organization(id),
  base_revision_id uuid REFERENCES falk_revision(id),
  original_proposal jsonb NOT NULL,
  explanation text NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_info','approved','rejected','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_submission_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES falk_submission(id),
  actor_id uuid NOT NULL REFERENCES falk_account(id),
  proposal jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_review_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES falk_submission(id),
  actor_id uuid NOT NULL REFERENCES falk_account(id),
  action text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES falk_account(id),
  target_id uuid REFERENCES falk_account(id),
  action text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS falk_audit_target ON falk_audit_event(target_id,created_at);
CREATE TABLE IF NOT EXISTS falk_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('contributor','editor','admin')),
  created_by uuid NOT NULL REFERENCES falk_account(id),
  provider_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES falk_account(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_bootstrap (
  realm text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES falk_account(id),
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_catalogue_import (
  checksum text PRIMARY KEY,
  watches integer NOT NULL,
  organizations integer NOT NULL,
  sources integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS falk_rate_limit (
  key text NOT NULL,
  bucket bigint NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key,bucket)
);
-- Legacy seed scores may omit rationale/notes. Null means absent, not an empty claim.
ALTER TABLE falk_dimension_score ALTER COLUMN rationale DROP NOT NULL;
ALTER TABLE falk_score_evidence ALTER COLUMN note DROP NOT NULL;
ALTER TABLE falk_provenance_claim ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

-- Application-level events and published snapshots are append-only, even if a
-- future route accidentally attempts an UPDATE/DELETE. Database owners still
-- retain their ordinary operational powers.
CREATE OR REPLACE FUNCTION falk_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FALK history is append-only' USING ERRCODE='55000';
END $$;
CREATE OR REPLACE TRIGGER falk_audit_immutable BEFORE UPDATE OR DELETE ON falk_audit_event
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_revision_immutable BEFORE UPDATE OR DELETE ON falk_revision
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_amendment_immutable BEFORE UPDATE OR DELETE ON falk_submission_amendment
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_review_immutable BEFORE UPDATE OR DELETE ON falk_review_event
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_methodology_immutable BEFORE UPDATE OR DELETE ON falk_methodology
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_score_immutable BEFORE UPDATE OR DELETE ON falk_dimension_score
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_score_evidence_immutable BEFORE UPDATE OR DELETE ON falk_score_evidence
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE FUNCTION falk_guard_original_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Original submissions must be retained' USING ERRCODE='55000';
  END IF;
  IF (NEW.author_id,NEW.target_kind,NEW.watch_id,NEW.organization_id,NEW.base_revision_id,
      NEW.original_proposal,NEW.explanation,NEW.evidence,NEW.created_at) IS DISTINCT FROM
     (OLD.author_id,OLD.target_kind,OLD.watch_id,OLD.organization_id,OLD.base_revision_id,
      OLD.original_proposal,OLD.explanation,OLD.evidence,OLD.created_at) THEN
    RAISE EXCEPTION 'Original submission content is immutable; append an amendment' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_submission_original_immutable BEFORE UPDATE OR DELETE ON falk_submission
  FOR EACH ROW EXECUTE FUNCTION falk_guard_original_submission();
