# FALK Index — Accounts and Editorial Implementation Plan

## Status and scope

This staged implementation follows the supplied “User Accounts, Contributions
& Editorial System” brief. Phase 1 supplies the server/database/account
foundation in development. Contribution review, public record revision history,
and methodology-administration UI remain later stages. Publishing and the first
administrator's identity still require owner setup and verification.

The brief expands the earlier Phase 5 sketch in `docs/PLAN.md`. Where they
differ, this plan follows the new brief: three roles, preserved originals,
public revision comparisons, professional verification, and private user data.
It does not change FALK's scoring methodology or redesign the public site.

## 1. Existing system and migration baseline (before implementation)

- Astro 7 with Node 24; existing Astro components and CSS define the visual identity.
- Static publishing builds `dist`; there is currently no production application server.
- Records are YAML files under `data/`, not database rows. The inspected catalogue
  has 57 watches, 64 organizations, and 35 sources, plus methodology v0.2.
- `src/schema.ts` contains strict Zod definitions for organizations, sources,
  claims, provenance, profiles, seven dimension scores, and methodologies.
- `scripts/validate.ts` checks cross-references, classification vocabulary,
  evidence requirements, profile history, and the distinction between U and zero.
- `src/lib/data.ts` loads the catalogue at build time. Pages, supplier queries,
  source references, JSON, and CSV depend on that interface.
- There is no auth library, account model, session store, or authorization middleware.
- A read-only inspection of development PostgreSQL found no application tables.
- Corrections currently use an optional external form endpoint, otherwise public
  GitHub issues. Discussion links point to GitHub.
- Existing redirects, public URLs, exports, source archives, provisional markers,
  profile versions, licences, and confidence-D behavior must survive the change.

### Baseline checks before implementation

Record entity IDs, content hashes, methodology definitions, profile versions,
published/draft states, record counts, and export shapes. Preserve the current
test suite and capture representative desktop and mobile public pages. Never
replace historical editors with newly created accounts or fabricate attribution.

## 2. Architecture

Keep Astro, the existing templates, stylesheet, URL structure, and Zod contracts.
Add `@astrojs/node` and request-time server routes; use Replit Autoscale instead
of static publishing once the server-backed release is verified.

Use a server-only PostgreSQL data-access layer, authentication adapter, and
authorization service. Templates call request-scoped repository functions rather
than retaining database data in module-level arrays. No database connection or
private account data reaches browser bundles.

PostgreSQL becomes authoritative after a verified import. YAML becomes an
exported snapshot, not a second writable database. During migration, compare the
two read paths; after cutover, fail explicitly on a database failure rather than
silently serving YAML or stale account permissions.

Public pages, evidence, sources, approved history, and downloads remain available
without sign-in. Account, contribution, review, and administration routes are
protected on the server. Account-specific responses are never publicly cached.

### Authentication decision confirmed for Phase 1

On 2026-10-20 the owner explicitly chose independent FALK accounts, not Replit
accounts. Use Replit-managed Clerk, hosted sign-in components within FALK pages,
the required same-origin production proxy, and server-verified identity.
Do not introduce home-grown password storage or silently change providers.

- Identify users by a stable, verified provider subject, not email or public username.
- Require a trusted verified-email claim before accepting a contribution; test
  the actual provider claims and fail closed when verification is absent.
- Keep usernames, roles, suspensions, disclosures, and public profiles in the app.
- An app administrator manages FALK membership; the provider owns credentials.
- Development and production identities and administrator setup are separate.

## 3. Database design — support all phases from the beginning

Use explicit relationships plus immutable version snapshots. Reconstruct the
existing `Watch`, `Source`, `Organization`, and methodology shapes through an
adapter so current rendering and validation rules remain reusable.

