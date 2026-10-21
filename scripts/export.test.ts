import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, load } from './validate.ts';
import { loadCatalogue } from '../server/catalogue.ts';
import { pool } from '../server/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'falk-export-'));
after(async () => { rmSync(dir, { recursive: true, force: true }); await pool.end(); });

test('db:export writes YAML that loads back to the same catalogue', async () => {
  cpSync('data/methodology', join(dir, 'methodology'), { recursive: true }); // not exported; see the script
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/export-catalogue.ts', dir]);
  const exported = check(load(dir));
  assert.deepEqual(exported.errors, []);
  // File order ("infinity-radiant.yaml" < "infinity.yaml") differs from database id order.
  const byId = (c: typeof exported.parsed) => ({ ...c, watches: [...c.watches].sort((a, b) => a.id < b.id ? -1 : 1) });
  assert.deepEqual(byId(exported.parsed), byId(await loadCatalogue()));
});
