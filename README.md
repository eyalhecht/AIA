# AIA — Accessible Interface Anywhere

Many websites are inaccessible: missing labels, div-soup buttons, no
landmarks, broken contrast. Instead of waiting for site owners to fix their
UI, AIA regenerates the interface on demand: it reads any page's semantics
and serves a clean, verified-accessible version of it.

**The proof, per page:** the original has axe-core violations; the AIA
version of the same page has **zero**. Currently demonstrated on the W3C
"Before and After" inaccessible demos (7 violations → 0), Hacker News
(7 → 0), example.com (2 → 0) and a local bank-page fixture (7 → 0).

## Pipeline

```
 original page ──► extract ──► (enhance) ──► render ──► verify
                 semantics      LLM plan     semantic     axe-core
                 as JSON        (optional)   HTML + CSS   0 violations
```

1. **Extract** (`src/extractor.ts`) — runs inside the page, emits a compact
   JSON inventory: headings, text, links, buttons, form controls, images.
   Labels come from the W3C accessible-name algorithm
   (`dom-accessibility-api`) first; when the page wires up nothing, repair
   heuristics recover labels from nearby text, `onclick` divs are classified
   as buttons, icon-only links take names from descendant `alt`/`title`.
   Every element is stamped with `data-poc-id` — the future write-back
   contract.
2. **Enhance** (`src/enhance.ts`, optional) — an LLM returns a plan: group
   content into sections, rename meaningless links ("Click here"), infer
   missing labels, drop boilerplate. Guardrails enforce that it can only
   reorganize — never invent content, never override a real label, never
   drop a control. Failures fall back to the deterministic path.
3. **Render** (`src/renderer.ts`) — deterministic templates produce a
   self-contained page: one `<main>`, normalized heading order, `<label for>`
   on every control, fieldsets for radio groups, derived names where the
   original had none, high-contrast CSS with visible focus.
4. **Verify** (`src/axe.ts`) — axe-core runs on both the original and the
   regenerated page; tests require zero violations on everything AIA serves.

## Usage

```bash
npm install
npx playwright install chromium

npm run viewer               # accessible browsing at http://localhost:4173
npm run extract -- <url>     # print the extraction JSON for a page
npm run enhance -- <url>     # LLM-enhanced render -> out/enhanced.html
npm test                     # extractor + a11y + viewer + enhancement suites
```

The enhancement stage needs `OPENAI_API_KEY` in the environment or in a
local `.env` (gitignored). Everything else runs fully offline/deterministic.

## Testing philosophy

- `test:extractor` — 49 checks: extraction fidelity on a controlled
  inaccessible fixture plus live sites (W3C demo, example.com, GitHub login
  as a well-built control group, Hacker News for table layouts/icon links).
- `test:a11y` — the core before/after proof per site: original page must
  have violations, regenerated page must have zero.
- `test:viewer` — the server flow, link rewriting, accessible error pages,
  axe-clean on everything served.
- `test:enhance` — LLM guardrails with a faked model; no network in tests.

Live-site suites skip gracefully when a site is unreachable; only local
fixtures can hard-fail the build.

## Known limitations / next steps

- **Read-mostly for now**: links navigate through the viewer, but form
  submissions and button clicks are not yet replayed onto the original page
  (the `data-poc-id` mapping exists for exactly that).
- Table-layout forms (labels in a different cell than the control) still
  defeat the heuristics; the LLM label inference partially compensates.
- Very large pages (Wikipedia: ~1300 elements) need main-content detection
  before the LLM stage is affordable.
- Custom ARIA widgets (`role="tab"`, comboboxes) are not yet classified.
- End goal: a browser extension running the same extractor as a content
  script, replacing the page in place.
