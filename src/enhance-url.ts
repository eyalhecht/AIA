// Smoke test for the real LLM enhancement (costs a small API call).
//
// Usage: npm run enhance -- <url>
// Writes out/enhanced.html and prints the plan the LLM produced.

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { runExtractor } from './harness';
import { renderAccessible } from './renderer';
import { enhanceExtraction } from './enhance';
import { runAxe, formatViolations } from './axe';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run enhance -- <url>');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const extraction = await runExtractor(page);
  await page.close();

  console.log(`extracted ${extraction.elements.length} elements, enhancing...`);
  const { result, plan } = await enhanceExtraction(extraction);

  if (!plan) {
    console.log('enhancement failed or unavailable — deterministic result only');
  } else {
    console.log('plan:', JSON.stringify(plan, null, 2));
  }

  const html = renderAccessible(result);
  const outDir = path.resolve(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'enhanced.html');
  fs.writeFileSync(outFile, html);

  const check = await browser.newPage();
  await check.setContent(html, { waitUntil: 'load' });
  const violations = await runAxe(check);
  console.log(`axe violations on enhanced render: ${violations.length}`);
  console.log(formatViolations(violations));
  await browser.close();

  console.log(`\nwritten: ${outFile}`);
  if (violations.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
