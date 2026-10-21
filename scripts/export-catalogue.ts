import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { loadCatalogue } from '../server/catalogue.ts';
import { pool } from '../server/db.ts';

// Writes the live PostgreSQL catalogue back to data/ (Q14) so git keeps a reviewable copy.
// Usage: npm run db:export [-- <dir>]   (default: data)
const out = process.argv[2] ?? 'data';
try {
  const { orgs, sources, watches } = await loadCatalogue(); // validated before anything is written
  // Methodology is hand-authored with comments and not edited on the site, so it is left alone.
  // Remove generated files first so renamed or split records don't leave stale YAML behind.
  for (const sub of ['organizations', 'watches', 'sources.yaml']) rmSync(join(out, sub), { recursive: true, force: true });
  const put = (file: string, value: unknown) => {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    writeFileSync(join(out, file), stringify(value, { lineWidth: 0 }));
  };
  for (const [id, o] of orgs) put(`organizations/${id}.yaml`, o);
  put('sources.yaml', [...sources.values()]);
  for (const w of watches) put(`watches/${w.id}.yaml`, w);
  console.log(`Exported ${watches.length} watches, ${orgs.size} organizations and ${sources.size} sources to ${out}/.`);
} finally { await pool.end(); }
