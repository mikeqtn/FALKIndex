# FALK Index: Design direction

**Companion to:** `docs/PLAN.md` (screens from §5, rules from §4.2)
**Status:** Draft for review

---

## 1. Brief, restated

- **Subject:** an evidence database describing *where* the work on a watch happens: movement, case, dial, craft, assembly, development.
- **Audience:** serious collectors, watch journalists, and the brands and watchmakers being described. They read carefully, argue about details, and notice anything that smells of marketing.
- **Primary job:** let a reader see a watch's seven-dimension profile at a glance, then **open any dimension and check the evidence for themselves**.
- **What the design must never do:** make a profile look like a score, a rank, or a verdict on quality ("provenance, not prestige").

---

## 2. Aesthetic direction: rhodium, blued steel, one jewel

The visual language comes from the inside of a watch movement, not from luxury advertising.

- **Rhodium plate.** Cool, pale, silvery greys for surfaces. A movement's mainplate and bridges are layered flat metal, so the page is layered flat tone. Depth comes from tonal steps between "plate" and "bridge", never from drop shadows.
- **Blued steel.** The ink colour. Screws and hands are heat-blued to a deep blue-black, and heat treatment is literally one of the processes FALK records under DH. All text, and all profile fills, are blued steel.
- **One jewel.** Ruby red, used for one meaning only: *the thing you can act on* (links, focus, the active filter). A movement's jewels sit exactly where motion happens, and that's where ruby goes.
- **Gilt.** Warm brass, reserved for *provisional or contested* states: seed records and disputed claims. Older gilt movements are the archive; gilt here means "not yet settled".
- **Technical-drawing hatching** for **U (unknown)**. In engineering drawings, section hatching marks a region; here it marks "no evidence". It's the one place pattern appears.

**The one bold thing:** the **profile strip**. Everything else stays quiet, typographic, and disciplined, so the seven measures are what people remember.

### What I rejected during review, and why

| First instinct | Problem | Changed to |
|---|---|---|
| Radar/spider chart for the 7 dimensions | The enclosed area reads as a total, which breaks invariant 1 ("no sums") by implication | Seven separate, side-by-side gauges with no connecting line or shape |
| Green-to-red score colours | Implies 5 is "good" and 0 is "bad"; FALK says outsourcing isn't inferior | A single-hue blued-steel ramp. Darker means *more internal*, not *better* |
| Warm cream, serif headlines, terracotta accent | The default "editorial" look; also looks like any luxury brand site | Cool rhodium greys, a condensed grotesque for display, ruby only for interaction |
| Monospace for dimension codes and dates | A template tell; adds nothing for MA/MM/EX | Archivo's condensed width with tabular figures. It reads like dial and drawing lettering |
| Hairline-ruled broadsheet columns | Generic "newspaper of record" styling | Tonal plates and bridges; borders only where they encode something (relationship type, U) |
| Uppercase tracked labels above every section | Template chrome | Sentence-case headings that say what the section contains |

---

## 3. Design tokens

### 3.1 Colour

Base palette (six named values):

| Name | Hex | Role |
|---|---|---|
| Mainplate | `#E3E6EA` | Page background |
| Bridge | `#F6F7F8` | Raised surfaces: record panels, tables, form fields |
| Blued steel | `#14233F` | Ink: body text, headings, full-level profile fill |
| Graphite | `#4A5361` | Secondary text, metadata, captions |
| Ruby | `#9C1A33` | Links, focus ring, active/selected controls, primary button |
| Gilt | `#A07A2C` | Provisional and disputed states (fills and tints only, never small text) |

Derived tokens:

```css
:root {
  /* surfaces */
  --c-page:          #E3E6EA;   /* mainplate */
  --c-surface:       #F6F7F8;   /* bridge */
  --c-surface-sunk:  #D7DBE1;   /* inset: filter sheet, code of record JSON */
  --c-edge:          #C4CAD3;   /* 1px plate edge, where a boundary is needed */

  /* text */
  --c-ink:           #14233F;   /* 14.8:1 on surface */
  --c-ink-2:         #4A5361;   /* 7.3:1 on surface */
  --c-ink-inverse:   #F6F7F8;

  /* interaction */
  --c-action:        #9C1A33;   /* 7.5:1 on surface */
  --c-action-hover:  #7D1428;
  --c-focus:         #9C1A33;

  /* provisional / disputed */
  --c-gilt:          #A07A2C;
  --c-gilt-tint:     #F1E7D2;   /* banner background; ink text on it */
  --c-gilt-ink:      #6E5218;   /* gilt-coloured text when needed, 6.3:1 */

  /* profile level ramp: one hue, darker = more internal. NOT good→bad. */
  --c-level-0:       transparent;  /* outline only, 1.5px --c-ink-2 */
  --c-level-1:       #D5DCE6;
  --c-level-2:       #AFBCCF;
  --c-level-3:       #7F93B0;   /* ink numeral, 5.0:1 */
  --c-level-4:       #4A6288;   /* inverse numeral, 6.2:1 */
  --c-level-5:       #14233F;   /* inverse numeral */
  --c-level-text-light: var(--c-ink);          /* levels 0–3 */
  --c-level-text-dark:  var(--c-ink-inverse);  /* levels 4–5 */

  /* unknown (U): technical hatching */
  --pattern-unknown: repeating-linear-gradient(
      45deg, var(--c-ink-2) 0 1.5px, transparent 1.5px 6px);
}
```

