// Every public page, for search engines. Account, admin and review pages are left out (see robots.txt).
import { getCatalogue, orgUrl, recordUrl, siteOrigin } from '../lib/data.ts';
import type { APIRoute } from 'astro';

const STATIC = ['/', '/records/', '/archetypes/', '/methodology/', '/sources/', '/data/', '/about/', '/corrections/'];

export const GET: APIRoute = async ({ locals, url }) => {
  const { records, orgPageIds } = await getCatalogue(locals);
  const origin = siteOrigin(url);
  const entry = (path: string, lastmod?: string) =>
    `<url><loc>${origin}${path}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const urls = [
    ...STATIC.map(p => entry(p)),
    ...records.map(r => entry(recordUrl(r.id), r.profile.created_on)),
    ...[...orgPageIds].sort().map(id => entry(orgUrl(id))),
  ];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
