// Validates data/ against src/schema.ts plus the cross-reference rules and invariants in docs/PLAN.md §4.2.
// Usage: node scripts/validate.ts [dataDir]   Exit 1 on any error; warnings are printed but do not fail.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { DIMENSIONS, Methodology, Organization, Source, Watch } from '../src/schema.ts';

type Raw = { file: string; value: any };

export function load(dir: string) {
  const files = (sub: string) => readdirSync(join(dir, sub), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.yaml')).sort().map(f => join(sub, f));
  const read = (f: string): Raw => ({ file: f, value: parse(readFileSync(join(dir, f), 'utf8')) });
  return {
    methodologies: files('methodology').map(read),
    organizations: files('organizations').map(read),
    sources: (read('sources.yaml').value as unknown[]).map((value, i) => ({ file: `sources.yaml[${i}]`, value })),
    watches: files('watches').map(read),
  };
}

export function check(raw: ReturnType<typeof load>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (where: string, msg: string) => errors.push(`${where} → ${msg}`);
  const warn = (where: string, msg: string) => warnings.push(`${where} → ${msg}`);

  function parseAll<T>(schema: ZodType<T>, docs: Raw[]) {
    return docs.flatMap(({ file, value }) => {
      const r = schema.safeParse(value);
      if (r.success) return [{ file, data: r.data }];
      for (const i of r.error.issues) err(`${file}:${i.path.join('.')}`, i.message);
      return [];
    });
  }
  function index<T extends { id: string }>(docs: { file: string; data: T }[], kind: string) {
    const m = new Map<string, T>();
    for (const { file, data } of docs) {
      if (m.has(data.id)) err(file, `duplicate ${kind} id "${data.id}"`);
      m.set(data.id, data);
    }
    return m;
  }

  const methodologies = new Map(parseAll(Methodology, raw.methodologies).map(d => [d.data.code, d.data]));
  const orgDocs = parseAll(Organization, raw.organizations);
  const orgs = index(orgDocs, 'organization');
  const srcDocs = parseAll(Source, raw.sources);
  const sources = index(srcDocs, 'source');
  const watchDocs = parseAll(Watch, raw.watches);
  index(watchDocs, 'watch');

  const ancestors = (id: string) => {
    const seen = new Set<string>();
    for (let o = orgs.get(id); o?.parent && !seen.has(o.parent); o = orgs.get(o.parent)) seen.add(o.parent);
    return seen;
  };

  for (const { file, data: o } of orgDocs) {
    if (file !== `organizations/${o.id}.yaml`) err(file, `id "${o.id}" must match the file name`);
    if (o.parent && !orgs.has(o.parent)) err(`${file}:parent`, `unknown organization "${o.parent}"`);
  }
  for (const { file, data: s } of srcDocs) {
    if (s.publisher && !orgs.has(s.publisher)) err(`${file}:publisher`, `unknown organization "${s.publisher}"`);
  }

  const claimIds = new Set<string>();
  for (const { file, data: w } of watchDocs) {
    if (file !== `watches/${w.id}.yaml`) err(file, `id "${w.id}" must match the file path`);
    if (w.id.split('/')[0] !== w.brand) err(`${file}:brand`, `brand "${w.brand}" must match the id prefix`);
    if (!orgs.has(w.brand)) err(`${file}:brand`, `unknown organization "${w.brand}"`);

    const claims = new Map(w.claims.map(c => [c.id, c]));
    w.claims.forEach((c, i) => {
      const at = `${file}:claims.${i}`;
      if (claimIds.has(c.id)) err(at, `duplicate claim id "${c.id}"`);
      claimIds.add(c.id);
      if (!sources.has(c.source)) err(`${at}.source`, `unknown source "${c.source}"`);
      if (c.superseded_by && !claims.has(c.superseded_by)) err(`${at}.superseded_by`, `unknown claim "${c.superseded_by}"`);
    });

    const brandGroups = ancestors(w.brand);
    w.provenance.forEach((p, i) => {
      const at = `${file}:provenance.${i}`;
      for (const c of p.claims) if (!claims.has(c)) err(`${at}.claims`, `unknown claim "${c}"`);
      if (!p.performer) return;
      if (!orgs.has(p.performer)) return err(`${at}.performer`, `unknown organization "${p.performer}"`);
      // Invariant 10: in_group must match the organization graph.
      const shared = p.performer !== w.brand && [...ancestors(p.performer)].some(a => brandGroups.has(a) || a === w.brand);
      if (p.relationship === 'in_group' && !shared) warn(`${at}.relationship`, `in_group, but "${p.performer}" shares no parent with "${w.brand}"`);
      if (p.relationship !== 'in_group' && shared) warn(`${at}.relationship`, `"${p.performer}" is in the same group as "${w.brand}"; expected in_group`);
    });

    // Invariant 7: versions run 1..n; one published at most; everything below it is superseded.
    const published = w.profiles.filter(p => p.status === 'published');
    if (published.length > 1) err(`${file}:profiles`, 'more than one published profile');
    w.profiles.forEach((p, i) => {
      const at = `${file}:profiles.${i}`;
      if (p.version !== i + 1) err(`${at}.version`, `expected version ${i + 1}, found ${p.version}`);
      if (published[0] && p.version < published[0].version && p.status !== 'superseded') err(`${at}.status`, 'older than the published profile, must be superseded');

      // Invariant 6: controlled vocabulary of archetypes, no descriptors, no duplicates.
      const m = methodologies.get(p.methodology);
      if (!m) err(`${at}.methodology`, `unknown methodology "${p.methodology}"`);
      const vocab = new Map(m?.classifications.map(c => [c.code, c.kind]));
      p.classification.forEach((c, j) => {
        if (!vocab.has(c)) err(`${at}.classification.${j}`, `"${c}" is not in the ${p.methodology} vocabulary`);
        else if (vocab.get(c) !== 'archetype') err(`${at}.classification.${j}`, `"${c}" is a descriptor; use the boolean field instead`);
      });
      if (new Set(p.classification).size !== p.classification.length) err(`${at}.classification`, 'duplicate classification');

      for (const d of DIMENSIONS) {
        const s = p.scores[d];
        s.evidence.forEach((e, k) => {
          const c = claims.get(e.claim);
          if (!c) err(`${at}.scores.${d}.evidence.${k}`, `unknown claim "${e.claim}"`);
          else if (!c.dimensions.includes(d)) warn(`${at}.scores.${d}.evidence.${k}`, `claim "${e.claim}" is not tagged ${d}`);
        });
        // Invariant 4: published, non-seed profiles carry a rationale and supporting evidence for every non-U score.
        if (p.status !== 'published' || p.is_seed || s.value === null) continue;
        if (!s.rationale?.trim()) err(`${at}.scores.${d}`, 'rationale required on a published profile');
        if (!s.evidence.some(e => e.stance === 'supports')) err(`${at}.scores.${d}`, 'at least one supporting claim required on a published profile');
      }
    });
  }
  return { errors, warnings, counts: { organizations: orgs.size, sources: sources.size, watches: watchDocs.length } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, warnings, counts } = check(load(process.argv[2] ?? 'data'));
  for (const w of warnings) console.warn(`warning  ${w}`);
  for (const e of errors) console.error(`error    ${e}`);
  console.log(`${counts.watches} watches, ${counts.organizations} organizations, ${counts.sources} sources: ${errors.length} errors, ${warnings.length} warnings`);
  process.exit(errors.length ? 1 : 0);
}
