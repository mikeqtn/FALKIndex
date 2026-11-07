import type { PoolClient } from 'pg';
import { newWatchInput, type Account, type NewWatchInput } from '../src/accounts/contracts.ts';
import { DIMENSIONS, Organization, Source, Watch } from '../src/schema.ts';
import { planPublish } from '../scripts/publish-record.ts';
import type { check } from '../scripts/validate.ts';
import { HttpError } from './accounts.ts';

// New watches are proposed by members and published by an editor (DECISIONS.md Q16).
type Catalogue = ReturnType<typeof check>['parsed'];
// The methodology the site scores with; src/lib/data.ts reads the same one.
export const CURRENT_METHODOLOGY = 'v0.2';
const PRIMARY = new Set(['manufacturer', 'workshop', 'supplier_disclosure']);

export function slugify(text: string) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
/** `base`, or `base-2`, `base-3`… whichever is not taken. */
function freeId(base: string, taken: (id: string) => boolean) {
  for (let n = 1; ; n++) { const id = n === 1 ? base : `${base}-${n}`; if (!taken(id)) return id; }
}
/** Drop empty optional fields: the schemas are strict and treat '' as a value. */
const some = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== '' && v !== undefined));

/** The record id a proposal would publish to, and whether its brand is new. Refuses ids that are taken. */
export function proposedIdentity(input: NewWatchInput, live: Catalogue) {
  const existing = 'id' in input.brand;
  const brandId = 'id' in input.brand ? input.brand.id : slugify(input.brand.name);
  const brandName = 'id' in input.brand ? live.orgs.get(brandId)?.name : input.brand.name;
  if (!brandId || !slugify(input.model)) throw new HttpError(400, 'Write the brand and model names with Latin letters or numbers.');
  if (existing && !brandName) throw new HttpError(400, 'Choose a brand from the list.');
  if (!existing && live.orgs.has(brandId)) {
    throw new HttpError(409, `FALK already lists ${live.orgs.get(brandId)!.name}. Choose it from the brand list instead.`);
  }
  const id = `${brandId}/${slugify(input.model)}`;
  if (live.watches.some(w => w.id === id)) throw new HttpError(409, `FALK already has a record for ${brandName} ${input.model}. Suggest an edit on that record instead.`);
  return { id, brandId, brandName: brandName!, newBrand: !existing };
}

/**
 * Turn a proposal into the record version 1 it publishes as: every dimension U, confidence D (EDITORIAL.md §6),
 * written by the contributor. `checkedOn` is the day the contributor read the sources; `today` the publication date.
 */
export function buildNewWatch(input: NewWatchInput, live: Catalogue, ctx: { username: string; archetype: string; checkedOn: string; today: string }) {
  const { id, brandId } = proposedIdentity(input, live);
  const modelSlug = id.split('/')[1];
  const organization = 'name' in input.brand
    ? Organization.parse(some({ id: brandId, name: input.brand.name, kind: input.brand.kind, country: input.brand.country, website: input.brand.website }))
    : undefined;

  // A source FALK already has is reused by URL, so one page is never listed twice.
  const sources = new Map<string, Source>();
  const sourceFor = (claim: NewWatchInput['claims'][number]) => {
    const known = [...live.sources.values(), ...sources.values()].find(s => s.url === claim.url);
    if (known) return known.id;
    const source = Source.parse(some({
      id: freeId(`${brandId}-${modelSlug}-source`, s => live.sources.has(s) || sources.has(s)),
      url: claim.url, title: claim.title, source_type: claim.sourceType, tier: PRIMARY.has(claim.sourceType) ? 'primary' : 'secondary',
    }));
    sources.set(source.id, source);
    return source.id;
  };
  const claimIds = new Set(live.watches.flatMap(w => w.claims.map(c => c.id)));
  const claims = input.claims.map((c, i) => {
    const claimId = freeId(`${brandId}-${modelSlug}-${i + 1}`, x => claimIds.has(x));
    claimIds.add(claimId);
    return some({ id: claimId, statement: c.statement, excerpt: c.excerpt, source: sourceFor(c), dimensions: c.dimensions,
      date_checked: ctx.checkedOn, editor: ctx.username, status: 'active' });
  });
  const watch = Watch.parse({
    ...some({ id, brand: brandId, model: input.model, reference: input.reference, generation: input.generation,
      caliber: input.caliber, production_start: input.productionStart, production_end: input.productionEnd, notes: input.notes }),
    provenance: [], claims,
    profiles: [{
      version: 1, methodology: CURRENT_METHODOLOGY, confidence: 'D', independent_watchmaker: false, status: 'published',
      is_seed: false, editor: ctx.username, change_note: input.explanation, created_on: ctx.today,
      scores: Object.fromEntries(DIMENSIONS.map(d => [d, { value: null, evidence: [] }])),
      classification: [ctx.archetype],
    }],
  });
  return { watch, organization, sources: [...sources.values()] };
}

/** The live catalogue with the proposal added, planned exactly as `npm run db:publish` would plan it. */
export function planNewWatch(live: Catalogue, built: ReturnType<typeof buildNewWatch>) {
  const local: Catalogue = {
    ...live,
    orgs: new Map([...live.orgs, ...(built.organization ? [[built.organization.id, built.organization] as const] : [])]),
    sources: new Map([...live.sources, ...built.sources.map(s => [s.id, s] as const)]),
    watches: [...live.watches, built.watch],
  };
  try { return planPublish(live, local, built.watch.id); }
  catch (e) { throw new HttpError(409, (e as Error).message); }
}

/** Any archetype in the current methodology; intake checks the whole record with it, the editor picks the real one. */
export const anyArchetype = (live: Catalogue) =>
  live.methodologies.get(CURRENT_METHODOLOGY)!.classifications.find(c => c.kind === 'archetype')!.code;
export const isArchetype = (live: Catalogue, code: string) =>
  live.methodologies.get(CURRENT_METHODOLOGY)!.classifications.some(c => c.kind === 'archetype' && c.code === code);

/** Save a member's proposal. The public catalogue does not change until an editor approves it. */
export async function saveNewWatch(account: Account, body: unknown, live: Catalogue, db: Pick<PoolClient, 'query'>) {
  const input = newWatchInput.parse(body);
  if (!account.username) throw new HttpError(403, 'Choose a public username on your account page before proposing a watch.');
  const today = new Date().toISOString().slice(0, 10);
  // Build and plan it now, so a proposal that could never publish is refused while the member is still here.
  planNewWatch(live, buildNewWatch(input, live, { username: account.username, archetype: anyArchetype(live), checkedOn: today, today }));
  const { id, brandName } = proposedIdentity(input, live);
  const result = await db.query(
    `INSERT INTO falk_submission(author_id,target_kind,watch_id,base_revision_id,original_proposal,explanation,evidence)
     VALUES($1,'watch',NULL,NULL,$2,$3,$4) RETURNING id`,
    [account.id, JSON.stringify({ type: 'new_watch', proposedId: id, proposedName: `${brandName} ${input.model}`, input }),
      input.explanation, JSON.stringify([...new Set(input.claims.map(c => c.url))])],
  );
  return { id: result.rows[0].id as string, proposedId: id };
}
