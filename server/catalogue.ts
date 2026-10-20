import { check } from '../scripts/validate.ts';
import { querySeries, transaction } from './db.ts';
import type { Watch } from '../src/schema.ts';

/** Reconstruct the existing public schema, never member/private/moderation tables. */
export async function loadCatalogue() {
  return transaction(async pool => {
  const [
    methods,organizations,sources,storedWatches,claims,provenance,profiles,scores,evidence,
  ] = await querySeries(pool,[
    'SELECT id,payload FROM falk_methodology ORDER BY id',
    'SELECT id,payload FROM falk_organization ORDER BY id',
    'SELECT id,payload FROM falk_source ORDER BY id',
    'SELECT id,payload FROM falk_watch ORDER BY id',
    `SELECT l.watch_id,c.payload FROM falk_watch_claim l JOIN falk_claim c ON c.id=l.claim_id ORDER BY l.watch_id,l.position`,
    `SELECT p.*,coalesce((SELECT jsonb_agg(c.claim_id ORDER BY c.position) FROM falk_provenance_claim c
      WHERE c.provenance_id=p.id),'[]') AS claims FROM falk_provenance p ORDER BY p.watch_id,p.position`,
    'SELECT watch_id,version,status,payload FROM falk_profile_version ORDER BY watch_id,version',
    'SELECT watch_id,version,dimension,value,rationale FROM falk_dimension_score',
    'SELECT watch_id,version,dimension,claim_id,stance,note FROM falk_score_evidence ORDER BY position,id',
  ]);
  if (!storedWatches.rowCount) throw new Error('The catalogue has not been imported. Run the explicit catalogue import before serving.');
  const watches = storedWatches.rows.map(w => ({
    ...w.payload,
    claims:claims.rows.filter(c => c.watch_id===w.id).map(c => c.payload),
    provenance:provenance.rows.filter(p => p.watch_id===w.id).map(p => ({...p.payload,claims:p.claims})),
    profiles:profiles.rows.filter(p => p.watch_id===w.id).map(p => ({
      ...p.payload,status:p.status,
      scores:Object.fromEntries(scores.rows.filter(s => s.watch_id===w.id && s.version===p.version).map(s => [
        s.dimension,{value:s.value,...(s.rationale === null ? {} : {rationale:s.rationale}),evidence:evidence.rows
          .filter(e => e.watch_id===w.id && e.version===p.version && e.dimension===s.dimension)
          .map(e => ({claim:e.claim_id,stance:e.stance,...(e.note === null ? {} : {note:e.note})}))},
      ])),
    })),
  })) as Watch[];
  const validated = check({
    methodologies:methods.rows.map(r => ({file:`methodology/${r.id}.yaml`,value:r.payload})),
    organizations:organizations.rows.map(r => ({file:`organizations/${r.id}.yaml`,value:r.payload})),
    sources:sources.rows.map((r,i) => ({file:`sources.yaml[${i}]`,value:r.payload})),
    watches:watches.map(w => ({file:`watches/${w.id}.yaml`,value:w})),
  });
  if (validated.errors.length) throw new Error(`Database catalogue validation failed:\n${validated.errors.join('\n')}`);
  return validated.parsed;
  },true);
}
