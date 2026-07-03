// Run the extractor against any live URL and print the JSON.
//
// Usage: npm run extract -- <url> [--summary]

import { chromium } from 'playwright';
import type { ExtractionResult } from './extractor';
import { runExtractor } from './harness';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const summary = args.includes('--summary');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: npm run extract -- <url> [--summary]');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  const result: ExtractionResult = await runExtractor(page);
  await browser.close();

  if (summary) {
    const counts: Record<string, number> = {};
    for (const el of result.elements) {
      counts[el.kind] = (counts[el.kind] || 0) + 1;
    }
    console.log(`URL:      ${result.page.url}`);
    console.log(`Title:    ${result.page.title}`);
    console.log(`Elements: ${result.elements.length}`);
    console.log(`By kind:  ${JSON.stringify(counts)}`);
    console.log(
      `JSON size: ${(JSON.stringify(result).length / 1024).toFixed(1)} KB`
    );
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