| Area | Planned records and constraints |
|---|---|
| Identity and privacy | `account`, provider identities, and a separate private account record for email/private name; case-insensitive unique public usernames; join date and suspension state |
| Authorization | Contributor/editor/administrator roles, administrator grants, and append-only role/suspension events; no role inferred from qualifications |
| Public profiles | Public display name, bio, optional website/image, qualifications, and separately verified credentials; private fields excluded by explicit public projections |
| Affiliations | Organization relationships, relationship type, material brand ties, disclosure dates, verification evidence, and effective dates |
| Catalogue | Stable watch and organization identities with current approved revision pointers; existing IDs and redirect aliases retained |
| Evidence | Distinct claims, reusable sources, claim/source relationships, model/dimension links, provenance entries, and attribution/verification metadata |
| Scores and methods | Profile versions, seven dimension scores, rationales, score/evidence links, immutable methodology versions, versioned classification/confidence definitions |
| Proposals | Submission identity, immutable original payload, base revision, requested changes, explanation, evidence, and immutable subsequent proposal versions |
| Review | Append-only decisions, requests for information, contributor replies, editor amendments, and private moderation notes stored separately |
| Publication | Immutable approved content revisions, before/after snapshots, changed fields, original contributor, approving editor, evidence references, and timestamps |
| Audit and policy | Append-only privileged-action events, documented overrides, reversion links, and moderated public redaction/visibility events |

### Important modeling rules

1. Published catalogue values and proposed values are separate. A pending proposal
   cannot update a current-record pointer.
2. A submission records its base revision. A proposal amendment or editor change
   creates a new immutable version, never overwrites the original submission.
3. Review status is a current projection of append-only events. Status values
   include pending, information requested, approved, rejected, and withdrawn;
   stale-base conflicts are recorded explicitly.
4. Preserve all existing profile histories, including published, superseded,
   draft, seed, disputed, and U-valued data.
5. Reusable sources and claims have their own identities. Historical revisions
   pin evidence versions so later URL/title changes cannot rewrite old evidence.
6. Keep record revisions distinct from score-profile versions: a supplier
   correction need not change a numerical score.
7. Existing schemas do not fully represent firsthand testimony without an
   external URL. Extend evidence intake deliberately to support attributed,
   dated testimony and a stable internal evidence reference; never invent an
   external citation or treat self-reported knowledge as verified.
8. Keep authentication data, private real names, email, and moderation notes out
   of published snapshots, public profiles, public APIs, JSON, and CSV exports.
9. Published revisions and audit records reject ordinary UPDATE/DELETE operations
   through database permissions/guards, not just application convention.
10. An account deletion/deactivation does not cascade into published revisions.
    Retain a stable attribution identity or policy-approved tombstone; handle
    private data under a documented retention/deletion policy.

## 4. Permission and review boundaries

| Actor | Allowed scope |
|---|---|
| Visitor | Read public records, sources, profiles, approved history, and exports; no account required |
| Contributor | Maintain own profile/disclosures; submit edits/new models/new brands after email verification; view own originals, replies, status, and feedback |
| Editor | Review submissions; approve/reject/request information; modify and approve with visible amendment attribution; propose/create watch and brand records; no user-role or methodology administration |
| Administrator | Manage app users/suspensions, grant/remove editor roles, administer settings and methodology versions, inspect audit history, and execute audited publication/reversion actions |

All protected actions recheck the active account, suspension state, email
verification, role, ownership, review eligibility, and record version on the
server. Public qualification labels never grant permissions. Prevent removing or
suspending the last active administrator.

### Approval transaction

1. Load the submission and immutable original; construct the reviewed candidate
   separately, including any attributed editor amendments.
2. Check reviewer eligibility again, including self-review and commercial ties.
3. Lock the affected current records and check the candidate's base revision.
   Return a conflict and a readable comparison if another edit was published.
   Do not automatically overwrite or blindly merge stale proposals.
4. Validate the complete affected candidate graph with the existing Zod and FALK
   invariants, including source references, rationale, and supporting claims.
5. In one transaction, append the approved revision and review/audit events,
   write the versioned evidence changes, and advance current revision pointers.
6. Invalidate any public caches only after commit. The next request sees the new
   approved version; no rebuild is required.

Failures roll back the whole transaction. Reviews of overlapping watch, source,
organization, or methodology references must use consistent locking/version checks.

### Conflicts of interest and overrides

- An editor cannot approve their own submission.
- Capture relevant affiliations at submission and review time; removing a
  disclosure must not erase an existing conflict flag.
