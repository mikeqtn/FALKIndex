# FALK Index: Decisions

**Companion to:** `docs/PLAN.md` §7 (open questions) and Appendix A
**Status:** Defaults adopted so Phase 1 can start. Each one is reversible until launch. Rows marked **provisional** still need sign-off from the methodology owner.

---

## Open questions

| # | Decision | Status |
|---|---|---|
| Q1 | Git-backed YAML files under `data/`, validated by `npm run validate`. | Adopted |
| Q2 | Controlled vocabulary of the 9 handbook classifications (8 archetypes + the Independent Watchmaker descriptor). The original free-text label is kept on each seed profile as `seed_label`. | Adopted |
| Q3 | Secondary classification allowed. A profile's `classification` list is in rank order; the first entry is rank 1. | Adopted |
| Q4 | The /corrections/ form posts to the URL in `PUBLIC_CORRECTIONS_ENDPOINT` (a form service such as Formspree, which emails the editor). Until that is set, it opens a prefilled public GitHub issue. | Built; endpoint **open** |
| Q5 | Data CC BY-SA 4.0, code MIT. | Default |
| Q6 | Scale bands `individual / small / medium / industrial / unknown`, defined loosely in `EDITORIAL.md` (Phase 3). Set only where obvious; otherwise `unknown`. | Default |
| Q7 | Scores imported as the handbook records them. `relationship: in_group` is shown on provenance entries. Rule decided in v0.3. | Default |
| Q8 | No MVP change for quartz / Spring Drive. | Default |
| Q9 | Page 6 is blank in the extracted text; treated as a decorative figure. | Assumed |
| Q10 | All 56 records published, the 50 unevidenced ones labelled provisional (`is_seed: true`). | Default |
| Q11 | Domain, branding and publisher. | **Open** (blocks launch, not development) |

## Appendix A owner decisions

Where the plan offered alternatives, the first option is used. Every row here is **provisional**.

| Records | Profile | Seed label | Adopted | Tension |
|---|---|---|---|---|
| Baltic Aquascaphe, Underd0g 01SERIES Gen3, Underd0g 03SERIES | 0/0/0/0/0/3/x | Microbrand with Internal Assembly | Contract / Microbrand | WE 3 shows real assembly; Watchmaking Atelier is arguable |
| Kudoke 2 | 4/2/1/2/5/5/4 | Independent Watchmaker | Independent Manufacture + IW | Near-identical to Laine P37 (4/2/1/2/5/4/4), which is a Watchmaking Atelier |
| Philippe Dufour Simplicity | 5/4/2/2/5/5/5 | Independent Watchmaker | Independent Manufacture + IW | None strong |
| ZRC MN64 Metal | 1/1/1/1/0/2/3 | Industrial / Design-led Specialist | Design-led Établisseur | Low PD for "design-led" |
| Longines Spirit Zulu Time | 1/0/1/1/1/4/3 | Industrial / In-group Supplier Model | Industrial Manufacture | MM 0 contradicts "meaningful internal movement manufacturing" |
| Oris Aquis Calibre 400 | 4/1/0/0/1/4/4 | Independent Industrial / Proprietary Supplier Model | Industrial Manufacture | MM 1; Design-led Établisseur fits the definition better |

## Data corrections at import

- J.N. Shapiro Resurgence: the §8 table omits "Independent Watchmaker", the §6 example includes it. Imported with `independent_watchmaker: true` (F3).
- Kurono Tokyo: "Designer-led Établisseur" normalised to Design-led Établisseur (F4).
- "Integrated Haute Manufacture" → Integrated Manufacture (F2).
- Truncated source URLs in handbook §10 (`.../`) are stored at the domain root with the handbook path in `notes`. Editors replace them with the exact page and add an archive link.

## Record splits (2026-10-14)

Applied the "model first" rule to two handbook records that mixed production routes. Old URLs redirect.

| Handbook record | Now | Why |
|---|---|---|
| J.N. Shapiro — Infinity Series | `jn-shapiro/infinity` (UWD 33.1, 2019) and `jn-shapiro/infinity-radiant` (La Joux-Perret 5000-4) | Two different movements; the 2019 evidence (SJX) does not cover the Radiant |
| Artur Akmaev — Koi / Tide | `artur-akmaev/eternal-koi` (La Joux-Perret F200) | No source for an Akmaev "Tide" was found; add it as its own record if one appears |

The narrowed records carry a version 3 with unchanged scores and a change note; the Radiant starts at version 1. All three were reviewed and published by mikeqtn on 2026-10-14.
