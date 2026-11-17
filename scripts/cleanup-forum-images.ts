import { pool } from '../server/db.ts';
import { cleanupStaleUnattachedImages } from '../server/forumImageCleanup.ts';

if (process.env.NODE_ENV !== 'production' && !process.env.REPLIT_DEPLOYMENT) {
  throw new Error('Forum image cleanup is intended for a Production Scheduled Deployment.');
}

try {
  const result = await cleanupStaleUnattachedImages();
  console.log(JSON.stringify({ event:'forum_images.cleanup', ...result }));
  if (result.failed > 0) process.exitCode = 1;
} catch (error: any) {
  console.error(JSON.stringify({
    event:'forum_images.cleanup.failed',
    errorName:error?.name ?? 'Error',
    errorCode:error?.code ?? 'unknown',
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
