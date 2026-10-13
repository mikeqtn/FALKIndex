// One row per record, current profile only. U is an empty cell plus a <dim>_unknown flag. No total column, by rule.
import { DIMENSIONS, records } from '../../lib/data.ts';

const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const dims = DIMENSIONS.map(d => d.toLowerCase());
const header = ['id', 'brand', 'model', 'reference', 'caliber', 'generation', 'route', ...dims, ...dims.map(d => `${d}_unknown`),
  'classification', 'secondary_classification', 'independent_watchmaker', 'confidence', 'provisional', 'methodology', 'version'];

export const GET = () => {
  const rows = records.map(r => {
    const p = r.profile;
    const d = p.confidence !== 'D';
    return [r.id, r.brandName, r.model, r.reference, r.caliber, r.generation, r.route_label,
      ...DIMENSIONS.map(k => d ? p.scores[k].value : null), ...DIMENSIONS.map(k => d && p.scores[k].value === null),
      d ? p.classification[0] : '', d ? p.classification.slice(1).join(' ') : '', p.independent_watchmaker, p.confidence, p.is_seed,
      p.methodology, p.version].map(cell).join(',');
  });
  return new Response([header.join(','), ...rows].join('\n') + '\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
};
