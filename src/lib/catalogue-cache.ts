/**
 * One validated catalogue, shared by every request in this server instance.
 *
 * Loading the catalogue reads nine tables and validates the whole of it, so it is done once and reused:
 * - Requests share the cached copy. After `ttlMs` the next request starts a reload in the background and is
 *   served the current copy meanwhile, so readers never wait on a reload once the server is warm.
 * - Concurrent cold requests share one load.
 * - If a reload fails, the last good copy keeps being served and the failure is logged; the next attempt waits
 *   `retryMs`, so a struggling database is not hit by every request.
 * - The cached value is deep-frozen, so no request can change what another request sees. Writing to it throws.
 */
export type CatalogueCache<T> = { get: () => Promise<T>; ageMs: () => number | null };

export function createCatalogueCache<T extends object>(load: () => Promise<T>, {
  ttlMs = 15_000, retryMs = 5_000, now = Date.now, log = (line: object) => console.error(JSON.stringify(line)),
}: { ttlMs?: number; retryMs?: number; now?: () => number; log?: (line: object) => void } = {}): CatalogueCache<T> {
  let current: { value: T; loadedAt: number } | undefined;
  let inflight: Promise<T> | undefined;
  let failedAt = -Infinity;
  let lastError: unknown;

  const reload = () => inflight ??= load()
    .then(value => { current = { value:deepFreeze(value), loadedAt:now() }; return current.value; })
    .catch(error => {
      failedAt = now(); lastError = error;
      // No message or stack: they can carry SQL or connection details.
      log({ event:'catalogue.reload_failed', errorName:(error as Error)?.name ?? 'Error', errorCode:(error as any)?.code ?? 'unknown',
        servingStaleMs:current ? now() - current.loadedAt : null });
      throw error;
    })
    .finally(() => { inflight = undefined; });

  return {
    async get() {
      const t = now();
      if (!current) {
        if (inflight) return inflight;
        if (t - failedAt < retryMs) throw lastError; // cold and recently failed: answer at once, do not retry yet
        return reload();
      }
      if (t - current.loadedAt >= ttlMs && !inflight && t - failedAt >= retryMs) reload().catch(() => {});
      return current.value;
    },
    ageMs: () => current ? now() - current.loadedAt : null,
  };
}

/** Values that expire after `ttlMs`. When full it starts again empty: the cost is a few extra lookups, and memory stays bounded. */
export function createTtlMap<V>({ ttlMs, maxEntries = 10_000, now = Date.now }: { ttlMs: number; maxEntries?: number; now?: () => number }) {
  const entries = new Map<string, { value: V; at: number }>();
  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at < ttlMs) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key: string, value: V) {
      if (entries.size >= maxEntries && !entries.has(key)) entries.clear();
      entries.set(key, { value, at:now() });
    },
    delete(key: string) { entries.delete(key); },
  };
}

const refuse = () => { throw new TypeError('The shared catalogue is read-only'); };
/** Freeze objects, arrays, Maps and Sets all the way down; Map and Set writers throw. Functions are left as they are. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) { deepFreeze(k, seen); deepFreeze(v, seen); }
    for (const method of ['set', 'delete', 'clear']) Object.defineProperty(value, method, { value:refuse });
  } else if (value instanceof Set) {
    for (const v of value) deepFreeze(v, seen);
    for (const method of ['add', 'delete', 'clear']) Object.defineProperty(value, method, { value:refuse });
  }
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as any)[key], seen);
  return Object.freeze(value);
}
