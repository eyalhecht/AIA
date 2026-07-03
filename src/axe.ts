// Runs axe-core (the engine behind Chrome DevTools' accessibility audit)
// inside a Playwright page and returns the violations.

import * as fs from 'fs';
import * as path from 'path';
import { Page } from 'playwright';

export interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  nodes: number;
}

let axeSource: string | null = null;

function getAxeSource(): string {
  if (!axeSource) {
    axeSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'),
      'utf8'
    );
  }
  return axeSource;
}

export async function runAxe(page: Page): Promise<AxeViolation[]> {
  // evaluate (not addScriptTag) so page CSP cannot block the audit.
  await page.evaluate(getAxeSource());
  const violations = await page.evaluate(async () => {
    const results = await (window as any).axe.run(document, {
      resultTypes: ['violations'],
    });
    return results.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
    }));
  });
  return violations;
}

export function formatViolations(violations: AxeViolation[]): string {
  if (violations.length === 0) return '  (none)';
  return violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.description} (${v.nodes} nodes)`)
    .join('\n');
}
