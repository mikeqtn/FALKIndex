# FALK Index: Editorial guide

**Companion to:** handbook §6 ("How to use the FALK Index") and `docs/PLAN.md` §4.2 (data rules)
**Applies to:** every claim, provenance entry and profile in `data/watches/`

This turns the handbook's method into a checklist. A record is **fully evidenced** when `npm run validate` passes with its profile `published` and `is_seed: false`.

---

## 1. Identify the exact watch

- One file per model, reference, generation or production route: `data/watches/<brand>/<model>.yaml`.
- Fill `reference`, `caliber`, `generation` and `production_start`/`production_end` when known. If two generations were made differently, they are two records.

## 2. Collect sources

Prefer, in this order:

| Tier | `source_type` | Examples |
|---|---|---|
| Primary | `manufacturer`, `workshop`, `supplier_disclosure` | The brand's own pages, workshop documentation, a supplier naming its client |
| Secondary | `technical_interview`, `specialist_reference`, `press` | Interviews with the watchmaker, Caliber Corner, specialist journalism |

For each source in `data/sources.yaml`:
- Use the exact page URL, never a home page.
- Add `archived_url`: save the page at web.archive.org/save and paste the snapshot link. Brand pages move.
- Add `title` and, for articles, `published_on`.

Marketing words ("in-house", "manufacture", "handmade") are where research starts, not evidence on their own (handbook rule "Marketing terms are claims").

## 3. Write claims (facts)

A claim is one factual statement, in our words, backed by one source.

- `statement`: what the source establishes. No scores and no adjectives like "exceptional".
- `excerpt`: a short **verbatim** quote. Copy it from the page; never retype it from memory or from a summary.
- `dimensions`: every dimension the fact bears on.
- `date_checked`: the day you read it.
- `editor`: your handle.
- A claim that conflicts with another stays in the file. Set `status: disputed` or link the newer claim through `superseded_by`; never delete it (rule "Visible disputes").

## 4. Build the provenance table

One entry per component or process, keyed by dimension:

| Dimension | Typical components |
|---|---|
| MA | caliber design, bridge layout, complication engineering |
| MM | plates, bridges, wheels, pinions, escapement, balance, hairspring, mainspring, jewels |
| EX | case, case band, crown, bracelet, clasp, crystal |
| DH | dial blank, dial decoration (guilloché, enamel), printing, indices, hands |
| CF | hand finishing, anglage, engraving, engine-turning, enamelling |
| WE | assembly, hairspring overcoil, regulation, testing, after-sales |
| PD | product design, technical development, supplier direction |

Relationship is `internal`, `in_group` (owned by the same group, per rule "Group capability is disclosed"), `external_specialist`, `contract`, or `unknown`. If the maker is unknown but the work is clearly external, leave `performer` out and say so in `note`.

## 5. Score each dimension

- Read the level text in `data/methodology/v0.2.yaml` and choose the level the **evidence** supports.
- No evidence means **U** (`value: null`), not 0 (rule "Unknown is not zero").
- External artisan work does not raise CF or DH (rule "Internal means internal").
- Write a `rationale` of 2–4 sentences: which claims carry the score, and why it is not one level higher or lower. Borderline scores must say so.
- Link evidence: `stance: supports`, `contradicts` or `context`, each with a `note` saying why it matters.

## 6. Grade confidence, then classify

- **Confidence** describes the evidence, not the brand. If most dimensions rest on secondary sources, it is not A.
- **Classification comes last.** Pick the archetype that matches the finished profile; add a second only for genuine hybrids. If the profile and the label disagree, change the label, not the profile.

## 7. Publish a new version

- Add a new profile with `version` one higher, `status: draft`, and a `change_note`.
- A second person reviews the draft: they open every source, check every excerpt word for word, and challenge each rationale.
- On approval: set the new profile to `published` and the previous one to `superseded`. Run `npm run validate`; it rejects a published profile that lacks a rationale or a supporting claim.

## 8. AI-assisted drafts

Drafts prepared with AI use `editor: ai-draft` and stay `draft` until a human reviewer has checked every excerpt against the live page. The reviewer replaces `ai-draft` with their own handle on the claims they verify.
