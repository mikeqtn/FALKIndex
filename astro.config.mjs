import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import { createHash } from 'node:crypto';
import { INLINE_SCRIPTS, CLERK_PROTECT_SCRIPTS, CLERK_PROTECT_CONNECT } from './src/lib/inline-scripts.mjs';

export default defineConfig({
  trailingSlash: 'ignore',
  output: 'server',
  adapter: node({mode:'middleware'}),
  integrations: [react()],
  server: { host: '0.0.0.0', port: 5000, allowedHosts: true },
  vite: { envPrefix:['PUBLIC_','VITE_'], server: { allowedHosts: true } },
  // Script policy for every rendered page. Astro hashes each inline script it outputs (island hydration,
  // is:inline blocks) and sends the policy as a response header; server/csp.ts sends it as
  // Content-Security-Policy-Report-Only for now, so violations are reported, never blocked.
  // Not active under `astro dev`: test with `npm run build && npm run preview`.
  security: {
    csp: {
      scriptDirective: {
        // Clerk's script loads through the same-origin proxy (/api/__clerk). Its bot protection (Clerk Protect) loads
        // scripts from cdn.protect.clerk.com and per-instance *.client.protect.clerk.com hosts; seen on the live sign-in
        // page on 2026-11-03. Turnstile stays listed in case Clerk falls back to a visible challenge.
        resources: ["'self'", ...CLERK_PROTECT_SCRIPTS, 'https://challenges.cloudflare.com'],
        // Astro hashes its own scripts but not is:inline ones; Base.astro's come from this shared module.
        hashes: INLINE_SCRIPTS.map(s => `sha256-${createHash('sha256').update(s).digest('base64')}`),
      },
      styleDirective: {
        // Clerk injects its styles at runtime and a few elements use style="". Astro emits no style hashes with
        // 'unsafe-inline' present, so styles stay as permissive as today; only scripts are being tightened.
        resources: ["'self'", "'unsafe-inline'"],
      },
      directives: [
        "default-src 'self'",
        "img-src 'self' data: https://img.clerk.com",
        `connect-src 'self' ${CLERK_PROTECT_CONNECT}`,
        "font-src 'self'",
        'frame-src https://challenges.cloudflare.com',
        "worker-src 'self' blob:",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        'report-uri /csp-report',
        'report-to csp',
      ],
    },
  },
  // Brand pages moved in Phase 4; keep old links working.
  redirects: {
    '/brands/[id]': '/organizations/[id]',
    // Records split by production route on 2026-10-14.
    '/records/jn-shapiro/infinity-series': '/records/jn-shapiro/infinity',
    '/records/artur-akmaev/koi-tide': '/records/artur-akmaev/eternal-koi',
  },
});
