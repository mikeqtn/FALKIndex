import { z } from 'zod';
import { Watch } from '../../schema.ts';

export const GET = () => Response.json(z.toJSONSchema(Watch, { io: 'input' }));