Dark mode ("blued steel at night"). This uses the same structure, with the plate turned to steel and the ink turned to rhodium:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --c-page:         #0E1726;
    --c-surface:      #16223A;
    --c-surface-sunk: #0A1220;
    --c-edge:         #2A3A57;
    --c-ink:          #DCE2EA;
    --c-ink-2:        #9AA6B8;
    --c-ink-inverse:  #0E1726;
    --c-action:       #EC7A8E;   /* 5.5:1 on gilt tint, 5.9:1 on surface, 6.6:1 on page */
    --c-action-hover: #F28A9B;
    --c-focus:        #EC7A8E;
    --c-gilt:         #C9A25A;
    --c-gilt-tint:    #2E2715;
    --c-gilt-ink:     #D9B871;
    --c-level-1:      #26375A;
    --c-level-2:      #3C5482;
    --c-level-3:      #6680AE;
    --c-level-4:      #9DB1D3;
    --c-level-5:      #DCE2EA;
    /* in dark mode levels 0–2 take light numerals, 3–5 take dark */
  }
}
:root[data-theme="dark"] { /* same values as above */ }
```

**Colour rules**
- Ruby means "interactive", every time. It's never decorative and never used for a score.
- Gilt means "provisional or disputed", every time.
- Scores and confidence never use hue. Only the blued-steel ramp, plus text.
- Every colour-coded thing also carries text (a numeral, a letter, or a word).

### 3.2 Typography

Two families, clearly distinct, both under the OFL licence. Self-host them (the site is static, and this avoids a third-party request).

| Family | Role | Why this one |
|---|---|---|
| **Archivo** (variable: `wdth` 62–125, `wght` 100–900) | Display, UI, dimension codes, numerals, tables | Its condensed widths have the tight, engineered quality of dial printing and drawing lettering, while normal widths stay clean for controls. Tabular lining figures keep the scores aligned. |
| **Source Serif 4** (variable, with optical sizes) | Rationale, claims, excerpts, methodology prose, About | The evidence is long-form reading, and a text serif with optical sizing reads like a careful report, not a brochure. |

Type scale (from the classical scale in *The Elements of Typographic Style*: 12, 14, 16, 18, 21, 24, 36, 48, 72):

| Token | Size / line-height | Family, settings | Use |
|---|---|---|---|
| `--t-hero` | 72 / 72 | Archivo `wdth 68`, `wght 640`, tracking −1% | Home headline only |
| `--t-display` | 48 / 52 | Archivo `wdth 72`, `wght 620` | Record model name, page titles |
| `--t-h2` | 36 / 40 | Archivo `wdth 80`, `wght 580` | Section headings |
| `--t-h3` | 24 / 30 | Archivo `wdth 90`, `wght 560` | Dimension names, sub-sections |
| `--t-lead` | 21 / 32 | Source Serif 4, opsz 20 | Intro paragraphs |
| `--t-prose` | 18 / 29 (1.6) | Source Serif 4, opsz 18 | Rationale, claims, long text |
| `--t-ui` | 16 / 23 (1.45) | Archivo `wdth 100`, `wght 420` | Controls, tables, nav |
| `--t-small` | 14 / 20 | Archivo `wdth 100`, `wght 440` | Metadata, captions, source lines |
| `--t-micro` | 12 / 16 | Archivo `wdth 100`, `wght 500` | Strip numerals (compact), legal |
| `--t-code` | 24 / 24 | Archivo `wdth 62`, `wght 700`, `tnum` | MA/MM/EX… codes and full-strip numerals |

**Type rules**
- Prose measure: max `68ch` (serif). UI text blocks: max `60ch`.
- Sentence case everywhere: headings, buttons, labels. No all-caps labels.
- No single-word emphasis in headlines (no lone italic or coloured word).
- Excerpts (quotations from sources) are set in Source Serif *italic* with a 3px blued-steel left rule. That's the one place a rule appears beside text, because it marks "these are someone else's words".
- Dates are written as `13 Oct 2026` in prose and `2026-10-13` only in data downloads.
- Metadata is never joined with middle dots. Use short labelled pairs (a definition list), or a natural sentence.

### 3.3 Space, layout, shape, motion

```css
:root {
  /* 4px base */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
  --s-5: 24px; --s-6: 32px; --s-7: 48px; --s-8: 64px; --s-9: 96px;

  /* layout */
  --page-max: 1200px;
  --gutter: 16px;            /* mobile side gutter */
  --gutter-lg: 32px;         /* ≥1024px */
  --measure: 68ch;

  /* shape: radius follows hierarchy, not one value for everything */
  --r-instrument: 0;         /* profile cells: measuring marks are square */
  --r-control: 3px;          /* inputs, buttons, chips */
  --r-plate: 6px;            /* panels / surfaces */

  /* elevation: tone, never shadow */
  --edge: 1px solid var(--c-edge);

  /* motion */
  --ease: cubic-bezier(.2, .7, .2, 1);
  --d-quick: 140ms;          /* hover / press */
  --d-open: 220ms;           /* expand / collapse */
  --d-reveal: 480ms;         /* the one load moment (home hero) */
}
```

- **Grid:** 12 columns at ≥1024px, 6 at 640–1023px, and a single column below 640px. Everything is **left-aligned**. Numerals in tables are right-aligned with tabular figures.
- **Breakpoints:** `640px`, `1024px`, `1280px`.
- **Motion:**
  - There is exactly one non-user motion: on the home hero, the two profile strips fill in dimension order once (MA→PD, 60ms stagger).
  - User-triggered motion: dimension rows expand (height plus fade, `--d-open`), the filter sheet slides, and copy confirmations appear.
  - No hover lift on rows, and no section fade-ins.
  - Under `prefers-reduced-motion: reduce`, all of this is instant.
- **Focus:** `2px solid var(--c-focus)` with a `2px` offset on every focusable element. Never removed.
- **Touch targets:** at least 44 × 44px, including the profile cells that toggle a dimension open.

---

## 4. Core components

### 4.1 Profile strip (the signature element)

There are two sizes. Both are real semantic tables, with a caption and headers, so screen readers get "Movement Architecture, 5 of 5" and so on.

**Full strip** (record page, home hero). It has one row per dimension, which reads as seven separate measures, not a shape:

```
MA  ▮▮▮▮▮  5   Movement architecture
MM  ▮▮▮▮▮  5   Movement manufacturing
EX  ▮▮▮▮▮  5   Exterior manufacturing
DH  ▮▮▮▮▮  5   Dial and hands
CF  ▮▮▮▮▮  5   Craft and finishing
WE  ▮▮▮▮▯  4   Watchmaking execution
PD  ▨▨▨▨▨  U   Product development       ← hatched, "Unknown" in text
```

- **Code:** `--t-code`, blued steel.
- **Five segments:** square (`--r-instrument`), 20 × 28px, 3px gap. Filled segments use that row's level colour, and empty ones are outlines. All five segments of a row take the same tone (`--c-level-N`), so the darkness *and* the count both encode the level.
- **Numeral:** `--t-code`.
- **U:** all five segments hatched with `--pattern-unknown`, the numeral replaced by "U", and the name followed by "unknown" in `--c-ink-2`.
- **Whole row is a button** (on the record page) that opens that dimension's evidence below.
- There is **no total, average, or summary row**, ever.

**Compact strip** (index rows, brand lists, supplier pages). Seven 28 × 28px squares in a row, 2px gap, each filled with its level colour, with the numeral centred (`--t-micro`, bold). U cells are hatched with a "U". The dimension codes sit above as column headers in the index table, and appear in a tooltip and in the accessible name elsewhere.

```
 MA MM EX DH CF WE PD
