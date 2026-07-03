// Extractor tests. Two suites:
//   1. Local fixture (fixtures/bank.html) - controlled inaccessible bank page.
//   2. Live W3C "Before and After" demo - a real deliberately inaccessible
//      site (CityLights), https://www.w3.org/WAI/demos/bad/before/home.html
//
// Run with: npm run test:extractor

import { chromium, Browser } from 'playwright';
import { pathToFileURL } from 'url';
import * as path from 'path';
import { extractPage, ExtractionResult } from './extractor';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Extracted {
  result: ExtractionResult;
  stampedCount: number;
}

const PUNCT_ONLY = (e: any) =>
  e.kind === 'text' && !/[\p{L}\p{N}]/u.test(e.text);

async function extract(browser: Browser, url: string): Promise<Extracted> {
  const page = await browser.newPage();
  // tsx/esbuild wraps functions with a __name helper that doesn't exist in
  // the page; stub it so the serialized extractPage can run there.
  await page.addInitScript(() => {
    (window as any).__name = (fn: unknown) => fn;
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  const result: ExtractionResult = await page.evaluate(extractPage);
  // Verify the ids we emitted were actually stamped onto the live DOM —
  // that's the write-back contract.
  const stampedCount = await page.evaluate(
    () => document.querySelectorAll('[data-poc-id]').length
  );
  await page.close();
  return { result, stampedCount };
}

function commonChecks({ result, stampedCount }: Extracted): Check[] {
  const els = result.elements;
  return [
    {
      name: 'no punctuation-only text entries',
      ok: !els.some(PUNCT_ONLY),
    },
    {
      name: 'ids are unique',
      ok: new Set(els.map((e) => e.id)).size === els.length,
    },
    {
      name: 'every emitted id is stamped on the live DOM',
      ok: stampedCount === els.length,
      detail: `stamped=${stampedCount} emitted=${els.length}`,
    },
  ];
}

function fixtureChecks(ex: Extracted): Check[] {
  const els = ex.result.elements;
  const byKind = (kind: string) => els.filter((e: any) => e.kind === kind);
  const allText = JSON.stringify(els);

  return [
    {
      name: 'page title captured',
      ok: ex.result.page.title === 'MyBank - Transfer',
    },
    {
      name: 'fake heading (styled div) captured as text',
      ok: els.some(
        (e: any) => e.kind === 'text' && e.text === 'Transfer between accounts'
      ),
    },
    {
      name: 'error banner captured with alert flag',
      ok: els.some(
        (e: any) => e.alert === true && /greater than zero/.test(e.text)
      ),
    },
    {
      name: 'unlabeled input got label from preceding text ("Amount")',
      ok: els.some((e: any) => e.kind === 'input' && e.label === 'Amount'),
    },
    {
      name: 'placeholder-only input got label ("Reference note")',
      ok: els.some(
        (e: any) => e.kind === 'input' && e.label === 'Reference note'
      ),
    },
    {
      name: 'select captured with 2 options and label "To account"',
      ok: els.some(
        (e: any) =>
          e.kind === 'select' &&
          e.label === 'To account' &&
          e.options.length === 2
      ),
    },
    {
      name: 'checkbox got label from following text ("Save as payee")',
      ok: els.some(
        (e: any) => e.kind === 'checkbox' && e.label === 'Save as payee'
      ),
    },
    {
      name: 'div-with-onclick captured as button ("Continue")',
      ok: els.some((e: any) => e.kind === 'button' && e.text === 'Continue'),
    },
    {
      name: 'cancel link captured',
      ok: els.some((e: any) => e.kind === 'link' && e.text === 'Cancel'),
    },
    {
      name: 'real h2 captured as heading level 2',
      ok: els.some(
        (e: any) =>
          e.kind === 'heading' && e.level === 2 && e.text === 'Recent transfers'
      ),
    },
    {
      name: 'image without alt captured with alt: null',
      ok: byKind('image').some((e: any) => e.alt === null),
    },
    {
      name: 'hidden element excluded',
      ok: !allText.includes('debug panel'),
    },
    {
      name: 'checkbox label text not duplicated as text entry',
      ok: !els.some(
        (e: any) => e.kind === 'text' && e.text === 'Save as payee'
      ),
    },
    {
      name: 'footer links captured (Help, Contact, terms)',
      ok: ['Help', 'Contact', 'terms'].every((t) =>
        els.some((e: any) => e.kind === 'link' && e.text === t)
      ),
    },
    {
      name: 'text with substance kept around inline links (copyright line)',
      ok: els.some(
        (e: any) => e.kind === 'text' && /© 2026 MyBank/.test(e.text)
      ),
    },
    ...commonChecks(ex),
  ];
}

// The W3C BAD page is not ours, so assert its *known* accessibility failures
// surface in the extraction rather than exact element counts.
function citylightsChecks(ex: Extracted): Check[] {
  const els = ex.result.elements;
  return [
    {
      name: 'page title captured (CityLights)',
      ok: /CityLights/i.test(ex.result.page.title),
    },
    {
      name: 'h1 captured',
      ok: els.some((e: any) => e.kind === 'heading' && e.level === 1),
    },
    {
      name: 'unlabeled QUICKMENU select captured (label null, 10+ options)',
      ok: els.some(
        (e: any) =>
          e.kind === 'select' && e.label === null && e.options.length >= 10
      ),
    },
    {
      name: 'images missing alt surface as alt: null',
      ok: els.some((e: any) => e.kind === 'image' && e.alt === null),
    },
    {
      name: 'image-based nav links surface as links with empty text',
      ok: els.some((e: any) => e.kind === 'link' && e.text === ''),
    },
    {
      name: 'meaningless "Click here" link text surfaced',
      ok: els.some((e: any) => e.kind === 'link' && /click here/i.test(e.text)),
    },
    {
      name: 'main content text captured (Welcome to CityLights)',
      ok: els.some(
        (e: any) => e.kind === 'text' && /Welcome to CityLights/.test(e.text)
      ),
    },
    ...commonChecks(ex),
  ];
}

function report(suite: string, checks: Check[]): number {
  console.log(`\n=== ${suite} ===`);
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? 'PASS' : 'FAIL';
    if (!c.ok) failed++;
    console.log(`${mark}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  return failed;
}

async function main(): Promise<void> {
  const fixtureUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'fixtures', 'bank.html')
  ).href;
  const citylightsUrl = 'https://www.w3.org/WAI/demos/bad/before/home.html';

  const browser = await chromium.launch();

  let failed = 0;
  let total = 0;

  const fixtureEx = await extract(browser, fixtureUrl);
  const fChecks = fixtureChecks(fixtureEx);
  failed += report('Local fixture: bank.html', fChecks);
  total += fChecks.length;

  try {
    const cityEx = await extract(browser, citylightsUrl);
    const cChecks = citylightsChecks(cityEx);
    failed += report('Live: W3C CityLights (inaccessible demo)', cChecks);
    total += cChecks.length;
  } catch (err) {
    console.log(`\n=== Live: W3C CityLights (inaccessible demo) ===`);
    console.log(`SKIP  could not load site: ${(err as Error).message}`);
  }

  await browser.close();

  console.log(`\n${total - failed}/${total} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
