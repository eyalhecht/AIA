// Node-side helper: bundles the extractor and runs it inside a Playwright
// page. Shared by the test suite and the extract-url CLI.

import { buildSync } from 'esbuild';
import * as path from 'path';
import { Page } from 'playwright';
import type { ExtractionResult } from './extractor';

let bundleCache: string | null = null;

export function extractorBundle(): string {
  if (!bundleCache) {
    const result = buildSync({
      entryPoints: [path.resolve(__dirname, 'inject.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'AIAExtractor',
      write: false,
    });
    // The bundle runs via evaluate (function scope, not top level), so the
    // IIFE's `var AIAExtractor` stays local — export it explicitly.
    bundleCache =
      result.outputFiles[0].text +
      ';globalThis.AIAExtractor = AIAExtractor;';
  }
  return bundleCache;
}

export async function runExtractor(page: Page): Promise<ExtractionResult> {
  // Evaluate the bundle source instead of addScriptTag: evaluate runs via
  // the DevTools protocol and is not subject to the page's CSP (which on
  // sites like github.com blocks injected script tags). Extension content
  // scripts get the same exemption, so this mirrors production behavior.
  await page.evaluate(extractorBundle());
  return page.evaluate(() => (window as any).AIAExtractor.extractPage());
}
