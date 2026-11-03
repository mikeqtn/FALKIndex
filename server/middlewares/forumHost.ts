import type { RequestHandler } from 'express';
import { getClerkProxyHost } from './clerkProxyMiddleware.ts';

// The forum's pages live under /forum. With FORUM_HOST set (production: forum.falkindex.com),
// that host serves them at its root and the main site's /forum links redirect there. The API,
// Clerk proxy, sign-in pages and static files are shared, so sign-in happens on the forum's own
// origin. Without FORUM_HOST (the Replit preview has one host) the forum stays at /forum.
const SHARED = /^\/(api|_astro|sign-in|sign-up|@|node_modules|src)(\/|$)|\.[a-z0-9]+$/i;
const FORUM_PATH = /^\/forum(\/|$)/;

export function forumHost(host = process.env.FORUM_HOST): RequestHandler {
  if (!host) return (_req, _res, next) => next();
  const forum = host.toLowerCase();
  return (req, res, next) => {
    const requested = getClerkProxyHost(req)?.toLowerCase().replace(/:\d+$/, '');
    const query = req.url.slice(req.path.length);
    if (requested !== forum) {
      if (FORUM_PATH.test(req.path)) return res.redirect(301, `https://${forum}${req.path.slice(6) || '/'}${query}`);
      return next();
    }
    if (FORUM_PATH.test(req.path)) return res.redirect(301, `${req.path.slice(6) || '/'}${query}`);
    if (!SHARED.test(req.path)) req.url = `/forum${req.url}`;
    next();
  };
}
