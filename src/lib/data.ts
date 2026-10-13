// Build-time data access for pages. Reuses the validator, so an invalid data/ fails the build.
import { check, load } from '../../scripts/validate.ts';
import { DIMENSIONS, type Watch } from '../schema.ts';

const result = check(load('data'));
if (result.errors.length) throw new Error(`data/ is invalid:\n${result.errors.join('\n')}`);

export { DIMENSIONS };
export const { methodologies, orgs, sources, watches } = result.parsed;
export const methodology = methodologies.get('v0.2')!;

export type Profile = Watch['profiles'][number];
export type Scores = Profile['scores'];
export type Record = Watch & { profile: Profile; draft?: Profile; brandName: string };

// A record is listed once it has a published profile. A newer draft is shown openly on the record page,
// labelled "Draft under review", next to (never in place of) the published profile.
export const records: Record[] = watches
  .filter(w => w.profiles.some(p => p.status === 'published'))
  .map(w => {
    const profile = w.profiles.find(p => p.status === 'published')!;
    const draft = w.profiles.findLast(p => p.status === 'draft'); // validate.ts guarantees drafts sit above the published version
    return { ...w, profile, draft, brandName: orgs.get(w.brand)!.name };
  })
  .sort((a, b) => a.brandName.localeCompare(b.brandName) || a.model.localeCompare(b.model));

export const record = (id: string) => records.find(r => r.id === id)!;

const sentence = (s: string) => s[0] + s.slice(1).toLowerCase();
export const dimension = Object.fromEntries(methodology.dimensions.map(d => [d.code, { ...d, label: sentence(d.name) }]));
export const classification = (code: string, m = methodology.code) =>
  methodologies.get(m)!.classifications.find(c => c.code === code)!;

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
export const brandUrl = (id: string) => `/brands/${id}/`;
// ponytail: corrections go to GitHub issues until the Phase 4 form (Q4) exists.
export const correctionUrl = (id?: string) =>
  `https://github.com/mikeqtn/FALKIndex/issues/new?title=${encodeURIComponent(id ? `Correction: ${id}` : 'Correction')}`;
