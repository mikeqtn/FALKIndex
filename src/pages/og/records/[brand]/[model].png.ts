import type { APIRoute } from 'astro';
import { DIMENSIONS, getCatalogue } from '../../../../lib/data.ts';
import { recordPng, type DimensionLabels } from '../../../../lib/og.ts';

// The record's share image, referenced by og:image on its page.
export const GET: APIRoute = async ({ params, locals }) => {
  const { dimension, records } = await getCatalogue(locals);
  const r = records.find(r => r.id === `${params.brand}/${params.model}`);
  if (!r) return new Response('Record not found', { status: 404 });
  const labels = Object.fromEntries(DIMENSIONS.map(d => [d, dimension[d].label])) as DimensionLabels;
  return new Response(new Uint8Array(recordPng(r, labels)), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
};
