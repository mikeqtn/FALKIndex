import type { RequestHandler } from 'express';

/**
 * Per-visitor limits on rendered pages and generated share images, kept in this instance's memory.
 *
 * The API has its own database-backed limits (server/api.ts); static files are served before this runs. Pages and
 * share images are anonymous and fairly expensive to render, so each visitor gets a budget per minute. Counting
 * happens in memory, adding no database write to a page view. With several Autoscale instances each counts
 * separately, so the effective limit is per instance: a first line of defence, not an exact quota.
 *
 * PAGE_RATE_LIMIT chooses the mode:
 * - `log` (the default for now): never blocks; logs when a visitor goes over, and a per-minute summary.
 * - `enforce`: answers 429 with Retry-After once a visitor is over.
 * - `off`.
 * Visitors are told apart by req.ip, so `enforce` is only safe once `trust proxy` is known to match the real proxy
 * chain; otherwise every visitor could share the proxy's address and one budget. The summary's `clients` count shows
 * whether visitors are being told apart.
 */
export type LimitMode = 'log' | 'enforce' | 'off';
export type PageLimitOptions = {
  mode?: LimitMode; pagesPerMinute?: number; imagesPerMinute?: number; maxClients?: number;
  now?: () => number; log?: (line: object) => void;
};

/** One key per visitor: an IPv4 address, or the /64 network of an IPv6 address (one household or server). */
export function clientKey(ip: string | undefined) {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const modeFrom = (value: string | undefined): LimitMode => value === 'enforce' || value === 'off' ? value : 'log';

export function pageLimit({
  mode = modeFrom(process.env.PAGE_RATE_LIMIT),
  pagesPerMinute = Number(process.env.PAGE_RATE_PER_MINUTE) || 120,
  imagesPerMinute = Number(process.env.IMAGE_RATE_PER_MINUTE) || 30,
  maxClients = 100_000, now = Date.now, log = (line: object) => console.warn(JSON.stringify(line)),
}: PageLimitOptions = {}): RequestHandler {
  if (mode === 'off') return (_req, _res, next) => next();
  let window = Math.floor(now() / 60_000);
  let counts = new Map<string, number>();
  let over = new Set<string>();
  let full = false;
  const roll = (current: number) => {
    // A summary only for windows where someone went over: enough to see attacks and a shared-address problem.
    if (over.size) {
      let maxHits = 0;
      for (const hits of counts.values()) if (hits > maxHits) maxHits = hits;
      log({ event:'rate_limit.window', mode, clients:counts.size, overLimit:over.size, maxHits, full });
    }
    window = current; counts = new Map(); over = new Set(); full = false;
  };
  return (req, res, next) => {
    const current = Math.floor(now() / 60_000);
    if (current !== window) roll(current);
    const image = req.path.startsWith('/og/');
    const key = `${image ? 'image' : 'page'}:${clientKey(req.ip)}`;
    const known = counts.get(key);
    if (known === undefined && counts.size >= maxClients) {
      // Never let the table grow without bound; past the cap, new visitors this minute go uncounted.
      if (!full) { full = true; log({ event:'rate_limit.table_full', maxClients }); }
      return next();
    }
    const hits = (known ?? 0) + 1;
    counts.set(key, hits);
    if (hits <= (image ? imagesPerMinute : pagesPerMinute)) return next();
    if (!over.has(key)) { over.add(key); log({ event:'rate_limit.page', mode, kind:image ? 'image' : 'page', limit:image ? imagesPerMinute : pagesPerMinute }); }
    if (mode !== 'enforce') return next();
    res.set({ 'Retry-After':String(60 - Math.floor(now() / 1000) % 60), 'Cache-Control':'no-store', 'Content-Type':'text/plain; charset=utf-8' });
    res.status(429).send('Too many requests. Please wait a minute and try again.');
  };
}
