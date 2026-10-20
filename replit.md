# FALK Index

The website is Astro with a Node/Express host and Replit PostgreSQL.
Keep its existing structure and watch-provenance methodology intact.
The owner explicitly selected independent FALK accounts using Replit-managed
Clerk, not "Sign in with Replit." Public catalogue browsing never requires login.

## Run in Replit

- Runtime: Node.js 24.
- Install dependencies from `package-lock.json` with `npm ci`.
- The **FALK Index web** workflow runs `npm run dev -- --ignore-lock`, listening on
  `0.0.0.0:5000` for Replit's web preview.
- The Node host serves APIs and proxies an internal Astro dev process. It passes
  `--ignore-lock` to Astro so the child stays in the managed foreground workflow.
- Astro's development server allows Replit's proxied host.

## Check the site

Run `npm run validate`, `npm run typecheck`, `npm run build`, then `npm test`.
The tests render the built server anonymously and check database privacy,
permissions, immutable history, catalogue parity, and methodology invariants.
They fail, rather than skip, when a server build is missing.

## Data and accounts

- `DATABASE_URL` is managed by Replit. Private identity fields and public
  profiles are stored separately. Roles are app-owned and checked server-side.
- `npm run db:setup` applies the additive **development-only** schema.
  It must not run as a production startup/build command.
- `npm run db:import` imports the validated YAML into an empty database in one
  transaction. It is idempotent and refuses to overwrite live editorial data.
- `data/` remains the original seed/export copy, not a runtime fallback.
- The catalogue is reconstructed from relational data and validated on every
  request, using a request-local cache and a consistent read transaction.
- Clerk setup provisions its keys. Use the workspace Auth pane for login
  settings; no external Clerk dashboard or manually shared passwords.
- Configure `FALK_BOOTSTRAP_ADMIN_EMAIL` privately with the trusted initial
  administrator's email. Only that verified identity gets a one-time grant.
  The first person to sign up is **not** automatically an administrator.
- Normal sign-in applies the grant once. `npm run bootstrap:admin` can also
  explicitly resolve an already registered, verified identity. Reruns do not
  restore revoked roles. Production and development have separate auth realms.
- Existing admin accounts invite members and manage roles/status at
  `/admin/users`; credentials are independently verified, never self-granted.
- The detailed staged scope is `docs/ACCOUNTS-EDITORIAL-IMPLEMENTATION.md`.
  Phase 1 is the account foundation; contribution review, public record history,
  and methodology administration are subsequent phases, not implemented UI.

## Publish

Publishing uses the Autoscale target with a Node server:

- Build command: `npm run build`.
- Run command: `npm start`.
- Astro emits `dist/client` assets and `dist/server/entry.mjs`.
- Replit Publish manages development-to-production schema changes. Review its
  database step, including the append-only guard functions/triggers.
- Initial production data needs the validated catalogue seed; never run an
  unconditional import or schema migration at startup. Later publishing must
  preserve production contributions, not replace them with development data.
- Production identity/admin setup is separate; verify account and admin access
  after publishing with the production Clerk instance.

Preview and publishing are configured separately. Publish through Replit's
Publishing tool after making changes you want to make public.
