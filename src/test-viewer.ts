// Viewer server tests: serves the home page, regenerates a page from a URL,
// rewrites links to stay in accessible mode, and both served pages are
// axe-clean.
//
// Run with: npm run test:viewer

import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import * as path from 'path';
import { startViewer } from './viewer';
import { runAxe, formatViolations } from './axe';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

async function main(): Promise<void> {
  const port = 4917;
  const viewer = await startViewer(port);
  const base = `http://localhost:${port}`;
  const fixtureUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'fixtures', 'bank.html')
  ).href;

  const checks: Check[] = [];

  const home = await fetchText(base + '/');
  checks.push({ name: 'home page serves 200', ok: home.status === 200 });
  checks.push({
    name: 'home page has the URL form',
    ok: home.text.includes('action="/view"'),
  });

  const view = await fetchText(
    `${base}/view?url=${encodeURIComponent(fixtureUrl)}`
  );
  checks.push({ name: 'view serves 200', ok: view.status === 200 });
  checks.push({
    name: 'regenerated fixture contains the recovered Amount label',
    ok: view.text.includes('Amount'),
  });
  checks.push({
    name: 'links are rewritten through the viewer',
    ok: view.text.includes('href="/view?url='),
  });

  const bad = await fetchText(`${base}/view?url=notaurl`);
  checks.push({
    name: 'invalid url yields accessible 400 error page',
    ok: bad.status === 400 && bad.text.includes('role="alert"'),
  });

  // Both served pages must be axe-clean.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  const homeViolations = await runAxe(page);
  checks.push({
    name: 'home page has 0 axe violations',
    ok: homeViolations.length === 0,
    detail: homeViolations.length ? '\n' + formatViolations(homeViolations) : undefined,
  });
  await page.goto(`${base}/view?url=${encodeURIComponent(fixtureUrl)}`, {
    waitUntil: 'load',
  });
  const viewViolations = await runAxe(page);
  checks.push({
    name: 'regenerated page served by viewer has 0 axe violations',
    ok: viewViolations.length === 0,
    detail: viewViolations.length ? '\n' + formatViolations(viewViolations) : undefined,
  });
  await browser.close();
  await viewer.close();

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
