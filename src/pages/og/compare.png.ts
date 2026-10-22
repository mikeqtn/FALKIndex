import type { APIRoute } from 'astro';
import { getCatalogue } from '../../lib/data.ts';
import { comparePng } from '../../lib/og.ts';
import { pickCompared } from '../../lib/compare.ts';

// The share image of /compare/ for the same ?w= list; fewer than two watches has nothing to draw.
export const GET: APIRoute = async ({ url, locals }) => {
  const { records } = await getCatalogue(locals);
  const { chosen } = pickCompared(url.searchParams, records);
  if (chosen.length < 2) return new Response('Choose two to four watches', { status: 404 });
  return new Response(new Uint8Array(comparePng(chosen)), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
};
