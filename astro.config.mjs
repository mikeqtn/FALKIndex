import { defineConfig } from 'astro/config';

export default defineConfig({
  trailingSlash: 'ignore',
  // Brand pages moved in Phase 4; keep old links working.
  redirects: {
    '/brands/[id]': '/organizations/[id]',
    // Records split by production route on 2026-10-14.
    '/records/jn-shapiro/infinity-series': '/records/jn-shapiro/infinity',
    '/records/artur-akmaev/koi-tide': '/records/artur-akmaev/eternal-koi',
  },
});