- Check material brand relationships, including disclosed supplier relationships
  affecting the record, rather than matching only an employer's name.
- Manufacturer-affiliated contributions are welcome but visibly labelled; their
  assertions remain evidence to evaluate, not automatic score changes.
- Administrator overrides require a specific justification and visible audit event.
  Default to no self-approval of newly authored content, even for administrators.
  Confirm the exceptional override policy before implementing that control.
- A privileged reversion creates a new revision referencing an already approved
  version and its reason. It never erases intervening history.
- “Modify and approve” preserves the contributor's original and separately
  attributes the reviewer's amendments; it does not disguise an editor's own
  initial submission as someone else's proposal.

## 5. Staged implementation and exit criteria

### Phase 1 — Server foundation, accounts, permissions, and safe data import

- Confirm login experience and bootstrap the first administrator through an
  explicit trusted-owner process. Never make the first arbitrary signup an admin.
- Introduce Astro's Node adapter, session handling, CSRF protection, and the
  initial additive database schema designed for all four phases.
- Add login/register/logout, profile onboarding, all requested qualification
  options, separate verification indicators, disclosure fields, and privacy settings.
- Qualification options are watch collector, watch dealer, watchmaker, brand
  employee/representative, journalist/author, blogger/content creator, industry
  professional, enthusiast, and other; allow multiple selections and free-text detail.
- Add administrator user management and app-local account provisioning/invitations,
  editor grants/removals, suspension, and account/session invalidation checks.
  Provider-owned identities and passwords remain under the auth provider's control.
- Import the existing catalogue and prior history transactionally and
  idempotently, retaining historical editor strings as legacy attribution.
- Verify import/export parity, then switch the public data layer to PostgreSQL
  without changing layouts, methods, existing links, or anonymous access.
- Render public profiles with join date, qualifications, affiliations, accepted
  contributions, pending/rejected counts only, and public editorial actions.

**Exit:** anonymous browsing still works; verified users can onboard; server
tests cover each role and suspension; private fields cannot be obtained through
public endpoints; the current catalogue and history survive an export round trip.

### Phase 2 — Contributions and editorial workflow

- Add “Suggest an Edit” on every model page, with sign-in return-to-record behavior.
- Provide field/section edits, current and proposed values, explanations, evidence
  URLs or firsthand attestations, and private additional notes.
- Allow evidence/provenance-only edits without demanding a numerical score change.
- Add new-brand and new-model proposals and an optional personal draft workspace.
- Add My Contributions, status/history, requests for information, and author replies.
- Add an editor queue with pending, recent approved, rejected, and information
  requested views; filter by brand, model, contributor, date, and change type.
- Add side-by-side comparisons and approve/reject/modify-and-approve/request-info
  actions backed by the publication transaction described above.
- Replace GitHub-dependent contribution paths. Preserve an explicitly anonymous
  correction-intake path only if retained as policy; it must still be reviewed.

**Exit:** valid proposals never change public records before approval; rejected
submissions require a reason; originals survive amendments; concurrent approvals
cannot overwrite one another; contributors see their own feedback, not others' notes.

### Phase 3 — Public transparency, comparisons, and reversions

- Add a History tab to each watch page with revision IDs, timestamps, changed
  fields, before/after values, explanations, sources, contributor, and reviewer links.
- Support historical-version browsing and comparisons without changing the current
  public record.
- Add administrator reversion controls that create a new attributed revision.
- Show published contributions and public editorial actions on user profiles.
- Keep pending proposal bodies private to author/reviewers by default; show counts
  publicly. The earlier Phase 5 sketch allowed public pending diffs, so confirm
  that visibility policy before exposing unreviewed text.
- Provide a moderation-controlled public view for substantive rejected proposals
  and explanations where appropriate. Spam, abuse, PII, and private moderation
  details are never automatically made public.
- Replace GitHub discussion links with on-site record discussions when that
  separately defined moderation scope is ready; do not invent an unmoderated forum.

**Exit:** every approved change is attributable and comparable; reverting
preserves all earlier revisions; public history and profile/API exports contain
no private identity or moderation data.

