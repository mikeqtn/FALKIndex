// Request-scoped approved catalogue. No startup snapshot or silent YAML fallback.
import { loadCatalogue } from '../../server/catalogue.ts';
import { DIMENSIONS, type Watch } from '../schema.ts';

export { DIMENSIONS };

export type Profile = Watch['profiles'][number];
export type Scores = Profile['scores'];
export type Record = Watch & { profile: Profile; draft?: Profile; brandName: string };

// A record is listed once it has a published profile. A newer draft is shown openly on the record page,
// labelled "Draft under review", next to (never in place of) the published profile.
function catalogue(parsed: Awaited<ReturnType<typeof loadCatalogue>>) {
const { methodologies,orgs,sources,watches } = parsed;
const methodology = methodologies.get('v0.2')!;
const records: Record[] = watches
  .filter(w => w.profiles.some(p => p.status === 'published'))
  .map(w => {
    const profile = w.profiles.find(p => p.status === 'published')!;
    const draft = w.profiles.findLast(p => p.status === 'draft'); // validate.ts guarantees drafts sit above the published version
    return { ...w, profile, draft, brandName: orgs.get(w.brand)!.name };
  })
  .sort((a, b) => a.brandName.localeCompare(b.brandName) || a.model.localeCompare(b.model));

const record = (id: string) => records.find(r => r.id === id)!;

const sentence = (s: string) => s[0] + s.slice(1).toLowerCase();
const dimension = Object.fromEntries(methodology.dimensions.map(d => [d.code, { ...d, label: sentence(d.name) }]));
const classification = (code: string, m = methodology.code) =>
  methodologies.get(m)!.classifications.find(c => c.code === code)!;
const appearances = (orgId: string) =>
  records.flatMap(r => r.brand === orgId ? [] : r.provenance.filter(e => e.performer === orgId).map(entry => ({ record: r, entry })));
const orgPageIds = new Set([...records.map(r => r.brand), ...records.flatMap(r => r.provenance.flatMap(e => e.performer ?? []))]);
const citedBy = (sourceId: string) => watches.filter(w => w.claims.some(c => c.source === sourceId));
return {methodologies,orgs,sources,watches,methodology,records,record,dimension,classification,appearances,orgPageIds,citedBy};
}
type Catalogue = ReturnType<typeof catalogue>;
export async function getCatalogue(locals: {catalogue?:Promise<Catalogue>} = {}): Promise<Catalogue> {
  return locals.catalogue ??= loadCatalogue().then(catalogue);
}

export const CONFIDENCE = { A: 'Strong primary evidence', B: 'Good evidence, limited gaps', C: 'Material gaps remain', D: 'Sparse or conflicting' } as const;
export const RELATIONSHIP = { internal: 'Internal', in_group: 'In-group', external_specialist: 'External specialist', contract: 'Contract', unknown: 'Unknown' } as const;
export const SOURCE_TYPE = {
  manufacturer: 'manufacturer statement', workshop: 'workshop documentation', supplier_disclosure: 'supplier disclosure',
  technical_interview: 'technical interview', specialist_reference: 'specialist reference', press: 'press', other: 'other',
} as const;

/** Reference, caliber, generation and route, in reading order. */
export const variant = (w: Watch) => [w.generation, w.reference && `Ref. ${w.reference}`, w.caliber && `Cal. ${w.caliber}`, w.route_label].filter(Boolean).join(', ');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

export const recordUrl = (id: string) => `/records/${id}/`;
export const orgUrl = (id: string) => `/organizations/${id}/`;
export const correctionUrl = (id?: string) => `/corrections/${id ? `?record=${encodeURIComponent(id)}` : ''}`;
/** Public fallback for the corrections form when no form endpoint is configured. */
export const issueUrl = 'https://github.com/mikeqtn/FALKIndex/issues/new';
/** GitHub Discussions threads that mention a record: its talk page. */
export const discussionUrl = (id: string) => `https://github.com/mikeqtn/FALKIndex/discussions?discussions_q=${encodeURIComponent(`"${id}"`)}`;
