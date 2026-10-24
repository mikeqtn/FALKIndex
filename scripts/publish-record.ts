import { isDeepStrictEqual, parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { check, load } from './validate.ts';
import { loadCatalogue } from '../server/catalogue.ts';
import { pool, transaction } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { DIMENSIONS, type Watch } from '../src/schema.ts';

// Publishes one record's edited YAML (EDITORIAL.md §7) into the live catalogue.
// Usage: npm run db:publish -- <brand/model> --reviewer <username> [--apply]
//        npm run db:publish -- --all --reviewer <username> [--apply]   every record that differs from the live catalogue
// Without --apply it only prints the plan. History is append-only: existing
// profile versions and claims are never rewritten, only moved forward.

type Catalogue = Awaited<ReturnType<typeof loadCatalogue>>;
const forward: Record<string, string[]> = { draft: ['published', 'superseded'], published: ['superseded'], superseded: [] };
// What a claim may change after it is published: its status, and the reviewer taking over an ai-draft.
const claimCore = ({ status, superseded_by, date_checked, editor, ...c }: Watch['claims'][number]) => c;
const profileCore = ({ status, ...p }: Watch['profiles'][number]) => p;

export function planPublish(live: Catalogue, local: Catalogue, id: string) {
  const next = local.watches.find(w => w.id === id);
  if (!next) throw new Error(`data/watches/${id}.yaml not found`);
  const current = live.watches.find(w => w.id === id);
  if (isDeepStrictEqual(next, current)) throw new Error(`${id} already matches the live catalogue; nothing to publish.`);
  const problems: string[] = [];
  const changes: string[] = current ? [] : ['new record'];

  for (const old of current?.profiles ?? []) {
    const now = next.profiles.find(p => p.version === old.version);
    if (!now) { problems.push(`version ${old.version} was removed`); continue; }
    if (!isDeepStrictEqual(profileCore(now), profileCore(old))) problems.push(`version ${old.version} was edited; add a new version instead`);
    if (now.status === old.status) continue;
    if (!forward[old.status].includes(now.status)) problems.push(`version ${old.version} cannot go from ${old.status} to ${now.status}`);
    changes.push(`version ${old.version}: ${old.status} → ${now.status}`);
  }
  const added = next.profiles.filter(p => !current?.profiles.some(o => o.version === p.version));
  for (const p of added) changes.push(`add version ${p.version} (${p.status}, by ${p.editor})`);

  for (const old of current?.claims ?? []) {
    const now = next.claims.find(c => c.id === old.id);
    if (!now) { problems.push(`claim "${old.id}" was removed; mark it superseded instead`); continue; }
    if (!isDeepStrictEqual(claimCore(now), claimCore(old)) || (now.editor !== old.editor && old.editor !== 'ai-draft'))
      problems.push(`claim "${old.id}" was edited; supersede it with a new claim instead`);
    else if (!isDeepStrictEqual(now, old)) changes.push(`claim "${old.id}": ${now.editor !== old.editor ? `verified by ${now.editor}` : 'status updated'}`);
  }
  for (const c of next.claims) if (!current?.claims.some(o => o.id === c.id)) changes.push(`add claim "${c.id}"`);
  if (current && !isDeepStrictEqual(next.provenance, current.provenance)) changes.push(`provenance: ${current.provenance.length} → ${next.provenance.length} entries`);
  const meta = ({ claims, profiles, provenance, ...m }: Watch) => m;
  if (current && !isDeepStrictEqual(meta(next), meta(current))) changes.push('record details changed');

  // Sources and organizations this record relies on, taken from data/ where they are new or edited.
  const sources = [...new Set(next.claims.map(c => c.source))].map(s => local.sources.get(s)!)
    .filter(s => !isDeepStrictEqual(s, live.sources.get(s.id)));
  const orgIds = new Set([next.brand, ...next.provenance.flatMap(p => p.performer ?? []), ...sources.flatMap(s => s.publisher ?? [])]);
  for (const o of orgIds) { const parent = local.orgs.get(o)?.parent; if (parent) orgIds.add(parent); }
  const orgs = [...orgIds].map(o => local.orgs.get(o)!).filter(o => !isDeepStrictEqual(o, live.orgs.get(o.id)));
  for (const s of sources) changes.push(`${live.sources.has(s.id) ? 'update' : 'add'} source "${s.id}"`);
  for (const o of orgs) changes.push(`${live.orgs.has(o.id) ? 'update' : 'add'} organization "${o.id}"`);

  // Validate the whole catalogue as it would be after publishing.
  const merged = check({
    methodologies: [...live.methodologies].map(([m, value]) => ({ file: `methodology/${m}.yaml`, value })),
    organizations: [...new Map([...live.orgs, ...orgs.map(o => [o.id, o] as const)]).values()].map(value => ({ file: `organizations/${value.id}.yaml`, value })),
    sources: [...new Map([...live.sources, ...sources.map(s => [s.id, s] as const)]).values()].map((value, i) => ({ file: `sources.yaml[${i}]`, value })),
    watches: [...live.watches.filter(w => w.id !== id), next].map(value => ({ file: `watches/${value.id}.yaml`, value })),
  });
  problems.push(...merged.errors);
  if (problems.length) throw new Error(`Cannot publish ${id}:\n- ${problems.join('\n- ')}`);
  const authors = [...added, ...next.profiles.filter(p => current?.profiles.some(o => o.version === p.version && o.status !== p.status))].map(p => p.editor);
  return { id, current, next, added, sources, orgs, changes, authors, warnings: merged.warnings.filter(w => w.startsWith(`watches/${id}.yaml`)) };
}
type Plan = ReturnType<typeof planPublish>;

// Records in data/ that are new or differ from the live catalogue, in file order.
export const changedIds = (live: Catalogue, local: Catalogue) =>
  local.watches.filter(w => !isDeepStrictEqual(w, live.watches.find(l => l.id === w.id))).map(w => w.id);

// Sources and organizations edited on their own, such as an archived copy added later, which no changed record carries.
export function planReferences(live: Catalogue, local: Catalogue) {
  const sources = [...local.sources.values()].filter(s => !isDeepStrictEqual(s, live.sources.get(s.id)));
  const orgs = [...local.orgs.values()].filter(o => !isDeepStrictEqual(o, live.orgs.get(o.id)));
  const merged = check({
    methodologies: [...live.methodologies].map(([m, value]) => ({ file: `methodology/${m}.yaml`, value })),
    organizations: [...new Map([...live.orgs, ...orgs.map(o => [o.id, o] as const)]).values()].map(value => ({ file: `organizations/${value.id}.yaml`, value })),
    sources: [...new Map([...live.sources, ...sources.map(s => [s.id, s] as const)]).values()].map((value, i) => ({ file: `sources.yaml[${i}]`, value })),
    watches: live.watches.map(value => ({ file: `watches/${value.id}.yaml`, value })),
  });
  if (merged.errors.length) throw new Error(`Cannot publish sources and organizations:\n- ${merged.errors.join('\n- ')}`);
  return { sources, orgs, changes: [...sources.map(s => `${live.sources.has(s.id) ? 'update' : 'add'} source "${s.id}"`), ...orgs.map(o => `${live.orgs.has(o.id) ? 'update' : 'add'} organization "${o.id}"`)] };
}

export async function applyPublish(db: PoolClient, plan: Plan, reviewer: string, revision: string | null) {
  const { id, next } = plan;
  if (plan.authors.includes(reviewer)) throw new Error(`@${reviewer} wrote a version being published and cannot review it (DECISIONS.md Q13).`);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:watch:${id}`]);
  const account = (await db.query(`SELECT id FROM falk_account WHERE realm=$1 AND username=$2 AND status='active'
    AND email_verified AND role IN ('editor','admin')`, [realm(), reviewer])).rows[0];
  if (!account) throw new Error(`@${reviewer} is not an active, verified editor or admin in this environment.`);
  const row = (await db.query('SELECT current_revision_id FROM falk_watch WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if ((row?.current_revision_id ?? null) !== revision) throw new Error(`${id} changed while this plan was prepared. Run it again.`);

  for (const o of plan.orgs) await db.query('INSERT INTO falk_organization(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [o.id, o]);
  for (const s of plan.sources) await db.query('INSERT INTO falk_source(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [s.id, s]);
  const { claims, profiles, provenance, ...metadata } = next;
  await db.query('INSERT INTO falk_watch(id,brand_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET brand_id=EXCLUDED.brand_id,payload=EXCLUDED.payload', [id, next.brand, metadata]);

  await db.query('DELETE FROM falk_watch_claim WHERE watch_id=$1', [id]);
  for (const [position, claim] of claims.entries()) {
    await db.query('INSERT INTO falk_claim(id,source_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [claim.id, claim.source, claim]);
    await db.query('INSERT INTO falk_watch_claim(watch_id,claim_id,position) VALUES($1,$2,$3)', [id, claim.id, position]);
  }
  await db.query('DELETE FROM falk_provenance_claim WHERE provenance_id IN (SELECT id FROM falk_provenance WHERE watch_id=$1)', [id]);
  await db.query('DELETE FROM falk_provenance WHERE watch_id=$1', [id]);
  for (const [position, entry] of provenance.entries()) {
    const { claims: claimIds, ...payload } = entry;
    const { rows } = await db.query('INSERT INTO falk_provenance(watch_id,performer_id,position,payload) VALUES($1,$2,$3,$4) RETURNING id', [id, entry.performer ?? null, position, payload]);
    for (const [claimPosition, claimId] of claimIds.entries()) await db.query('INSERT INTO falk_provenance_claim(provenance_id,claim_id,position) VALUES($1,$2,$3)', [rows[0].id, claimId, claimPosition]);
  }

  // Supersede before publishing: only one published profile per record is allowed.
  const moved = profiles.filter(p => plan.current?.profiles.some(o => o.version === p.version && o.status !== p.status))
    .sort((a, b) => (a.status === 'published' ? 1 : 0) - (b.status === 'published' ? 1 : 0));
  for (const p of moved) await db.query(`UPDATE falk_profile_version SET status=$3,payload=payload||jsonb_build_object('status',$3::text) WHERE watch_id=$1 AND version=$2`, [id, p.version, p.status]);
  for (const profile of plan.added) {
    const { scores, ...payload } = profile;
    await db.query('INSERT INTO falk_profile_version(watch_id,version,methodology_id,status,payload) VALUES($1,$2,$3,$4,$5)', [id, profile.version, profile.methodology, profile.status, payload]);
    for (const code of DIMENSIONS) {
      const score = scores[code];
      await db.query('INSERT INTO falk_dimension_score(watch_id,version,dimension,value,rationale) VALUES($1,$2,$3,$4,$5)', [id, profile.version, code, score.value, score.rationale ?? null]);
      for (const [position, evidence] of score.evidence.entries())
        await db.query('INSERT INTO falk_score_evidence(watch_id,version,dimension,claim_id,stance,note,position) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, profile.version, code, evidence.claim, evidence.stance, evidence.note ?? null, position]);
    }
  }

  const author = plan.added.at(-1)?.editor;
  const actor = author ? (await db.query('SELECT id FROM falk_account WHERE realm=$1 AND username=$2', [realm(), author])).rows[0]?.id ?? null : null;
  const reason = plan.added.map(p => p.change_note).join(' ') || `Reviewed by @${reviewer}: ${plan.changes.join('; ')}.`;
  const { rows } = await db.query(`INSERT INTO falk_revision(watch_id,parent_id,actor_id,reviewer_id,before_payload,after_payload,reason,kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,'approval') RETURNING id`, [id, revision, actor, account.id, plan.current ?? null, next, reason]);
  await db.query('UPDATE falk_watch SET current_revision_id=$2 WHERE id=$1', [id, rows[0].id]);
}

// Plans one record against the live catalogue as it is now, and applies it in its own transaction.
async function publishOne(id: string, local: Catalogue, reviewer: string, apply: boolean) {
  // Read the revision first: if anything lands after this, applyPublish refuses.
  const revision = (await pool.query('SELECT current_revision_id FROM falk_watch WHERE id=$1', [id])).rows[0]?.current_revision_id ?? null;
  const plan = planPublish(await loadCatalogue(), local, id);
  console.log(`${id}, reviewed by @${reviewer}:\n  ${plan.changes.join('\n  ')}`);
  for (const w of plan.warnings) console.log(`warning ${w}`);
  if (apply) { await transaction(db => applyPublish(db, plan, reviewer, revision)); console.log('  Published.'); }
}

// import.meta.main arrived in Node 24.2; on earlier versions (package.json allows 23.6+) compare paths instead.
if (import.meta.main ?? resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values, positionals: [id] } = parseArgs({ allowPositionals: true, options: { reviewer: { type: 'string' }, apply: { type: 'boolean', default: false }, all: { type: 'boolean', default: false } } });
  try {
    if (!values.reviewer || !id === !values.all) throw new Error('Usage: npm run db:publish -- <brand/model> --reviewer <username> [--apply]\n       npm run db:publish -- --all --reviewer <username> [--apply]');
    const local = check(load('data'));
    if (local.errors.length) throw new Error(`data/ is invalid:\n${local.errors.join('\n')}`);
    if (id) await publishOne(id, local.parsed, values.reviewer, values.apply);
    else {
      // One record at a time, each against the live catalogue as the previous ones left it. A record that
      // cannot be published is reported and skipped; the rest still go ahead.
      const ids = changedIds(await loadCatalogue(), local.parsed);
      const failed: string[] = [];
      for (const each of ids) {
        try { await publishOne(each, local.parsed, values.reviewer, values.apply); }
        catch (e) { failed.push(each); console.error(`${each}: ${(e as Error).message}`); }
        console.log('');
      }
      console.log(`${ids.length} record(s) differ from the live catalogue; ${ids.length - failed.length} ${values.apply ? 'published' : 'ready'}, ${failed.length} blocked.`);
      // In a dry run the records above were not written, so their own sources still show here.
      const refs = planReferences(await loadCatalogue(), local.parsed);
      if (refs.changes.length) {
        console.log(`\nSources and organizations:\n  ${refs.changes.join('\n  ')}`);
        if (values.apply) await transaction(async db => {
          for (const o of refs.orgs) await db.query('INSERT INTO falk_organization(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [o.id, o]);
          for (const s of refs.sources) await db.query('INSERT INTO falk_source(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [s.id, s]);
        });
      }
      if (failed.length) process.exitCode = 1;
    }
    if (!values.apply) console.log('Dry run. Nothing was written; add --apply to publish.');
  } catch (e) { console.error((e as Error).message || e); process.exitCode = 1; }
  finally { await pool.end(); }
}
