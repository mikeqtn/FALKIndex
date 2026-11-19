// Which watches a proposal may duplicate. The proposal form warns the member with this as they type, and the review
// queue shows the editor the same matches, among published records and other open proposals.
export type NamedRecord = { id: string; brand: string; brandName: string; model: string; variant: string };
export type ProposedName = { brandId?: string; brandName?: string; model: string };

// "Ref." and "Cal." label most variants, so they say nothing about which watch it is.
const LABELS = new Set(['ref', 'cal']);
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
  .filter(w => w.length > 1 && !LABELS.has(w));

/** Records of the same brand sharing a model word with the proposal; with no brand chosen yet, any sharing one. A new brand is
 * the same brand when every word of its name is in a listed brand's name. */
export function similarRecords<T extends NamedRecord>(records: T[], proposed: ProposedName, limit = 6): T[] {
  const model = words(proposed.model);
  const brandName = proposed.brandId ? [] : words(proposed.brandName ?? '');
  const hasBrand = !!proposed.brandId || brandName.length > 0;
  if (!hasBrand && !model.length) return [];
  return records.filter(r => {
    const sameBrand = proposed.brandId ? r.brand === proposed.brandId : brandName.length > 0 && brandName.every(w => words(r.brandName).includes(w));
    const modelHit = model.some(w => words(`${r.model} ${r.variant}`).includes(w));
    return hasBrand ? sameBrand && (!model.length || modelHit) : modelHit;
  }).slice(0, limit);
}
