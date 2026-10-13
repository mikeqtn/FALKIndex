import type { APIRoute } from 'astro';
import { records, watches } from '../../../lib/data.ts';

// Same set as the record pages; the file is the stored watch, with every profile version.
export function getStaticPaths() {
  return records.map(r => {
    const [brand, model] = r.id.split('/');
    return { params: { brand, model }, props: { w: watches.find(w => w.id === r.id)! } };
  });
}

export const GET: APIRoute = ({ props }) => Response.json(props.w);
