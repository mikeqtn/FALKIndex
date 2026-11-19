// Catalogue brands that FALK's publisher, Falk Watches, LLC, deals with directly, by organization id.
// Records of these brands carry a disclosure, and the About page lists them.
// Review every quarter against the store and the inventory, then update PUBLISHER_BRANDS_REVIEWED.
// Brand names only: inventory counts, costs and customer details are private and stay out of this public repo.
export const PUBLISHER_BRANDS_REVIEWED = '3 November 2026';

export const DIRECT_BRANDS = new Set(['artur-akmaev', 'lesablier', 'ophion', 'zrc']);

/** How the publisher is tied to a brand, worded to follow "Falk Watches, LLC", or null if it has no known tie. */
export function publisherTie(brand: string) {
  if (DIRECT_BRANDS.has(brand)) return 'deals directly with this brand and sells its watches';
  return null;
}