### Phase 4 — Evidence management and methodology governance

- Complete source and claim editing, reusable citations, excerpts, publication and
  verification dates, testimony handling, and contributor/editor attribution.
- Preserve the distinction between factual evidence and editorial interpretation.
- Keep dimension-specific evidence expandable from the existing seven-row profile.
- Prioritize primary documentation; label technical references such as Caliber
  Corner as secondary where appropriate, rather than treating citation count as quality.
- Finish professional/affiliation verification tools and conflict-of-interest
  displays, including documented administrator overrides.
- Add administrator-only methodology/classification/confidence-definition changes
  as new versions. Existing profiles retain their original methodology references.
- Maintain public JSON/CSV and YAML snapshots generated from approved database
  data; verify attribution, licences, and privacy exclusions.

**Exit:** shared sources are not unnecessarily duplicated; claims can be traced
to models/dimensions and dated evidence; old profiles retain old definitions;
editors and contributors cannot change core methodology through alternate APIs.

## 6. Security and operational acceptance tests

- Test every protected API directly for anonymous, unverified, contributor,
  editor, administrator, and suspended accounts—not just hidden navigation links.
- Use secure provider-managed authentication, httpOnly/secure session cookies,
  session rotation, origin/CSRF checks, bounded requests, rate limits, and spam controls.
- Validate on the server, parameterize SQL, escape user content, and restrict
  profile/evidence URL schemes. Do not fetch arbitrary submitted URLs server-side
  without SSRF defenses; do not allow arbitrary image uploads without validation.
- Test username normalization/collisions, disclosure changes, provider-subject
  stability, private real-name defaults, and credential-verification labels.
- Test new records, score changes, U versus zero, source-only changes, missing
  evidence, missing rationale, unknown references, duplicate approvals, stale bases,
  invalid methods, and publication transaction rollback.
- Test self-review and affiliation conflicts through every approval/reversion
  path, including forged roles and account suspension during an existing session.
- Test append-only guards, preservation of modified submission originals, public
  history sanitization, account-deletion attribution, and export privacy.
- Retain the existing methodology/data/build tests and add isolated database and
  end-to-end permission/contribution/review tests. Never submit test data to live
  form services or mutate production content during verification.
- Check desktop and mobile public pages, sign-in, profiles, editing, queues,
  comparisons, accessible errors, keyboard operation, and anonymous performance.

## 7. Deployment, migration, and rollout

1. Back up/export the existing catalogue and establish the parity baseline.
2. Apply additive schema changes in development through the supported dev workflow.
   Keep data import explicit and idempotent; do not seed again on every server start.
3. Replit's Publish flow applies managed production schema changes. Do not add
   production DDL to build commands, startup hooks, or a custom production schema
   migration script.
4. Make production data initialization explicit: use the supported initial
   development-to-production data flow or a documented authorized import step.
   Verify the seed is present rather than assuming schema publication copies data.
5. Do not overwrite a nonempty production editorial database with development seed
   data on later publishes. Development identities and role assignments are not
   automatically valid production administrator accounts.
6. Switch from static publishing to the verified Node/Autoscale configuration only
   with this architectural change made clear to the owner. No redesign or framework
   replacement is required.
7. Verify published anonymous reads, login, private-data boundaries, session
   persistence, and a controlled editorial flow. The owner performs Publish.
8. Keep an additive-compatible rollback path and backups. Rolling back application
   code must not discard approved database edits or restore stale YAML as writable truth.

## 8. Decisions to confirm before their implementation

- **Login experience — resolved:** independent FALK accounts through managed Clerk.
- **First administrator:** which trusted identity receives the initial grant,
  and who is the second independent reviewer?
- **Public proposal visibility:** keep pending bodies private by default, and
  require moderation approval before rejected proposals become public?
- **Privacy and deletion:** establish retention, attribution after account
  deletion, and handling of personal information accidentally included in content.
- **Override policy:** define exceptional administrator overrides and whether
  any self-review exception is allowed; default to prohibiting it for new content.

No secret, provider identity, email address, or first-admin identifier belongs in
this plan. Collect any credentials only through Replit's secure setup flows.
