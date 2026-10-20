import { createHash } from 'node:crypto';
import { check, load } from './validate.ts';
import { DIMENSIONS } from '../src/schema.ts';
import { pool, transaction } from '../server/db.ts';

// Explicit import, never called by the application or its start command.
const checked = check(load('data'));
if (checked.errors.length) throw new Error(checked.errors.join('\n'));
const { methodologies, orgs, sources, watches } = checked.parsed;
const checksum = createHash('sha256').update(JSON.stringify({
  methodologies: [...methodologies], orgs: [...orgs], sources: [...sources], watches,
})).digest('hex');
try {
  await transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('falk:catalogue-import'))");
    if ((await db.query('SELECT 1 FROM falk_catalogue_import WHERE checksum=$1', [checksum])).rowCount) {
      console.log('This catalogue import was already completed; no changes made.');
      return;
    }
    if (Number((await db.query('SELECT count(*) FROM falk_watch')).rows[0].count) > 0) {
      throw new Error('Catalogue already contains records. Refusing to overwrite live editorial data.');
    }
    for (const [id, payload] of methodologies) await db.query('INSERT INTO falk_methodology(id,payload) VALUES($1,$2)', [id,payload]);
    for (const [id, payload] of orgs) await db.query('INSERT INTO falk_organization(id,payload) VALUES($1,$2)', [id,payload]);
    for (const [id, payload] of sources) await db.query('INSERT INTO falk_source(id,payload) VALUES($1,$2)', [id,payload]);
    for (const watch of watches) {
      const { claims, profiles, provenance, ...metadata } = watch;
      await db.query('INSERT INTO falk_watch(id,brand_id,payload) VALUES($1,$2,$3)', [watch.id,watch.brand,metadata]);
      for (const [position, claim] of claims.entries()) {
        await db.query('INSERT INTO falk_claim(id,source_id,payload) VALUES($1,$2,$3)', [claim.id,claim.source,claim]);
        await db.query('INSERT INTO falk_watch_claim(watch_id,claim_id,position) VALUES($1,$2,$3)', [watch.id,claim.id,position]);
      }
      for (const [position, entry] of provenance.entries()) {
        const { claims: claimIds, ...payload } = entry;
        const { rows } = await db.query('INSERT INTO falk_provenance(watch_id,performer_id,position,payload) VALUES($1,$2,$3,$4) RETURNING id', [watch.id,entry.performer ?? null,position,payload]);
        for (const [claimPosition,claimId] of claimIds.entries()) await db.query('INSERT INTO falk_provenance_claim(provenance_id,claim_id,position) VALUES($1,$2,$3)', [rows[0].id,claimId,claimPosition]);
      }
      for (const profile of profiles) {
        const { scores, ...payload } = profile;
        await db.query('INSERT INTO falk_profile_version(watch_id,version,methodology_id,status,payload) VALUES($1,$2,$3,$4,$5)', [watch.id,profile.version,profile.methodology,profile.status,payload]);
        for (const code of DIMENSIONS) {
          const score = scores[code];
          await db.query('INSERT INTO falk_dimension_score(watch_id,version,dimension,value,rationale) VALUES($1,$2,$3,$4,$5)', [watch.id,profile.version,code,score.value,score.rationale]);
          for (const [position, evidence] of score.evidence.entries()) {
            await db.query('INSERT INTO falk_score_evidence(watch_id,version,dimension,claim_id,stance,note,position) VALUES($1,$2,$3,$4,$5,$6,$7)', [watch.id,profile.version,code,evidence.claim,evidence.stance,evidence.note ?? null,position]);
          }
        }
      }
      const revision = await db.query("INSERT INTO falk_revision(watch_id,after_payload,reason,kind) VALUES($1,$2,'Initial validated YAML import; original editorial attribution preserved','import') RETURNING id", [watch.id,watch]);
      await db.query('UPDATE falk_watch SET current_revision_id=$2 WHERE id=$1', [watch.id,revision.rows[0].id]);
    }
    await db.query('INSERT INTO falk_catalogue_import(checksum,watches,organizations,sources) VALUES($1,$2,$3,$4)', [checksum,watches.length,orgs.size,sources.size]);
    console.log(`Imported ${watches.length} watches, ${orgs.size} organizations and ${sources.size} sources atomically.`);
  });
} finally { await pool.end(); }
