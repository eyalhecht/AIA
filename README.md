# AIA - Accessible Interface Anywhere

[![CI](https://github.com/eyalhecht/AIA/actions/workflows/ci.yml/badge.svg)](https://github.com/eyalhecht/AIA/actions/workflows/ci.yml)

AIA loads a web page in headless Chromium, extracts what is on it (headings,
text, links, buttons, form fields, images) and re-renders it as plain HTML that
passes [axe-core](https://github.com/dequelabs/axe-core) with zero violations.
Forms on the regenerated page still work: what you type and click there is
replayed onto the real page.

**Status:** working prototype. It runs locally, is tested in CI, and has no
releases. Not hardened for use as a public service.

## Why rebuild the page instead of fixing it

Most accessibility tooling either reports problems (axe, Lighthouse) or patches
the broken page in place (overlay scripts), which leaves the original DOM
with fixes layered on top. AIA throws the original markup away and renders the
content again from templates written to pass axe. The test suite runs axe on
every page it generates and requires zero violations.

Reader modes take a similar approach, but they are read-only and drop forms.
AIA keeps the original page open in the background, so the regenerated page can
fill in and submit the original's forms.

On the pages in the test suite (axe violations before -> after):

- W3C "Before and After" inaccessible demo, home and survey: 7 -> 0 each
- Hacker News: 7 -> 0
- example.com: 3 -> 0
- local fixtures `bank.html` and `form.html`: 7 -> 0 each

Live sites change, so these numbers are what `npm run test:a11y` printed
when this README was written, not a guarantee.

## Quick start

Requires Node 22 (the version CI runs) and a Chromium that Playwright can
download.

```bash
npm install
npx playwright install chromium   # on Linux add --with-deps for system libraries

npm run viewer                    # open http://localhost:4173 and enter any URL
```

Other entry points:

```bash
npm run viewer -- 5000              # viewer on another port
npm run extract -- <url>            # print the extraction JSON for a page
npm run extract -- <url> --summary  # element counts by kind
npm run enhance -- <url>            # LLM-enhanced render written to out/enhanced.html
npm run typecheck
npm test                            # all test suites
```

The enhance step (optional) calls OpenAI `gpt-4o-mini`. It reads
`OPENAI_API_KEY` from the environment or from a `.env` file in the repo root.
It sends the extracted elements (text, labels, link URLs) to OpenAI, and the viewer says so next to
the checkbox that turns it on. Everything else runs locally.

## How it works

```
original page -> extract -> (enhance) -> render -> verify
                 JSON       LLM plan     HTML      axe-core
```

1. **Extract** (`src/extractor.ts`) runs inside the page and returns a flat
   list of elements. Labels come from the W3C accessible-name algorithm
   ([dom-accessibility-api](https://github.com/eps1lon/dom-accessibility-api))
   first. When a page wires up nothing, heuristics take over: nearby text,
   placeholder, the next text node after a checkbox, `alt`/`title` inside
   icon-only links. `<div onclick>` and `role="button"` become buttons. Every
   element is stamped with a `data-poc-id` attribute so it can be found again
   for write-back.
2. **Enhance** (`src/enhance.ts`, optional) asks an LLM for a plan: group
   elements into sections, rename links like "Click here", fill missing labels,
   drop boilerplate. `applyPlan` only accepts plans that reference existing
   ids. It never overwrites a label the page provided and never drops a form
   control or button. Bad JSON, a network error or a 30-second timeout falls
   back to the unenhanced extraction.
3. **Render** (`src/renderer.ts`) produces a self-contained page: one `<main>`,
   heading levels that never skip, a `<label for>` on every control, a
   `<fieldset>` per radio group, generated names where the original had none,
   high-contrast CSS with a visible focus ring.
4. **Verify** (`src/axe.ts`) runs axe-core on the original and on the output.

The viewer (`src/viewer.ts`) is a plain `http` server. `/view?url=` opens the
page in a Playwright tab and keeps it as a session (closed after about 5 idle
minutes, 10 at most). The regenerated page is one form that posts to `/act`. The server
sets values on the real fields, fires `input` and `change` so frameworks
notice, clicks the real button by its `data-poc-id`, then extracts and renders
again. Links go back through `/view`, so you stay in the accessible version
while you browse.

## Tests

Each suite is a script that prints PASS/FAIL per check and exits non-zero on
failure. There is no test framework.

- `test:renderer` - renderer rules on hand-written input, including ids and
  links forged by a hostile page. No browser.
- `test:extractor` - extraction on the bank fixture plus live sites (W3C demo,
  example.com, GitHub login as a well-built control, Hacker News).
- `test:a11y` - for each page, the original must have violations and the
  output must have none.
- `test:viewer` - home page, link rewriting, error pages, a full write-back
  round trip on `fixtures/form.html`, loopback-only binding, axe on everything
  served.
- `test:enhance` - plan guardrails with a fake LLM. No network.

Live sites skip when they cannot be reached. If one changes its content, its
checks can fail, and that is the main source of flakiness.

## Limits

- The viewer is a local tool. It listens on 127.0.0.1 only, because it
  will open `file:` URLs and anything else the machine can reach.
- The extractor runs in the page's own JavaScript context, so a hostile page
  can change what it reports. The renderer escapes everything it outputs and
  drops non-web links, but the content itself is only as trustworthy as the
  page.
- Not read: shadow DOM, iframes, canvas, custom ARIA widgets (`role="tab"`,
  comboboxes).
- Table-layout forms, where the label sits in a different cell from the
  control, defeat the label heuristics. The LLM step partly compensates.
- The LLM can rename any link or button, not only meaningless ones. The
  guardrails limit which elements it touches, not what it writes.
- Pressing Enter in a regenerated text field submits with the first button in
  the form, as any HTML form does. That may not be the button the original
  page would have used.
- Very large pages (Wikipedia, about 1,300 elements) make the LLM prompt
  expensive. There is no main-content detection yet.

## Licence

All rights reserved; the code is public to read, not to reuse ([LICENSE](LICENSE)).
