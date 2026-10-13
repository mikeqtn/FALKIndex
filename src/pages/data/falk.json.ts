import { methodologies, orgs, sources, watches } from '../../lib/data.ts';

export const GET = () => Response.json({
  methodologies: [...methodologies.values()],
  organizations: [...orgs.values()],
  sources: [...sources.values()],
  watches,
});
