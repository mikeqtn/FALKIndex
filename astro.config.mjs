import { defineConfig } from 'astro/config';

export default defineConfig({
  trailingSlash: 'ignore',
  server: { host: '0.0.0.0', port: 5000 },
  vite: { server: { allowedHosts: true } },
});
