import type { AstroGlobal } from 'astro';
import { getClerkProxyHost } from '../../server/middlewares/clerkProxyMiddleware.ts';
import { CLERK_PROTECT_CONNECT } from './inline-scripts.mjs';

/**
 * Per-request additions to the page's script policy, for every layout (Base.astro and ForumLayout.astro).
 *
 * Clerk's production Frontend API is clerk.<this host> (see publishableKeyFromHost in AuthProvider.tsx), so it differs
 * between falkindex.com and the forum's host. The hostname is checked before it enters the policy. Astro.url is no
 * help here: without an allowedDomains list Astro reports every host as localhost, so the host is read the way the
 * server's Clerk middleware reads it. Astro.csp exists only in built pages, not under `astro dev`.
 */
export function allowClerkForHost(astro: Pick<AstroGlobal, 'csp' | 'request'>) {
  const host = (getClerkProxyHost({ headers: Object.fromEntries(astro.request.headers) }) ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!astro.csp || !/^[a-z0-9.-]+$/.test(host)) return;
  astro.csp.insertScriptResource(`https://clerk.${host}`);
  astro.csp.insertDirective(`connect-src 'self' https://clerk.${host} ${CLERK_PROTECT_CONNECT}`);
}