[5][5][5][5][5][5][5]
[0][0][0][5][5][3][3]
[4][0][0][0][0][1][5]
[0][0][0][0][0][U][4]
```

**Confidence D:** the strip is replaced by a hatched plate of the same size, containing the text: "Not enough evidence for a profile yet. Provenance notes are below." No classification is shown (F7).

### 4.2 Other components

| Component | Design |
|---|---|
| **Classification label** | Archivo `wdth 90`, `--t-h3`, ink. A secondary archetype (rank 2) follows on its own line in `--t-ui`, `--c-ink-2`: "with Watchmaking Atelier traits". No pill or badge shape, because it's a description, not a tier. |
| **Independent Watchmaker descriptor** | A plain line under the classification: "Independent watchmaker: Roger W. Smith works on these watches personally." It names the person, since the handbook calls this a human descriptor. |
| **Confidence mark** | A letter in a 28px square with a 1.5px outline (no fill), followed by its meaning in words: **A** Strong primary evidence, **B** Good evidence, limited gaps, **C** Material gaps remain, **D** Sparse or conflicting. |
| **Relationship tag** (provenance) | Shape encodes how internal the work is, and the text always says it. *Internal*: solid blued-steel chip, inverse text. *In-group*: outline chip with a solid left half. *External specialist*: outline chip. *Contract*: dashed outline chip. *Unknown*: hatched chip. Radius `--r-control`. |
| **Source tier** | Words, not colour: "Primary source" in ink, "Secondary source" in `--c-ink-2`. Followed by the source type in natural language ("Manufacturer statement", "Technical interview"). |
| **Claim entry** | Statement (serif, `--t-prose`), excerpt (serif italic with a left rule), then a source line: title (link), tier, "Checked 13 Oct 2026", "Added by editor-handle". Contradicting claims sit under their own heading, "Conflicting evidence", with a gilt left rule instead of blued steel. |
| **Provisional banner** | Full-width gilt-tint band above the record header, ink text: "Provisional record. This profile comes from the v0.2 reference dataset; evidence for each dimension is still being attached." Link: "How records are evidenced". |
| **Buttons** | Primary: ruby fill, inverse text, `--r-control`, Archivo `wght 560`. Secondary: ruby text with a 1.5px ruby outline. The label says exactly what happens ("Send correction", "Download CSV"). No trailing arrows. |
| **Links** | Ruby, underlined with a 1px offset of 3px. Underline thickens to 2px on hover. |
| **Nav** | Wordmark "FALK Index" in Archivo `wdth 68`, `wght 700`, 21px. Links: Records, Methodology, Sources, About; plus a search field that filters records. Active page: ruby 2px underline. On mobile, the links collapse behind a "Menu" button. |
| **Footer** | Short and plain: methodology version (link), data licence, "No paid placement or sponsored scores", contact, and a "Send a correction" link. |

---

## 5. Screens

The ASCII wireframes are desktop (≥1024px) unless noted. On mobile, everything is a single column with a 16px gutter and no horizontal page scroll. Wide tables become stacked rows.

### 5.1 Home

**Hero concept:** the handbook's own founding example, *the model, not the logo*. One brand, J.N. Shapiro, has two watches with radically different profiles, shown side by side as full strips that fill once on load. The point of FALK is understood before any explanation.

```
┌───────────────────────────────────────────────────────────────────┐
│ FALK Index        Records  Methodology  Sources  About  [Search…] │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  How a watch is actually made,          J.N. Shapiro              │
│  and the evidence for it.               Infinity      Resurgence  │
│  (hero, 72/72, cond.)                   MA ▯▯▯▯▯ 0    ▮▮▮▮▮ 5      │
│                                         MM ▯▯▯▯▯ 0    ▮▮▮▮▮ 5      │
│  Seven measures of where the work       EX ▯▯▯▯▯ 0    ▮▮▮▮▮ 5      │
│  happens: movement, case, dial,         DH ▮▮▮▮▮ 5    ▮▮▮▮▮ 5      │
│  craft, assembly and development.       CF ▮▮▮▮▮ 5    ▮▮▮▮▮ 5      │
│  Each one links to its sources.         WE ▮▮▮▯▯ 3    ▮▮▮▮▮ 5      │
│  (lead, serif)                          PD ▮▮▮▯▯ 3    ▮▮▮▮▮ 5      │
│                                         Same maker. Different     │
│  [Browse 56 records]  Read the method   watches. Different routes.│
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│  A profile is not a ranking                                       │
│  (h2) Outsourcing to a world-class specialist isn't inferior to   │
│  making a part in-house. Darker means more of the work happens    │
│  inside the brand, not that the watch is better. Scores are never │
│  added together. (prose, max 68ch)                                │
├───────────────────────────────────────────────────────────────────┤
│  The seven dimensions                                             │
│  MA Movement architecture   Who engineered the caliber?           │
│  MM Movement manufacturing  Who physically makes its parts?       │
│  …                          (two-column list on desktop; each     │
│                              row links to Methodology#ma etc.)    │
├───────────────────────────────────────────────────────────────────┤
│  Records that test the method                                     │
│  Fleming Series 1     [compact strip]  High design and movement   │
│                                        authorship, little made    │
│                                        in-house.                  │
│  Artur Akmaev Koi     [compact strip]  Master craft on an         │
│                                        external movement.         │
│  AWAKE / anOrdain     [compact strips] Artisan work done by       │
│                                        partners vs. in-house.     │
│  Czapek Antarctique   [compact strip]  Designed in-house, made by │
│                                        partners.                  │
├───────────────────────────────────────────────────────────────────┤
│  How this was built (small): AI transparency note, verbatim intent│
│  from the handbook, link to About.                                │
├───────────────────────────────────────────────────────────────────┤
│ footer                                                            │
└───────────────────────────────────────────────────────────────────┘
```

- **Mobile:** headline (48px) → lead → the two strips stacked as one table with two value columns (Infinity | Resurgence) so they still compare row by row → buttons.
- **Copy note:** the hero sentence is plain and descriptive, with no slogan. "Provenance over prestige" appears once, in the footer.

### 5.2 Records (Index)

**Concept:** a working instrument for comparing records. The filters are precise, the table is dense but calm, and sorting never offers anything that looks like "best".

```
┌───────────────────────────────────────────────────────────────────┐
│ nav                                                               │
├───────────────────────────────────────────────────────────────────┤
│  Records                                         (display)        │
│  56 watches, each profiled by model, reference or production      │
│  route. (lead)                                                    │
├──────────────────┬────────────────────────────────────────────────┤
│ Filter (sunk     │  38 of 56 records        Sort: [Brand A–Z ▾]   │
│ plate, sticky)   │                          (Brand, Model, Years)  │
│                  │ ┌─────────────┬──────────┬───────────────┬─┬──┐ │
│ Search           │ │Brand  Model │MA…PD     │Classification │C│Yr│ │
│ [ Shapiro     ]  │ ├─────────────┼──────────┼───────────────┼─┼──┤ │
│                  │ │J.N. Shapiro │[5][5]…   │Integrated     │A│23│ │
│ Dimensions       │ │Resurgence   │          │Manufacture    │ │– │ │
│ MA  min[0▾] max[5▾]│ ├─────────────┼──────────┼───────────────┼─┼──┤ │
│ MM  min[0▾] max[1▾]│ │Fleming      │[4][0]…   │Design-led     │B│  │ │
│ …   ☐ include U  │ │Series 1     │          │Établisseur    │ │  │ │
│                  │ │ ⚑ provisional (gilt mark + word)           │ │
│ Classification   │ └─────────────┴──────────┴───────────────┴─┴──┘ │
│ ☐ Integrated M.  │                                                │
│ ☐ Design-led É.  │  Each row is one link to the record.           │
│ …                │                                                │
│ Confidence       │                                                │
│ ☐A ☐B ☐C ☐D      │                                                │
│ Ownership        │                                                │
│ ☐ Independent    │                                                │
│ ☐ Group-owned    │                                                │
│ Scale  [Any ▾]   │                                                │
│ [Clear filters]  │                                                │
└──────────────────┴────────────────────────────────────────────────┘
```

- **Column order:** model, profile, classification, confidence, years. Classification sits *after* the profile ("classification comes last").
- **Dimension range filter:** paired min/max selects per dimension, plus "include unknown (U)". This is how a reader finds "MA ≥ 4 and MM ≤ 1".
- **Sort options:** brand, model, production years. There is deliberately **no sort by any score**, not even a single dimension. A reader wanting "highest MA" filters MA to 5 instead, which is a set, not a ranking.
- **Filter state** lives in the URL query, so a filtered view can be shared and cited.
- **Empty state:** "No records match these filters. Widen a dimension range or remove a classification." Button: "Clear filters".
- **Mobile:** a "Filter (3)" button opens the filters as a full-height sheet (slides up, `--d-open`). Rows become stacked items: brand (small) and model (h3), compact strip, then classification and confidence on one line.

### 5.3 Watch record

**Concept:** a provenance sheet. The profile comes first, the judgment (classification) after it, and every measure can be opened to show its evidence in place. This is the most important screen.

```
┌───────────────────────────────────────────────────────────────────┐
│ nav                                                               │
├───────────────────────────────────────────────────────────────────┤
│ ▒ Provisional record. This profile comes from the v0.2 reference  │
│ ▒ dataset; evidence is still being attached. How records are      │
│ ▒ evidenced (link)                          (gilt tint band)      │
├───────────────────────────────────────────────────────────────────┤
│ J.N. Shapiro (link, small)                                        │
│ Resurgence                                    (display 48)        │
│ Reference: —   Caliber: JNS-2   Made: 2023 to present (dl, small) │
│                                                                   │
│ ┌ Profile (bridge plate) ──────────────┐ ┌ Summary (bridge) ────┐ │
│ │ MA ▮▮▮▮▮ 5 Movement architecture  ⌄  │ │ Classification       │ │
│ │ MM ▮▮▮▮▮ 5 Movement manufacturing ⌄  │ │ Integrated           │ │
│ │ EX ▮▮▮▮▮ 5 Exterior manufacturing ⌄  │ │ Manufacture (h3)     │ │
│ │ DH ▮▮▮▮▮ 5 Dial and hands         ⌄  │ │ Independent          │ │
│ │ CF ▮▮▮▮▮ 5 Craft and finishing    ⌄  │ │ watchmaker: Joshua   │ │
│ │ WE ▮▮▮▮▮ 5 Watchmaking execution  ⌄  │ │ Shapiro works on…    │ │
│ │ PD ▮▮▮▮▮ 5 Product development    ⌄  │ │ Evidence: [A] Strong │ │
│ └──────────────────────────────────────┘ │ primary evidence     │ │
│                                          │ Scored with v0.2,    │ │
│  Not a ranking. Darker means more of     │ version 3, updated   │ │
│  the work is done inside the brand.      │ 13 Oct 2026          │ │
│  (small, ink-2, under strip)             │ [Send a correction]  │ │
│                                          └──────────────────────┘ │
├───────────────────────────────────────────────────────────────────┤
│ Evidence by dimension                                     (h2)    │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ MA 5  Deep proprietary caliber engineering mastered          ⌃ │ │
│ │       internally (level descriptor, h3)                        │ │
│ │  Rationale (serif prose, 68ch):                                │ │
│ │  The movement was conceived and engineered in the workshop…   │ │
│ │                                                                │ │
│ │  Supporting evidence (3)                                       │ │
│ │  ┃ Movement designed and built in the Los Angeles workshop.   │ │
│ │  ┃ "…every component is made by hand in our workshop…"       │ │
│ │  ┃ (italic excerpt)                                           │ │
│ │    jnshapirowatches.com: Watches   Primary source,           │ │
│ │    manufacturer statement   Checked 7 Oct 2026   Added by mt │ │
│ │                                                                │ │
│ │  Conflicting evidence (0): none recorded (only shown if >0)   │ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ MM 5  Exceptional integration including escapement…        ⌄ │ │
│ │ …                                                             │ │
│ └───────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────────┤
│ Who makes what                                     (h2)           │
│ Area                  Component    Made by         Relationship   │
│ Movement manufacture  Plates       J.N. Shapiro   [Internal]      │
│ Movement manufacture  Hairspring   Unknown        [▨ Unknown]     │
│ Exterior              Case         J.N. Shapiro   [Internal]      │
│ …   (grouped by dimension; years shown when an entry is dated)    │
├───────────────────────────────────────────────────────────────────┤
│ History                                            (h2)           │
│ Version 3   13 Oct 2026   editor-handle                           │
│   Added hairspring evidence; DH unchanged. (change note, serif)   │
│   Compare with version 2 (link)                                   │
│ Version 2   …                                                     │
│ Version 1   7 Oct 2026   Imported from the v0.2 reference dataset │
├───────────────────────────────────────────────────────────────────┤
│ Use this record: Download JSON (link)    Send a correction (link) │
└───────────────────────────────────────────────────────────────────┘
```

(The caliber name, quotation and workshop location in the wireframe are placeholders for layout, not research.)

- **Clicking a strip row** (in the profile plate) scrolls to that dimension in "Evidence by dimension" and opens it. Rows are `<button aria-expanded>`, and opening one updates the URL hash (`#evidence-mm`) so evidence can be linked directly.
- **All rows start closed**, except when a hash is present. An "Open all" toggle sits at the right of the h2.
- **Seed records** (no claims yet): each dimension's panel reads "No evidence attached yet. This score comes from the v0.2 reference dataset." with a link to send evidence.
- **Confidence D:** the profile plate becomes the hatched notice (§4.1), the Summary panel omits the classification, and "Who makes what" moves up to sit directly under the header.
- **Compare versions:** a simple two-column view of the 7 rows for version N and version N−1, with changed rows marked by a gilt left rule, and the change note above.
- **Mobile:** header → banner → profile plate (full width) → summary as a plain stacked section below it → evidence accordion → "Who makes what" as stacked entries (area heading, then component, maker, and relationship tag per item) → history.

### 5.4 Methodology

**Concept:** the handbook as a stable reference document, readable start to finish and linkable by section.

```
┌───────────────────────────────────────────────────────────────────┐
│ nav                                                               │
├──────────────┬────────────────────────────────────────────────────┤
│ Contents     │ Methodology                       Version [v0.2 ▾] │
│ (sticky)     │ Published October 2026. Changes need a version     │
│ Why FALK     │ bump; earlier profiles keep their original version.│
│ Rules        │                                                    │
│ Dimensions   │ Foundational rules                         (h2)    │
│  MA … PD     │ Model first                                (h3)    │
│ Provenance   │ Score an exact reference, generation or production │
│ Confidence   │ route whenever possible. (prose)                   │
│ Classific.   │ Unknown is not zero                                │
│ How to use   │ …  (rules are named, not numbered: not a sequence) │
│ Changelog    │                                                    │
│              │ Movement architecture (MA)                 (h2)    │
│              │ Who is responsible for the caliber's mechanical    │
│              │ architecture and engineering? (lead)               │
│              │  0  Stock third-party caliber                      │
│              │  1  Cosmetic/custom specification                  │
│              │  …  (numbered: the 0–5 levels ARE an ordinal scale)│
│              │  5  Deep proprietary caliber engineering…          │
│              │  each level shows its segment swatch (▮▮▯▯▯)       │
│              │ …                                                  │
│              │ How to use the FALK Index                  (h2)    │
│              │  1 Identify the exact watch…  (numbered: real      │
│              │  2 Build the provenance sheet…  sequence of steps) │
└──────────────┴────────────────────────────────────────────────────┘
```

- All text is rendered from `methodology/v0.2.yaml`, so the site and the data can't disagree.
- Each level row shows its swatch from the level ramp, which teaches the strip's visual language.
- Classifications are a definition list: name (h3), definition (prose), then "Records with this classification (n)" as a link to the Records page pre-filtered.
- **Mobile:** contents collapse into a "Jump to section" select at the top.

### 5.5 Brand

**Concept:** a directory page that collects records but never summarizes them into a brand verdict.

```
┌───────────────────────────────────────────────────────────────────┐
│ Christopher Ward                                (display)         │
│ Ownership: Independent   Country: United Kingdom                  │
│ Website: christopherward.com                       (dl, small)    │
│                                                                   │
│ FALK profiles describe individual watches. This page lists them;  │
│ it does not score the brand. (small, ink-2)                       │
├───────────────────────────────────────────────────────────────────┤
│ Records (2)                                        (h2)           │
│ The Twelve        [0][0][0][0][0][2][3]   Contract / Microbrand  A│
│ C1 Bel Canto      [3][1][0][0][1][3][5]   Design-led Établisseur A│
├───────────────────────────────────────────────────────────────────┤
│ Suppliers and partners named in these records      (h2)           │
│ Sellita (movement base)   linked organization pages               │
└───────────────────────────────────────────────────────────────────┘
```

(The Sellita entry is placeholder content for layout.)

- Records use the same row pattern as the Records page, with compact strips.
- The handbook's point about one brand covering several production routes (the Shapiro example) is made visible: when a brand's records differ, its compact strips stack directly, with no averaging.

### 5.6 Organization / supplier (Phase 4, F14)

This uses the same template as Brand, but leads with "Where this organization appears":

```
Kenissi                                       (display)
Movement manufacturer. Part-owned by the Rolex/Tudor group.
───────────────────────────────────────────────
Where Kenissi appears                          (h2)
Movement manufacturing
  Tudor Black Bay 58 (MT5402)       [In-group]
  …other brands                      [External specialist]
```

(The ownership line is placeholder layout copy; the real text comes from the organization record and its claims.)

Entries are grouped by dimension (area), and each shows the relationship tag, since the same supplier can be in-group for one brand and external for another.

### 5.7 Sources

```
Sources                                        (display)
Every claim on this site links to one of these. Primary sources come
from the manufacturer, workshop or a named supplier; secondary
sources corroborate them.                      (lead)

[All] [Primary] [Secondary]     (segmented control, ruby = selected)

Rolex                                          (h3, grouped by publisher)
  A unique approach to watchmaking            Primary source,
  rolex.com/watchmaking/a-unique-approach     manufacturer statement
  Archived copy   Cited by 2 records (Submariner 124060, …)
Caliber Corner
  calibercorner.com                           Secondary source,
                                              specialist reference
```

- Grouped by publisher, alphabetical. "Archived copy" links to the Wayback snapshot.
- **Mobile:** same list, single column. The tier and type move under the title.

### 5.8 Send a correction

**Concept:** brands, watchmakers and readers are invited to argue *with evidence*. The form asks for exactly that, and nothing else.

```
┌──────────────────────────────────────────┬────────────────────────┐
│ Send a correction               (display)│ How corrections work   │
│                                          │ (sunk plate, prose)    │
│ Which record?                            │ An editor checks every │
│ [ Search records…          ▾ ]           │ correction against its │
│ (pre-filled when opened from a record)   │ sources. Accepted      │
│                                          │ changes appear in the  │
│ Who are you?                             │ record's history with  │
│ ( ) The brand  ( ) The watchmaker        │ a change note.         │
│ ( ) A reader   ( ) Other                 │                        │
│                                          │ Brands and watchmakers │
│ What should change, and why?             │ have a right of reply; │
│ [                                     ]  │ if a claim is disputed │
│ [                                     ]  │ it stays visible.      │
│                                          │                        │
│ Evidence links                           │ We don't accept paid   │
│ [ https://…                           ]  │ changes of any kind.   │
│ Add another link                         │                        │
│                                          │                        │
│ Name (optional)   Email (optional)       │                        │
│ Your email is only used to reply.        │                        │
│ It's never published.                    │                        │
│                                          │                        │
│ [Send correction]                        │                        │
└──────────────────────────────────────────┴────────────────────────┘
```

- **Validation copy** (inline, under the field, ink text with a ruby icon, focus moved to the first error):
  - "Choose the record this correction is about."
  - "Describe what should change."
  - "Add at least one link to evidence. Corrections without sources can't be reviewed."
  - "This link isn't a full web address. Start it with https://."
- **Success:** replaces the form in place: "Correction sent. An editor will review it against the sources you linked. If you left an email, you'll hear back there." Link: "Back to the record".
- **Failure (network/service):** "Correction not sent. The form service didn't respond. Your text is still here; try again, or email corrections@… with the same details."
- **Mobile:** the policy panel moves *above* the form as a short collapsible "How corrections work".

### 5.9 About

A prose page in Source Serif at a 68ch measure, with sections:

- What FALK is
- Editorial independence (no paid placement, no paid score changes, no sponsor weighting)
- How AI was used (the handbook's transparency note, verbatim)
- Who publishes this (Q11)
- Data licence (Q5)
- Contact

It has no imagery. A single full strip of a real record sits beside "What FALK is" as the only visual, and it links to that record.

### 5.10 Data

```
Data                                           (display)
The full dataset is open. Use it, check it, build on it. (lead)

Full dataset
  Download JSON (all records, provenance, claims, sources)  1.2 MB
  Download CSV (one row per record; profile, classification, confidence)
  Built 13 Oct 2026 from commit 1f2310e (link to the repo commit)

Single records
  Every record has a JSON link at the bottom of its page:
  /records/jn-shapiro/resurgence.json

Licence
  Data: CC BY-SA 4.0. Code: MIT. (per Q5)

Schema
  Field-by-field description (rendered from the Zod schemas)
```

The CSV includes the seven dimension columns with `U` as an empty cell plus a `ma_unknown`-style flag. There's no total column.

### 5.11 System states

| State | Design |
|---|---|
| **404** | "There's no record at this address. It may have been renamed when a reference was split into generations." Search field and "Browse all records". |
| **Search with no results** | "No records match 'xyz'. Search covers brand, model, reference and caliber." |
| **Loading** | None needed (static pages). The Records filters run client-side on the pre-rendered table, with no spinner. |
| **JavaScript off** | Records shows the full unfiltered table (server-rendered). Evidence accordions are `<details>` elements, so they still open. The correction form posts normally. |
| **Print** | Record pages print the full strip, summary, all evidence (opened), and the URL with version number. Nav and footer are hidden. |

---

## 6. Principles (checklist for every screen)

1. **The profile comes first, the classification last**, in reading order and in DOM order.
2. **No shape that implies a total.** No radar charts, stacked bars, or summary rows.
3. **One hue for scores.** Darker means more internal, never "better".
4. **U looks different from 0** (hatched instead of empty) and always says "Unknown" in text.
5. **Ruby is for action, gilt is for provisional or disputed.** Neither has any other use.
6. **Evidence is one click from any score**, and every claim shows its source, tier, and the date it was checked.
7. **Plain words.** Sentence case, no marketing adjectives, no all-caps labels, no middle-dot meta strings, no arrow suffixes.
8. **The quality floor:**
   - Lighthouse accessibility ≥ 95
   - Visible focus
   - 44px targets
   - Reduced motion respected
   - Works without JavaScript
   - No horizontal scroll at 320px

---

## 7. Implementation notes

- **Styling:** plain CSS with the custom properties above, in `src/styles/tokens.css`. Components are Astro components (`ProfileStrip.astro` with `size="full" | "compact"`, `ClaimEntry.astro`, `RelationshipTag.astro`, `ConfidenceMark.astro`, `ProvisionalBanner.astro`).
- **Fonts:** `archivo-variable.woff2` and `source-serif-4-variable.woff2`, self-hosted, `font-display: swap`. Preload Archivo only, since it's used above the fold.
- **The strip's numerals** use `font-variant-numeric: tabular-nums` and `font-variation-settings: "wdth" 62`.
- **The `--pattern-unknown` hatching** must keep a 3:1 contrast against the surface in both themes (WCAG non-text contrast). Check it in the CI Lighthouse run.
- **The one load animation** (home hero) is CSS-only (`@keyframes` with `animation-delay` per row), wrapped in `@media (prefers-reduced-motion: no-preference)`.
