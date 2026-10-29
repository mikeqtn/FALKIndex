import { fmtDate } from './data.ts';

// Links between the forum and the main site. With FORUM_HOST set (production), forum pages live
// at that host's root and main-site pages must be absolute; without it (the Replit preview) the
// forum is simply under /forum on the one host. See server/middlewares/forumHost.ts.
const forumHost = () => process.env.FORUM_HOST;
const siteOrigin = () => import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, '') ?? '';

/** A forum page, linked from another forum page. */
export const forumPath = (path = '/') => forumHost() ? path : `/forum${path}`;
/** A forum page, linked from the main site. */
export const forumHref = (path = '/') => forumHost() ? `https://${forumHost()}${path}` : `/forum${path}`;
/** A main-site page, linked from the forum. */
export const siteHref = (path: string) => forumHost() ? `${siteOrigin()}${path}` : path;
/** The canonical address of a forum page, from its /forum path. */
export const forumCanonical = (pathname: string) => forumHost() ? `https://${forumHost()}${pathname.replace(/^\/forum/, '') || '/'}` : undefined;

/** Sign in, then come back to this forum page (its address as the reader sees it). */
export const signInHref = (pathname: string) => `/sign-in?redirect_url=${encodeURIComponent(forumHost() ? pathname.replace(/^\/forum/, '') || '/' : pathname)}`;
/** Dates as the rest of the site shows them, e.g. 29 Oct 2026. */
export const forumDate = (iso: string) => fmtDate(iso.slice(0, 10));

/** Clerk sets __client_uat (possibly with a suffix) to a timestamp after sign-in and 0 after sign-out. */
export const hasSession = (cookie: string | null) => (cookie ?? '').split(/;\s*/)
  .some(c => /^__client_uat(_[\w-]+)?=/.test(c) && Number(c.split('=')[1]) > 0);

/** The links a forum island needs, worked out on the server where FORUM_HOST is known. */
export const forumLinks = () => ({ forum: forumPath('/'), thread: forumPath('/t/'), category: forumPath('/'), profile: siteHref('/people/'), record: siteHref('/records/'), account: siteHref('/account/') });
export type ForumLinks = ReturnType<typeof forumLinks>;
