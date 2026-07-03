// End-to-end accessibility proof:
//   1. The original page has axe violations (it really is inaccessible).
//   2. Our regenerated view of the SAME page has zero axe violations.
//
// Run with: npm run test:a11y

import { chromium, Browser } from 'playwright';
import { pathToFileURL } from 'url';
import * as path from 'path';
import { runExtractor } from './harness';
import { renderAccessible } from './renderer';
import { runAxe, formatViolations, AxeViolation } from './axe';

interface SiteResult {
  name: string;
  skipped?: string;
  before?: AxeViolation[];
  after?: AxeViolation[];
}

interface Site {
  name: string;
  url: string;
  // Local pages must run; live sites skip when unreachable.
  skipOnLoadError: boolean;
  // Assert the ORIGINAL page has at least this many violations. Live sites
  // may fix themselves over time, so keep expectations local-only.
  minViolationsBefore: number;
}

const SITES: Site[] = [
  {
    name: 'Local fixture: bank.html',
    url: pathToFileURL(path.resolve(__dirname, '..', 'fixtures', 'bank.html'))
      .href,
    skipOnLoadError: false,
    minViolationsBefore: 3,
  },
  {
    name: 'Local fixture: form.html (interactive)',
    url: pathToFileURL(path.resolve(__dirname, '..', 'fixtures', 'form.html'))
      .href,
    skipOnLoadError: false,
    minViolationsBefore: 3,
  },
  {
    name: 'W3C CityLights home (inaccessible demo)',
    url: 'https://www.w3.org/WAI/demos/bad/before/home.html',
    skipOnLoadError: true,
    minViolationsBefore: 1,
  },
  {
    name: 'W3C CityLights survey (table-layout form)',
    url: 'https://www.w3.org/WAI/demos/bad/before/survey.html',
    skipOnLoadError: true,
    minViolationsBefore: 1,
  },
  {
    name: 'example.com',
    url: 'https://example.com',
    skipOnLoadError: true,
    minViolationsBefore: 0,
  },
  {
    name: 'Hacker News',
    url: 'https://news.ycombinator.com',
    skipOnLoadError: true,
    minViolationsBefore: 0,
  },
];

async function auditSite(browser: Browser, site: Site): Promise<SiteResult> {
  const page = await browser.newPage();
  try {
    await page.goto(site.url, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    await page.close();
    if (!site.skipOnLoadError) throw err;
    return { name: site.name, skipped: (err as Error).message };
  }

  const before = await runAxe(page);
  const extraction = await runExtractor(page);
  const html = renderAccessible(extraction);

  const rendered = await browser.newPage();
  await rendered.setContent(html, { waitUntil: 'load' });
  const after = await runAxe(rendered);

  await page.close();
  await rendered.close();
  return { name: site.name, before, after };
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  let failed = 0;

  for (const site of SITES) {
    const result = await auditSite(browser, site);
    console.log(`\n=== ${site.name} ===`);
    if (result.skipped) {
      console.log(`SKIP  could not load: ${result.skipped}`);
      continue;
    }

    const beforeCount = result.before!.length;
    const afterCount = result.after!.length;
    console.log(`original page violations: ${beforeCount}`);
    console.log(formatViolations(result.before!));
    console.log(`regenerated page violations: ${afterCount}`);
    console.log(formatViolations(result.after!));

    if (beforeCount < site.minViolationsBefore) {
      failed++;
      console.log(
        `FAIL  expected the original to have >= ${site.minViolationsBefore} violations (got ${beforeCount})`
      );
    } else if (afterCount > 0) {
      failed++;
      console.log('FAIL  regenerated page must have 0 axe violations');
    } else {
      console.log(
        `PASS  ${beforeCount} violations -> 0 in the regenerated view`
      );
    }
  }

  await browser.close();
  console.log(failed === 0 ? '\nAll a11y audits passed' : `\n${failed} audit(s) failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
