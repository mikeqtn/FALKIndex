// Which watches a comparison shows, from ?w=a&w=b (or ?w=a,b): known records with a profile, at most four, no repeats.
import type { Record } from './data.ts';

export const MAX_COMPARE = 4;
export function pickCompared(params: URLSearchParams, records: Record[]) {
  const ids = [...new Set(params.getAll('w').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean))];
  const byId = new Map(records.map(r => [r.id, r]));
  const chosen = ids.map(id => byId.get(id)).filter((r): r is Record => !!r && r.profile.confidence !== 'D').slice(0, MAX_COMPARE);
  const dropped = ids.filter(id => !chosen.some(r => r.id === id));
  return { chosen, dropped };
}
export const compareQuery = (ids: string[]) => ids.map(id => `w=${encodeURIComponent(id)}`).join('&');
