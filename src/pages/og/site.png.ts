import type { APIRoute } from 'astro';
import { getCatalogue } from '../../lib/data.ts';
import { sitePng } from '../../lib/og.ts';

// The share image for every page that has none of its own (see Base.astro).
export const GET: APIRoute = async ({ locals }) => {
  const { records } = await getCatalogue(locals);
  return new Response(new Uint8Array(sitePng(records.length)), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
};
