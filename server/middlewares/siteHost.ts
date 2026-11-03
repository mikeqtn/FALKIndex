import type { RequestHandler } from 'express';

/**
 * Decide, once per request, which of this site's hosts the request is for.
 *
 * Everything downstream (the same-origin check on API writes, Clerk key selection, the Clerk proxy URL, forum
 * routing and the page script policy) reads the host from the request. This middleware runs first and leaves
 * only one trustworthy answer: it sets `Host` to an allowed host and removes `X-Forwarded-Host`, so no later
 * code can read an unchecked value.
 *
 * Configuration (all optional):
 * - SITE_HOSTS: comma-separated hostnames this deployment answers to; the first is canonical. In production it
 *   defaults to falkindex.com. FORUM_HOST is always added when set. A request for any other host is treated as a
 *   request for the canonical host.
 * - TRUST_FORWARDED_HOST: the proxy in front of the app (Replit's, or a future CDN) reports the original host in
 *   X-Forwarded-Host. Set to 0 to ignore that header and use Host alone. Either way, only allowed hosts are accepted.
 *
 * Outside production with no SITE_HOSTS (local development, the Replit preview, tests) every well-formed host is
 * accepted, as before, because preview hostnames are not known in advance.
 */
export type HostPolicy = { allowed: ReadonlySet<string> | null; canonical: string; trustForwarded: boolean };

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const hostname = (host: string) => host.replace(/:\d+$/, '');
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim().toLowerCase();

export function hostPolicy(env: NodeJS.ProcessEnv = process.env): HostPolicy {
  const listed = (env.SITE_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  for (const h of listed) if (!HOST.test(h) || h.includes(':')) throw new Error(`SITE_HOSTS: "${h}" is not a hostname (no scheme, port or path).`);
  if (!listed.length && env.NODE_ENV === 'production') listed.push('falkindex.com');
  const forum = env.FORUM_HOST?.trim().toLowerCase();
  if (listed.length && forum) listed.push(forum);
  return {
    allowed:listed.length ? new Set(listed) : null,
    canonical:listed[0] ?? 'localhost',
    trustForwarded:env.TRUST_FORWARDED_HOST !== '0',
  };
}

/** The host a request is for under `policy`: an allowed host, or the canonical one. */
export function resolveHost(headers: { host?: string; 'x-forwarded-host'?: string | string[] }, policy: HostPolicy) {
  const candidate = (policy.trustForwarded && first(headers['x-forwarded-host'])) || first(headers.host) || '';
  if (!HOST.test(candidate)) return policy.canonical;
  if (policy.allowed && !policy.allowed.has(hostname(candidate))) return policy.canonical;
  return candidate;
}

export function siteHost(policy: HostPolicy = hostPolicy()): RequestHandler {
  return (req, _res, next) => {
    req.headers.host = resolveHost(req.headers, policy);
    delete req.headers['x-forwarded-host'];
    // The proxy's scheme feeds req.protocol and the Clerk proxy URL; anything but http or https is dropped.
    const proto = first(req.headers['x-forwarded-proto']);
    if (proto !== undefined && proto !== 'http' && proto !== 'https') delete req.headers['x-forwarded-proto'];
    next();
  };
}
