// Photographs of the watches themselves, front and back, by record id. Only openly licensed photos or ones
// supplied with permission, of the exact model; each carries its credit and licence. Files live in
// public/images/watches/<record id>/<side>-{600,1200}.jpg; run `npm run images` to add their AVIF copies.
// A record with no entry shows an invitation instead.
export type WatchPhoto = {
  w: number; h: number; // pixel size of the 1200px file
  alt: string;
  credit: string;
  licence: string;
  licenceUrl: string;
  source: string; // where the original is published
};
export type WatchPhotos = { front?: WatchPhoto; back?: WatchPhoto };

const BY_SA_4 = { licence: 'CC BY-SA 4.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' };

export const WATCH_PHOTOS: Record<string, WatchPhotos> = {
  'nomos/tangente-neomatik': {
    front: { w: 1200, h: 866, alt: 'A NOMOS Tangente neomatik 41 Update with its white dial and red date ring, on a black strap.', credit: 'Berlinerblau, via Wikimedia Commons', ...BY_SA_4, source: 'https://commons.wikimedia.org/wiki/File:Nomos_Glash%C3%BCtte_Tangente_neomatik_41_Update.jpg' },
    back: { w: 1177, h: 1177, alt: 'The caseback of a Tangente neomatik 41 Update, showing the DUW 6101 movement.', credit: 'Anil Öztas, via Wikimedia Commons', licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', source: 'https://commons.wikimedia.org/wiki/File:Nomos_Tangente_neomatik_41_Update,_Ref._180,_DUW_6101_--_2024_--_0149-51X.jpg' },
  },
  'tudor/black-bay-chrono': {
    front: { w: 1024, h: 922, alt: 'A Tudor Black Bay Chrono ref. 79350 with a black dial and steel bracelet, on the wrist.', credit: 'EMore98, via Wikimedia Commons', ...BY_SA_4, source: 'https://commons.wikimedia.org/wiki/File:Tudor_Black_Bay_Chrono_ref._79350.jpg' },
  },
  'roger-w-smith/series-2': {
    front: { w: 589, h: 504, alt: 'A Roger W. Smith Series 2 with an open dial in a yellow gold case, on display.', credit: 'Geni, via Wikimedia Commons', ...BY_SA_4, source: 'https://commons.wikimedia.org/wiki/File:2008_series_2_open_dial_by_Roger_W_Smith.JPG' },
  },
};
