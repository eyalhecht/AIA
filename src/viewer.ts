// Local accessible-browsing server.
//
//   npm run viewer            (default port 4173)
//   npm run viewer -- 5000    (custom port)
//
// Open http://localhost:4173, enter any URL: the server loads the page in a
// headless browser, extracts its semantics, and serves the regenerated
// accessible version. Links route back through the viewer so you stay in
// accessible mode, and form fields / buttons are replayed onto the live
// original page (write-back): filling the accessible form fills the real
// one, pressing an accessible button presses the real one.

import * as http from 'http';
import * as crypto from 'crypto';
import { chromium, Browser, Page } from 'playwright';
import { runExtractor } from './harness';
import { renderAccessible } from './renderer';
import { enhanceExtraction, loadOpenAiKey } from './enhance';

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 10;

interface Session {
  page: Page;
  lastAccess: number;
}

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIA accessible viewer</title>
<style>
body { font-family: system-ui, Arial, sans-serif; font-size: 1.125rem; line-height: 1.6;
  color: #1a1a1a; background: #fff; max-width: 46rem; margin: 0 auto; padding: 1rem; }
label { display: block; font-weight: 600; margin-bottom: 0.375rem; }
input[type="url"] { font: inherit; width: 100%; padding: 0.625rem;
  border: 2px solid #1a1a1a; border-radius: 4px; }
button { font: inherit; font-weight: 600; cursor: pointer; padding: 0.625rem 1.5rem;
  margin-top: 0.75rem; border: 2px solid #0b47a1; border-radius: 4px;
  background: #0b47a1; color: #fff; min-height: 2.75rem; }
:focus-visible { outline: 3px solid #0b47a1; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>AIA accessible viewer</h1>
<p>Enter a web address. AIA regenerates the page as an accessible version and keeps you in accessible mode as you follow links. Forms and buttons operate the real page underneath.</p>
<form action="/view" method="get">
<label for="url">Web address</label>
<input id="url" name="url" type="url" required placeholder="https://example.com" autofocus>
<div style="margin-top:0.75rem">
<input type="checkbox" id="enhance" name="enhance" value="1">
<label for="enhance" style="display:inline;font-weight:400">Improve organization with AI (sends page content to OpenAI)</label>
</div>
<button type="submit">Open accessible version</button>
</form>
</main>
</body>
</html>`;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorPage(message: string, status = 'Could not open that page'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIA viewer error</title></head>
<body>
<main>
<h1>${escHtml(status)}</h1>
<p role="alert">${escHtml(message)}</p>
<p><a href="/">Back to the viewer home page</a></p>
</main>
</body>
</html>`;
}

function allowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // file: is allowed for local fixtures/testing.
    return ['http:', 'https:', 'file:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Applies form values to the live original page, then optionally clicks.
// Runs in the page: data-poc-id attributes were stamped by the extractor.
async function applyWriteBack(
  page: Page,
  params: URLSearchParams
): Promise<void> {
  const sets: { id: string; value: string }[] = [];
  const radios: string[] = [];
  const checks: { id: string; checked: boolean }[] = [];

  const roster = (params.get('cbs') || '').split(',').filter(Boolean);
  for (const id of roster) {
    checks.push({ id, checked: params.get('c-' + id) === '1' });
  }
  for (const [key, value] of params) {
    if (key.startsWith('v-')) sets.push({ id: key.slice(2), value });
    else if (key.startsWith('r-')) radios.push(value);
  }

  await page.evaluate(
    ({ sets, radios, checks }) => {
      const byId = (id: string) =>
        document.querySelector(`[data-poc-id="${id}"]`) as HTMLElement | null;
      const fire = (el: HTMLElement) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      for (const { id, value } of sets) {
        const el = byId(id);
        if (!el) continue;
        if (el instanceof HTMLSelectElement) {
          const opt = Array.from(el.options).find(
            (o) => (o.textContent || '').replace(/\s+/g, ' ').trim() === value
          );
          if (opt) el.value = opt.value;
        } else if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          el.value = value;
        }
        fire(el);
      }
      for (const { id, checked } of checks) {
        const el = byId(id);
        if (el instanceof HTMLInputElement && el.checked !== checked) {
          el.checked = checked;
          fire(el);
        }
      }
      for (const id of radios) {
        const el = byId(id);
        if (el instanceof HTMLInputElement && !el.checked) {
          el.checked = true;
          fire(el);
        }
      }
    },
    { sets, radios, checks }
  );

  const clickId = params.get('click');
  if (clickId) {
    await page.click(`[data-poc-id="${clickId}"]`, { timeout: 5000 });
    // The click may navigate or just mutate the DOM — settle either way.
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

export interface Viewer {
  port: number;
  close: () => Promise<void>;
}

export async function startViewer(port: number): Promise<Viewer> {
  const browser: Browser = await chromium.launch();
  const sessions = new Map<string, Session>();

  const sweeper = setInterval(async () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastAccess > SESSION_TTL_MS) {
        sessions.delete(id);
        await s.page.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();

  async function evictIfNeeded(): Promise<void> {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess
      )[0];
      sessions.delete(oldest[0]);
      await oldest[1].page.close().catch(() => {});
    }
  }

  async function renderSession(
    sessionId: string,
    page: Page,
    enhance: boolean
  ): Promise<string> {
    let extraction = await runExtractor(page);
    if (enhance && loadOpenAiKey() !== null) {
      extraction = (await enhanceExtraction(extraction)).result;
    }
    const suffix = enhance ? '&enhance=1' : '';
    return renderAccessible(extraction, {
      rewriteHref: (abs) =>
        allowedUrl(abs) ? `/view?url=${encodeURIComponent(abs)}${suffix}` : abs,
      form: { action: '/act', sessionId },
    });
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
    const send = (status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };

    try {
      if (reqUrl.pathname === '/' && req.method === 'GET') {
        send(200, HOME_HTML);
        return;
      }

      if (reqUrl.pathname === '/view' && req.method === 'GET') {
        const target = reqUrl.searchParams.get('url') || '';
        if (!allowedUrl(target)) {
          send(400, errorPage(`Not a valid web address: ${target}`));
          return;
        }
        const enhance = reqUrl.searchParams.get('enhance') === '1';
        await evictIfNeeded();
        const page = await browser.newPage();
        // tsx/esbuild decorates evaluated functions with a __name helper
        // that doesn't exist in the page; stub it for the session's lifetime.
        await page.addInitScript(() => {
          (window as any).__name = (f: unknown) => f;
        });
        try {
          await page.goto(target, { waitUntil: 'load', timeout: 30000 });
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { page, lastAccess: Date.now() });
          send(200, await renderSession(sessionId, page, enhance));
        } catch (err) {
          await page.close().catch(() => {});
          send(502, errorPage((err as Error).message));
        }
        return;
      }

      if (reqUrl.pathname === '/act' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req));
        const session = sessions.get(params.get('session') || '');
        if (!session) {
          send(
            410,
            errorPage(
              'This page session has expired. Open the address again from the home page.',
              'Session expired'
            )
          );
          return;
        }
        session.lastAccess = Date.now();
        try {
          await applyWriteBack(session.page, params);
          send(
            200,
            await renderSession(
              params.get('session')!,
              session.page,
              false // deterministic re-render keeps actions fast and stable
            )
          );
        } catch (err) {
          send(502, errorPage((err as Error).message));
        }
        return;
      }

      send(404, errorPage('Page not found.'));
    } catch (err) {
      send(500, errorPage((err as Error).message));
    }
  });

  // Loopback only: the viewer opens file: URLs and anything the host can reach.
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    close: async () => {
      clearInterval(sweeper);
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
      await browser.close();
    },
  };
}

// CLI entry
if (require.main === module) {
  const port = Number(process.argv[2]) || 4173;
  startViewer(port).then(() => {
    console.log(`AIA accessible viewer running at http://localhost:${port}`);
  });
}
