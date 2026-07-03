// Enhancement guardrail tests. No network: the LLM is faked, we verify that
// applyPlan/enhanceExtraction enforce the safety contract and that an
// enhanced page still renders axe-clean.
//
// Run with: npm run test:enhance

import { chromium } from 'playwright';
import type { ExtractionResult } from './extractor';
import { enhanceExtraction, applyPlan } from './enhance';
import { renderAccessible } from './renderer';
import { runAxe, formatViolations } from './axe';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const base: ExtractionResult = {
  page: { url: 'https://demo.test/page', title: 'Demo' },
  elements: [
    { id: 'e1', kind: 'heading', level: 1, text: 'Demo page' },
    { id: 'e2', kind: 'text', text: 'Main content here.' },
    { id: 'e3', kind: 'link', text: 'Click here', href: '/offers' },
    {
      id: 'e4',
      kind: 'input',
      inputType: 'text',
      label: null,
      value: '',
      required: false,
    },
    {
      id: 'e5',
      kind: 'input',
      inputType: 'text',
      label: 'Amount',
      value: '',
      required: true,
    },
    { id: 'e6', kind: 'button', text: 'Send', disabled: false },
    { id: 'e7', kind: 'text', text: 'Copyright 2026, all rights reserved.' },
  ] as any,
};

async function main(): Promise<void> {
  const checks: Check[] = [];

  // 1. A well-formed plan is applied within the guardrails.
  const good = applyPlan(base, {
    sections: [{ heading: 'Offers', ids: ['e2', 'e3'] }],
    renames: { e3: 'Current offers' },
    labels: { e4: 'Your name', e5: 'HACKED' },
    drop: ['e7', 'e6', 'e4'],
  });
  const byId = (r: ExtractionResult, id: string): any =>
    r.elements.find((e) => e.id === id);

  checks.push({
    name: 'meaningless link renamed',
    ok: byId(good, 'e3')?.text === 'Current offers',
  });
  checks.push({
    name: 'null label filled by plan',
    ok: byId(good, 'e4')?.label === 'Your name',
  });
  checks.push({
    name: 'existing label NOT overridden',
    ok: byId(good, 'e5')?.label === 'Amount',
  });
  checks.push({
    name: 'boilerplate text dropped',
    ok: byId(good, 'e7') === undefined,
  });
  checks.push({
    name: 'button cannot be dropped',
    ok: byId(good, 'e6') !== undefined,
  });
  checks.push({
    name: 'form control cannot be dropped',
    ok: byId(good, 'e4') !== undefined,
  });
  checks.push({
    name: 'section heading synthesized before its elements',
    ok: (() => {
      const idx = good.elements.findIndex(
        (e: any) => e.kind === 'heading' && e.text === 'Offers'
      );
      return (
        idx >= 0 &&
        (good.elements[idx + 1] as any)?.id === 'e2' &&
        (good.elements[idx + 2] as any)?.id === 'e3'
      );
    })(),
  });
  checks.push({
    name: 'unmentioned elements kept in original order',
    ok:
      good.elements.filter((e: any) => !e.id.startsWith('sec')).length ===
      base.elements.length - 1, // only e7 dropped
  });

  // 2. Hostile/broken plans are neutralized.
  const hostile = applyPlan(base, {
    sections: [{ heading: 'X', ids: ['e999', 'e2', 'e2'] }],
    renames: { e999: 'ghost', e2: 'not-a-link-so-ignored' },
    labels: { e999: 'ghost' },
    drop: ['e999'],
  } as any);
  checks.push({
    name: 'unknown/duplicate ids ignored without crashing',
    ok:
      hostile.elements.filter((e: any) => e.id === 'e2').length === 1 &&
      byId(hostile, 'e2')?.text === 'Main content here.',
  });

  const malformed = await enhanceExtraction(base, async () => 'NOT JSON AT ALL');
  checks.push({
    name: 'malformed LLM output falls back to original extraction',
    ok:
      malformed.plan === null &&
      malformed.result.elements.length === base.elements.length,
  });

  const failing = await enhanceExtraction(base, async () => {
    throw new Error('network down');
  });
  checks.push({
    name: 'LLM failure falls back to original extraction',
    ok: failing.plan === null,
  });

  // 3. An enhanced extraction still renders axe-clean.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(renderAccessible(good), { waitUntil: 'load' });
  const violations = await runAxe(page);
  checks.push({
    name: 'enhanced render has 0 axe violations',
    ok: violations.length === 0,
    detail: violations.length ? '\n' + formatViolations(violations) : undefined,
  });
  await browser.close();

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail || ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
