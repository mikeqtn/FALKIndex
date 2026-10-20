import type { APIRoute } from 'astro';
import { getCatalogue } from '../../../lib/data.ts';

// Same set as the record pages; the file is the stored watch, with every profile version.
export const GET: APIRoute = async ({params,locals}) => {
  const {records,watches} = await getCatalogue(locals);
  const id = `${params.brand}/${params.model}`;
  if (!records.some(r => r.id===id)) return Response.json({error:'Record not found'},{status:404});
  return Response.json(watches.find(w => w.id===id));
};
