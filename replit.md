# FALK Index

The imported MVP is an Astro website backed by YAML content in `data/`.
Keep its existing structure and watch-provenance methodology intact.

## Run in Replit

- Runtime: Node.js 24.
- Install dependencies from `package-lock.json` with `npm ci`.
- The **FALK Index web** workflow runs `npm run dev -- --ignore-lock`, listening on
  `0.0.0.0:5000` for Replit's web preview.
- `--ignore-lock` prevents Astro's agent-detected background startup so Replit
  can keep the server alive as a managed foreground workflow.
- Astro's development server allows Replit's proxied host.

## Check the site

Run `npm run validate`, then `npm run build`, then `npm test`.
Build before testing so the built-site checks are not skipped.

This is a static website; no database, authentication, or external secrets
are needed to run the imported MVP.
