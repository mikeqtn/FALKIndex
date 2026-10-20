import { getCatalogue } from '../../lib/data.ts';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({locals}) => {
const { methodologies,orgs,sources,watches } = await getCatalogue(locals);
return Response.json({
  methodologies: [...methodologies.values()],
  organizations: [...orgs.values()],
  sources: [...sources.values()],
  watches,
});
};
