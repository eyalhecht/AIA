// Renderer tests: pure string checks on renderAccessible output, no browser.
// The axe-level guarantees live in test-a11y; these pin the individual
// rules the renderer relies on, including input a hostile page could forge.
//
// Run with: npm run test:renderer

import type { ExtractionResult } from './extractor';
import { renderAccessible } from './renderer';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function render(
  elements: unknown[],
  page = { url: 'https://demo.test/page', title: 'Demo' }
): string {
  return renderAccessible({ page, elements } as ExtractionResult, {
    form: { action: '/act', sessionId: 's1' },
  });
}

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h(\d)>/g)].map((m) => Number(m[1]));
}

function main(): void {
  const checks: Check[] = [];

  const forged = render([
    { id: 'e1"><script>alert(1)</script>', kind: 'button', text: 'Go', disabled: false },
    { id: 'e2', kind: 'checkbox', label: 'Agree', checked: false },
  ]);
  checks.push({
    name: 'element ids are escaped in attributes',
    ok:
      !forged.includes('<script>') &&
      forged.includes('value="e1&quot;&gt;&lt;script&gt;'),
  });

  const links = render([
    { id: 'e1', kind: 'link', text: 'Run me', href: 'javascript:alert(1)' },
    { id: 'e2', kind: 'link', text: 'Data', href: 'data:text/html,<b>x</b>' },
    { id: 'e3', kind: 'link', text: 'Offers', href: '/offers' },
    { id: 'e4', kind: 'link', text: 'Mail', href: 'mailto:help@demo.test' },
  ]);
  checks.push({
    name: 'javascript: and data: links render as plain text',
    ok:
      links.includes('<p>Run me</p>') &&
      links.includes('<p>Data</p>') &&
      !links.includes('javascript:') &&
      !links.includes('data:text'),
  });
  checks.push({
    name: 'relative links resolve against the page URL',
    ok: links.includes('href="https://demo.test/offers"'),
  });
  checks.push({
    name: 'mailto: links are kept',
    ok: links.includes('href="mailto:help@demo.test"'),
  });

  const forgedPage = render([], { url: 'javascript:alert(1)', title: 'X' });
  checks.push({
    name: 'banner does not link to a non-web page URL',
    ok: !forgedPage.includes('href="javascript:'),
  });

  const headings = render([
    { id: 'e1', kind: 'heading', level: 1, text: 'Top' },
    { id: 'e2', kind: 'heading', level: 4, text: 'Deep' },
    { id: 'e3', kind: 'heading', level: 2, text: 'Back up' },
  ]);
  checks.push({
    name: 'heading levels never skip and start below the page h1',
    ok: headingLevels(headings).join(',') === '1,2,3,3',
    detail: ` (got ${headingLevels(headings).join(',')})`,
  });

  const radios = render([
    { id: 'e1', kind: 'radio', label: 'Card', group: 'pay', checked: true },
    { id: 'e2', kind: 'radio', label: null, group: 'pay', checked: false },
  ]);
  checks.push({
    name: 'a run of radios renders as one fieldset with a legend',
    ok:
      (radios.match(/<fieldset>/g) || []).length === 1 &&
      radios.includes('<legend>Choose: pay</legend>') &&
      radios.includes('Unlabeled option'),
  });

  const fields = render([
    { id: 'e1', kind: 'input', inputType: 'text', label: null, value: '', required: true },
  ]);
  checks.push({
    name: 'unlabeled control gets a visible derived label tied by for/id',
    ok:
      fields.includes('<label for="f-e1"><span class="aia-derived">Unlabeled field</span></label>') &&
      fields.includes('id="f-e1"') &&
      fields.includes(' required'),
  });

  checks.push({
    name: 'form mode carries the session and the checkbox roster',
    ok:
      forged.includes('name="session" value="s1"') &&
      forged.includes('name="cbs" value="e2"'),
  });

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : c.detail || ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main();
