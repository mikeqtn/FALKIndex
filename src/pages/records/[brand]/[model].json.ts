import type { APIRoute } from 'astro';
import { watches } from '../../../lib/data.ts';

export function getStaticPaths() {
  return watches.map(w => { const [brand, model] = w.id.split('/'); return { params: { brand, model }, props: { w } }; });
}

export const GET: APIRoute = ({ props }) => Response.json(props.w);
