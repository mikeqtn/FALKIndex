// Plain-English archetype copy for the home page, /archetypes/, record pages and the records browser.
// The formal definitions stay in data/methodology/v0.2.yaml; these summaries restate them for readers and must not change their meaning.
// Patterns are observed from published records, never thresholds: the methodology assigns the classification last, from the whole profile.
import { DIMENSIONS, type Record } from './data.ts';

export type ArchetypeCopy = {
  /** One sentence for cards, record pages and the records browser. */
  short: string;
  /** Two or three sentences on how watches of this kind are generally made. */
  means: string;
  /** Where it meets its neighbours, for /archetypes/. */
  borderline: string;
};

export const ARCHETYPES: { [code: string]: ArchetypeCopy } = {
  contract_microbrand: {
    short: 'A brand that develops or specifies its watches and relies on outside manufacturers to make almost all of them.',
    means: 'The brand contributes the idea: the design, the specification and sometimes real product development. The movement, case, dial and assembly are generally bought in from contract manufacturers. Many well-regarded watches are made this way.',
    borderline: 'When a brand directs a network of specialists and authors substantial original design or technical work, it is usually closer to a Design-led Établisseur.',
  },
  design_led_etablisseur: {
    short: 'A brand that directs a network of specialist suppliers, often contributing substantial original design or technical development while making relatively little itself.',
    means: 'Établisseur is the traditional Swiss term for a house that builds watches from parts made by specialists. Here the brand leads: it may author the movement architecture or commission bespoke parts, even when the physical fabrication happens elsewhere. FALK records that authorship separately from manufacture.',
    borderline: 'With little original development or supplier direction, the same structure reads as a Contract / Microbrand.',
  },
  artisan_etablisseur: {
    short: 'A watch defined by specialist craftsmanship, with much or all of that craft performed by outside artisans or workshops.',
    means: 'Engraving, enamel, guilloché or hand finishing is what makes the watch, but named outside partners carry it out. Their work enriches the watch\'s provenance and is recorded as external, not as the brand\'s own craft.',
    borderline: 'When the defining craft is physically done inside the workshop, the watch is an Artisan Atelier.',
  },
  artisan_atelier: {
    short: 'A workshop that performs the defining craftsmanship of its watches itself, such as engraving, enamelling, guilloché, dialmaking or hand finishing.',
    means: 'Craft and finishing, and often dial work, are typically where the internal work is concentrated, while the movement may be bought in. What characterizes the watch is a métier practised inside the workshop.',
    borderline: 'If the same craft is carried out by outside partners, the watch is an Artisan Établisseur.',
  },
  watchmaking_atelier: {
    short: 'A workshop that assembles, adjusts, modifies or regulates its watches itself, without broadly manufacturing its own movement components.',
    means: 'Watchmaking execution is generally the strongest internal measure: watches are built, regulated and often modified in the workshop. Movement parts, cases and dials are usually sourced from others.',
    borderline: 'When the workshop also authors its caliber and makes a meaningful share of its parts, it is closer to an Independent Manufacture.',
  },
  independent_manufacture: {
    short: 'A maker combining its own technical development with meaningful in-house production of movement components.',
    means: 'Movement architecture and movement manufacturing are typically both substantial: the maker designs its caliber and physically makes a meaningful part of it. Cases and other exterior parts may still come from specialists.',
    borderline: 'When in-house production also covers the case and other major exterior components, with deep watchmaking, it is closer to an Integrated Manufacture.',
  },
  integrated_manufacture: {
    short: 'A manufacturer with broad in-house production across the movement and major exterior components, supported by deep watchmaking.',
    means: 'Internal work generally runs across the movement, the exterior and watchmaking execution. Most of what makes the watch, and the work of building it, happens inside the house.',
    borderline: 'When production is scaled and institutional, with meaningful internal manufacture, it is usually an Industrial Manufacture.',
  },
  industrial_manufacture: {
    short: 'An established manufacturer working at scale, with meaningful in-house movement production and watchmaking.',
    means: 'Production is institutional and high-volume, with movement or watch manufacture meaningfully internal. It can be independently owned or part of a group; a sister company inside a group is recorded as in-group, not as the brand itself.',
    borderline: 'A smaller house with similarly broad internal production is usually an Integrated Manufacture.',
  },
};

export const DESCRIPTOR = {
  code: 'independent_watchmaker',
  short: 'Not an archetype but a descriptor: a named watchmaker personally performs substantial watchmaking or craft on the watches.',
  means: 'It sits beside the archetype, so a watch can be, for example, an Artisan Atelier and carry this descriptor too. Editors assign it from evidence about the people involved; it never follows from scores.',
};

/** Shown wherever archetypes are introduced. */
export const NOT_A_RANKING = 'Archetypes are descriptions, not rankings. None is better than another, and none says anything about price, prestige or quality.';
export const NOT_OWNERSHIP = 'Archetype names describe how a watch is made, not who owns the company.';

export const archetypeUrl = (code: string) => `/archetypes/#${code.replaceAll('_', '-')}`;
export const browseUrl = (code: string) => `/records/?cls=${code}`;

/** Records whose published profile has this archetype first. D profiles carry no classification on the site, so they are left out. */
export const recordsOf = (records: Record[], code: string) =>
  records.filter(r => r.profile.confidence !== 'D' && r.profile.classification[0] === code);

/** Records carrying this archetype anywhere in their classification, as the records browser's filter counts them. */
export const taggedWith = (records: Record[], code: string) =>
  records.filter(r => r.profile.confidence !== 'D' && r.profile.classification.includes(code));

export type Band = 'high' | 'middle' | 'low' | 'varies' | 'unknown';
export type DimPattern = { code: string; known: number; min: number | null; max: number | null; common: number | null; band: Band };

/**
 * What the records in an archetype show on each dimension: the range seen, the most common score and a plain band.
 * U is left out of every figure (unknown is not zero); `known` says how many records had a score.
 */
export function pattern(recs: Record[]): DimPattern[] {
  return DIMENSIONS.map(code => {
    const vals = recs.map(r => r.profile.scores[code].value).filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!vals.length) return { code, known: 0, min: null, max: null, common: null, band: 'unknown' };
    const counts = new Map<number, number>();
    vals.forEach(v => counts.set(v, (counts.get(v) ?? 0) + 1));
    const common = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const mid = vals[Math.floor((vals.length - 1) / 2)];
    const [min, max] = [vals[0], vals[vals.length - 1]];
    const band: Band = max - min >= 4 ? 'varies' : mid >= 4 ? 'high' : mid <= 1 ? 'low' : 'middle';
    return { code, known: vals.length, min, max, common, band };
  });
}

export const BAND_TEXT: { [b in Band]: string } = {
  high: 'Usually high',
  middle: 'Usually middling',
  low: 'Usually low',
  varies: 'Varies widely',
  unknown: 'Not yet known',
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
