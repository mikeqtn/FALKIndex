import { createHash } from 'node:crypto';
import type { AstroGlobal } from 'astro';
import { getClerkProxyHost } from '../../server/middlewares/clerkProxyMiddleware.ts';
import { clerkHostFor, clerkProxyFor } from '../accounts/clerk-host.ts';
import { CLERK_PROTECT_CONNECT } from './inline-scripts.mjs';

/**
 * Per-request additions to the page's script policy, for every layout (Base.astro and ForumLayout.astro).
 *
 * Clerk's production Frontend API is clerk.<host>, and a subdomain such as the forum uses the main site's, through the
 * main site's proxy (src/accounts/clerk-host.ts). The hostname is checked before it enters the policy. Astro.url is no
 * help here: without an allowedDomains list Astro reports every host as localhost, so the host is read the way the
 * server's Clerk middleware reads it. Astro.csp exists only in built pages, not under `astro dev`.
 * `otherSite` is the origin of the other site (the forum, seen from FALK Index), allowed for prefetching it.
 */
export function allowClerkForHost(astro: Pick<AstroGlobal, 'csp' | 'request'>, otherSite = '') {
  const host = (getClerkProxyHost({ headers: Object.fromEntries(astro.request.headers) }) ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!astro.csp || !/^[a-z0-9.-]+$/.test(host)) return;
  const clerkHost = clerkHostFor(host);
  const proxy = clerkProxyFor(host);
  const proxyOrigin = proxy ? new URL(proxy).origin : '';
  astro.csp.insertScriptResource(`https://clerk.${clerkHost}`);
  if (proxyOrigin) astro.csp.insertScriptResource(proxyOrigin);
  // The other site's origin (the forum's, from FALK Index), so a link to it can be prefetched (SITE_JUMP_SCRIPT).
  const other = /^https:\/\/[a-z0-9.-]+$/.test(otherSite) && otherSite !== proxyOrigin ? ` ${otherSite}` : '';
  astro.csp.insertDirective(`connect-src 'self' https://clerk.${clerkHost}${proxyOrigin ? ` ${proxyOrigin}` : ''}${other} ${CLERK_PROTECT_CONNECT}`);
}

/**
 * Speculation rules that prerender the other site's pages once the reader rests on a link to them ("moderate": about
 * 200ms of hover, or pointer down), so the jump between FALK Index and the forum lands on a page that is already drawn.
 * Chrome alone acts on them; other browsers keep the plain prefetch in SITE_JUMP_SCRIPT. Prerendering a page on the
 * other host needs that page to send Supports-Loading-Mode: credentialed-prerender (server/index.ts).
 * `base` is the other site's root ("https://forum.falkindex.com/", or "/forum/" in development). Sign-in, account, admin
 * and API pages are never prerendered. The rules depend on the host, so their hash joins the page's script policy here.
 */
export function jumpRules(astro: Pick<AstroGlobal, 'csp'>, base: string) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const skip = ['sign-in', 'sign-up', 'account', 'admin', 'editor', 'api'].map(p => ({ not: { href_matches: `${root}${p}*` } }));
  // From the forum in development, the main site is the same host, whose /forum/ pages are not the other site.
  if (root === '/') skip.push({ not: { href_matches: '/forum/*' } });
  const rules = JSON.stringify({ prerender: [{ where: { and: [{ href_matches: `${root}*` }, ...skip] }, eagerness: 'moderate' }] });
  astro.csp?.insertScriptHash(`sha256-${createHash('sha256').update(rules).digest('base64')}`);
  return rules;
}
