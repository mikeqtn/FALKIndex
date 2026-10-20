# FALK Index

An evidence-led reference for how watches are actually made.

Every record is an exact watch model with a **FALK Profile**: seven
dimensions scored 0–5, or **U** when there is no evidence. They are never
added together. Each score links to the claims, sources and editorial
rationale behind it.

| Code | Dimension |
|---|---|
| MA | Movement architecture |
| MM | Movement manufacturing |
| EX | Exterior manufacturing |
| DH | Dial & hands manufacturing |
| CF | Craft & finishing |
| WE | Watchmaking execution |
| PD | Product development |

A darker profile means more of the work happens inside the brand. It is not
a quality score or a ranking.

## How it's built

- **Site:** [Astro](https://astro.build), with React for the account pages.
- **Host:** a Node/Express server (`server/`) that serves the APIs and the Astro build.
- **Database:** PostgreSQL. The catalogue is rebuilt from relational data and
  validated on every request.
- **Accounts:** [Clerk](https://clerk.com). Browsing the catalogue never requires an account.
- **Seed data:** YAML in `data/`, imported into PostgreSQL once.

## Run it locally

You need Node.js 24 and a PostgreSQL database.

```sh
npm ci
export DATABASE_URL=postgres://…
export CLERK_PUBLISHABLE_KEY=pk_test_…
export VITE_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY
export CLERK_SECRET_KEY=sk_test_…
npm run db:setup     # development schema only; never run it in production
npm run db:import    # loads data/ into an empty database
npm run dev          # http://localhost:5000
```

Set `PUBLIC_SITE_URL` (for example `https://example.com`) once the public
domain is settled. It adds canonical links, full URLs and each record's
profile image to link previews. It is read at build time, so set it before
`npm run build`.

On Replit, the **FALK Index web** workflow does this for you. See
[`replit.md`](replit.md) for Replit, publishing and first-admin setup.

## Check your changes

```sh
npm run validate     # data/ follows the methodology rules
npm run typecheck
npm run build
npm test             # needs the build and a database
```

CI runs the same steps against a PostgreSQL service on every push and pull
request.

## Corrections

Spotted something wrong? Use **Send a correction** on any record. You don't
need an account, and any contact details you give stay private. Editors
review every submission. An accepted correction leads to a new, attributed
profile version; it never silently rewrites the published record.

## Documentation

- [`docs/EDITORIAL.md`](docs/EDITORIAL.md): the checklist for scoring and evidencing a record
- [`docs/DESIGN.md`](docs/DESIGN.md): visual design direction
- [`docs/PLAN.md`](docs/PLAN.md): MVP plan, open questions and risks
- [`docs/DECISIONS.md`](docs/DECISIONS.md): decisions adopted so far
- [`docs/ACCOUNTS-EDITORIAL-IMPLEMENTATION.md`](docs/ACCOUNTS-EDITORIAL-IMPLEMENTATION.md): accounts and editorial roadmap

## Licence

Code is [MIT](LICENSE). Data in `data/` is [CC BY-SA 4.0](data/LICENSE).
