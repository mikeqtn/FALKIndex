import type { RequestHandler } from 'express';
import { getClerkProxyHost } from './clerkProxyMiddleware.ts';

// The forum's pages live under /forum. With FORUM_HOST set (production: forum.falkindex.com),
// that host serves them at its root and the main site's /forum links redirect there. The API,
// Clerk proxy and static files are shared, and the forum has its own sign-in pages, so sign-in happens on its own
// origin. Without FORUM_HOST (the Replit preview has one host) the forum stays at /forum.
const SHARED = /^\/(api|_astro|@|node_modules|src)(\/|$)|\.[a-z0-9]+$/i;
const FORUM_PATH = /^\/forum(\/|$)/;

export function forumHost(host = process.env.FORUM_HOST): RequestHandler {
  if (!host) return (_req, _res, next) => next();
  const forum = host.toLowerCase();
  return (req, res, next) => {
    const requested = getClerkProxyHost(req)?.toLowerCase().replace(/:\d+$/, '');
    const query = req.url.slice(req.path.length);
    // One leading slash only: "/forum//evil.com" would otherwise redirect to "//evil.com", which browsers read as
    // another site.
    const rest = '/' + req.path.slice(6).replace(/^\/+/, '');
    if (requested !== forum) {
      if (FORUM_PATH.test(req.path)) return res.redirect(301, `https://${forum}${rest}${query}`);
      return next();
    }
    if (FORUM_PATH.test(req.path)) return res.redirect(301, `${rest}${query}`);
    if (!SHARED.test(req.path)) req.url = `/forum${req.url}`;
    next();
  };
}
