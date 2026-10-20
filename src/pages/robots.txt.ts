// The catalogue is open to crawlers; personal and editorial pages are not.
import { siteOrigin } from '../lib/data.ts';
import type { APIRoute } from 'astro';

const PRIVATE = ['/account', '/admin/', '/editor/', '/sign-in', '/sign-up', '/api/'];

export const GET: APIRoute = ({ url }) => new Response(
  ['User-agent: *', ...PRIVATE.map(p => `Disallow: ${p}`), '', `Sitemap: ${siteOrigin(url)}/sitemap.xml`, ''].join('\n'),
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
