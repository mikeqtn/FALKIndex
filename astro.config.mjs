import { defineConfig } from 'astro/config';

export default defineConfig({
  trailingSlash: 'ignore',
  // Brand pages moved in Phase 4; keep old links working.
  redirects: { '/brands/[id]': '/organizations/[id]' },
});
