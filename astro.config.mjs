import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  trailingSlash: 'ignore',
  output: 'server',
  adapter: node({mode:'middleware'}),
  integrations: [react()],
  server: { host: '0.0.0.0', port: 5000 },
  vite: { envPrefix:['PUBLIC_','VITE_'], server: { allowedHosts: true } },
  // Brand pages moved in Phase 4; keep old links working.
  redirects: {
    '/brands/[id]': '/organizations/[id]',
    // Records split by production route on 2026-10-14.
    '/records/jn-shapiro/infinity-series': '/records/jn-shapiro/infinity',
    '/records/artur-akmaev/koi-tide': '/records/artur-akmaev/eternal-koi',
  },
});
