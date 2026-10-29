BEGIN;

-- A published claim's content is fixed (EDITORIAL.md §7): it can be superseded, never
-- edited or deleted. Only status, superseded_by and date_checked may change, and an
-- ai-draft claim may take its reviewer's handle. Superseding is final. Mirrors claimCore and
-- claimEdited in scripts/publish-record.ts, so a claim cited by many records cannot be
-- rewritten by one record's publish.
CREATE OR REPLACE FUNCTION falk_guard_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable CONSTANT text[] := ARRAY['status','superseded_by','date_checked','editor'];
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'Published claims are never deleted; mark them superseded' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Claim % is published and is never deleted; mark it superseded', OLD.id USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR (NEW.payload - mutable) IS DISTINCT FROM (OLD.payload - mutable)
     OR (NEW.payload->'editor' IS DISTINCT FROM OLD.payload->'editor'
         AND (OLD.payload->>'editor' IS DISTINCT FROM 'ai-draft' OR coalesce(NEW.payload->>'editor','') = ''))
     OR (OLD.payload->>'status' = 'superseded' AND NEW.payload->>'status' IS DISTINCT FROM 'superseded')
     OR (OLD.payload ? 'superseded_by' AND NEW.payload->'superseded_by' IS DISTINCT FROM OLD.payload->'superseded_by') THEN
    RAISE EXCEPTION 'Claim % is published and cannot be edited; supersede it with a new claim', OLD.id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_claim_guard BEFORE UPDATE OR DELETE ON falk_claim
  FOR EACH ROW EXECUTE FUNCTION falk_guard_claim();
CREATE OR REPLACE TRIGGER falk_claim_truncate_guard BEFORE TRUNCATE ON falk_claim
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_claim();

-- Profile versions are append-only in the same way (profileCore in scripts/publish-record.ts):
-- only status changes, only forward, and the payload's status follows the column.
CREATE OR REPLACE FUNCTION falk_guard_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'Profile versions are never deleted; supersede them' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Version % of % is never deleted; supersede it', OLD.version, OLD.watch_id USING ERRCODE='55000';
  END IF;
  IF NEW.watch_id IS DISTINCT FROM OLD.watch_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.methodology_id IS DISTINCT FROM OLD.methodology_id
     OR (NEW.payload - 'status') IS DISTINCT FROM (OLD.payload - 'status')
     OR NEW.payload->>'status' IS DISTINCT FROM NEW.status
     OR (NEW.status <> OLD.status AND OLD.status||'>'||NEW.status NOT IN ('draft>published','draft>superseded','published>superseded')) THEN
    RAISE EXCEPTION 'Version % of % cannot be edited; add a new version', OLD.version, OLD.watch_id USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER falk_profile_version_guard BEFORE UPDATE OR DELETE ON falk_profile_version
  FOR EACH ROW EXECUTE FUNCTION falk_guard_profile_version();
CREATE OR REPLACE TRIGGER falk_profile_version_truncate_guard BEFORE TRUNCATE ON falk_profile_version
  FOR EACH STATEMENT EXECUTE FUNCTION falk_guard_profile_version();

-- A version's scores and evidence are written once, with the version.
CREATE OR REPLACE TRIGGER falk_dimension_score_immutable BEFORE UPDATE OR DELETE ON falk_dimension_score
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_dimension_score_truncate_guard BEFORE TRUNCATE ON falk_dimension_score
  FOR EACH STATEMENT EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_score_evidence_immutable BEFORE UPDATE OR DELETE ON falk_score_evidence
  FOR EACH ROW EXECUTE FUNCTION falk_immutable_history();
CREATE OR REPLACE TRIGGER falk_score_evidence_truncate_guard BEFORE TRUNCATE ON falk_score_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION falk_immutable_history();

COMMIT;
