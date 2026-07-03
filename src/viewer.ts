// Local accessible-browsing server.
//
//   npm run viewer            (default port 4173)
//   npm run viewer -- 5000    (custom port)
//
// Open http://localhost:4173, enter any URL: the server loads the page in a
// headless browser, extracts its semantics, and serves the regenerated
// accessible version. Links inside the regenerated page route back through
// the viewer, so following them keeps you in accessible mode — a read-only
// accessible lens over the web.

import * as http from 'http';
import { chromium, Browser } from 'playwright';
import { runExtractor } from './harness';
import { renderAccessible } from './renderer';
import { enhanceExtraction, loadOpenAiKey } from './enhance';

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
<p>Enter a web address. AIA regenerates the page as an accessible version and keeps you in accessible mode as you follow links.</p>
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

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIA viewer error</title></head>
<body>
<main>
<h1>Could not open that page</h1>
<p role="alert">${message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</p>
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

export interface Viewer {
  port: number;
  close: () => Promise<void>;
}

export async function startViewer(port: number): Promise<Viewer> {
  const browser: Browser = await chromium.launch();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

    if (reqUrl.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HOME_HTML);
      return;
    }

    if (reqUrl.pathname === '/view') {
      const target = reqUrl.searchParams.get('url') || '';
      if (!allowedUrl(target)) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage(`Not a valid web address: ${target}`));
        return;
      }
      const enhance =
        reqUrl.searchParams.get('enhance') === '1' && loadOpenAiKey() !== null;
      const page = await browser.newPage();
      try {
        await page.goto(target, { waitUntil: 'load', timeout: 30000 });
        let extraction = await runExtractor(page);
        if (enhance) {
          // Fail-safe inside: falls back to the plain extraction.
          extraction = (await enhanceExtraction(extraction)).result;
        }
        const suffix = enhance ? '&enhance=1' : '';
        const html = renderAccessible(extraction, {
          rewriteHref: (abs) =>
            allowedUrl(abs)
              ? `/view?url=${encodeURIComponent(abs)}${suffix}`
              : abs,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage((err as Error).message));
      } finally {
        await page.close();
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(errorPage('Page not found.'));
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    port,
    close: async () => {
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
