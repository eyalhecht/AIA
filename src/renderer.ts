// Deterministic renderer: ExtractionResult -> self-contained accessible HTML.
//
// Every choice here exists to keep axe-core at zero violations:
// - one <main> landmark, all content inside landmarks
// - heading levels normalized so they never skip (h1 -> h2 -> h3...)
// - every control gets a real <label for>; radio groups get <fieldset>
// - links/buttons always have an accessible name (derived when missing)
// - high-contrast palette, visible focus, generous target sizes
//
// data-source-id carries the original element's data-poc-id for write-back.

import type { ExtractionResult, ExtractedElement } from './extractor';

export interface RenderOptions {
  // Rewrite link destinations (e.g. the viewer routes them through itself).
  rewriteHref?: (absoluteUrl: string) => string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveUrl(href: string, base: string): string | null {
  if (/^\s*javascript:/i.test(href)) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Human-readable link name from its URL when the page provides none.
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'mailto:') return u.pathname;
    const seg = u.pathname.split('/').filter(Boolean).pop();
    const base = seg ? decodeURIComponent(seg).replace(/[-_]/g, ' ') : u.hostname;
    return base + (u.search ? ' (with parameters)' : '');
  } catch {
    return 'link';
  }
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  font-size: 1.125rem; line-height: 1.6;
  color: #1a1a1a; background: #ffffff;
  max-width: 46rem; margin: 0 auto; padding: 1rem;
}
header.aia-banner {
  border-bottom: 2px solid #1a1a1a; padding-bottom: 0.75rem; margin-bottom: 1.5rem;
  font-size: 0.9375rem;
}
a { color: #0b47a1; text-decoration: underline; }
a:visited { color: #5e1c8f; }
:focus-visible { outline: 3px solid #0b47a1; outline-offset: 2px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; }
[role="alert"] {
  border: 2px solid #9d1c1c; border-left-width: 8px; color: #9d1c1c;
  padding: 0.75rem 1rem; margin: 1rem 0; font-weight: 600;
}
.field { margin: 1.25rem 0; }
.field label, fieldset legend { display: block; font-weight: 600; margin-bottom: 0.375rem; }
input[type="text"], input[type="email"], input[type="password"], input[type="search"],
input[type="tel"], input[type="url"], input[type="number"], textarea, select {
  font: inherit; width: 100%; max-width: 26rem;
  padding: 0.625rem; border: 2px solid #1a1a1a; border-radius: 4px;
  background: #fff; color: #1a1a1a;
}
fieldset { border: 2px solid #767676; border-radius: 4px; padding: 0.75rem 1rem; margin: 1.25rem 0; }
.choice { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
.choice label { font-weight: 400; margin: 0; }
input[type="checkbox"], input[type="radio"] { width: 1.375rem; height: 1.375rem; }
button {
  font: inherit; font-weight: 600; cursor: pointer;
  padding: 0.625rem 1.5rem; margin: 0.5rem 0.5rem 0.5rem 0;
  border: 2px solid #0b47a1; border-radius: 4px;
  background: #0b47a1; color: #ffffff; min-height: 2.75rem;
}
button[disabled] { background: #f2f2f2; color: #595959; border-color: #767676; cursor: not-allowed; }
img { max-width: 100%; height: auto; }
.aia-derived { font-style: italic; }
`;

export function renderAccessible(
  extraction: ExtractionResult,
  options: RenderOptions = {}
): string {
  const { page, elements } = extraction;
  const body: string[] = [];

  // Heading normalization state: rendered page starts at h1 (the title), so
  // content headings live in h2..h6 and may never jump more than one level.
  let lastLevel = 1;

  const linkHref = (href: string): string | null => {
    const abs = resolveUrl(href, page.url);
    if (!abs) return null;
    return options.rewriteHref ? options.rewriteHref(abs) : abs;
  };

  // Radio groups render as one fieldset; consume the whole run at once.
  let i = 0;

  const renderControlLabel = (
    el: { id: string; label: string | null },
    fallback: string
  ): { labelHtml: string; inputId: string } => {
    const inputId = 'f-' + el.id;
    const text = el.label
      ? esc(el.label)
      : `<span class="aia-derived">${esc(fallback)}</span>`;
    return { labelHtml: `<label for="${inputId}">${text}</label>`, inputId };
  };

  while (i < elements.length) {
    const el: any = elements[i];

    switch (el.kind as ExtractedElement['kind']) {
      case 'heading': {
        // Never skip levels: clamp into [2, lastLevel + 1].
        const level = Math.max(2, Math.min(el.level + 1, lastLevel + 1, 6));
        lastLevel = level;
        body.push(`<h${level}>${esc(el.text)}</h${level}>`);
        break;
      }

      case 'text': {
        if (el.alert) {
          body.push(`<p role="alert">${esc(el.text)}</p>`);
        } else {
          body.push(`<p>${esc(el.text)}</p>`);
        }
        break;
      }

      case 'link': {
        const href = linkHref(el.href);
        if (!href) {
          // javascript: or unparseable — present the text, lose the dead href.
          if (el.text) body.push(`<p>${esc(el.text)}</p>`);
          break;
        }
        const name = el.text
          ? esc(el.text)
          : `<span class="aia-derived">${esc(nameFromUrl(href))}</span>`;
        body.push(
          `<p><a href="${esc(href)}" data-source-id="${el.id}">${name}</a></p>`
        );
        break;
      }

      case 'button': {
        const name = el.text
          ? esc(el.text)
          : `<span class="aia-derived">Unnamed button</span>`;
        body.push(
          `<button type="button" data-source-id="${el.id}"${
            el.disabled ? ' disabled' : ''
          }>${name}</button>`
        );
        break;
      }

      case 'input': {
        const { labelHtml, inputId } = renderControlLabel(el, 'Unlabeled field');
        const type = el.inputType === 'textarea' ? 'text' : el.inputType;
        const field =
          el.inputType === 'textarea'
            ? `<textarea id="${inputId}" data-source-id="${el.id}"${
                el.required ? ' required' : ''
              }>${esc(el.value)}</textarea>`
            : `<input id="${inputId}" type="${esc(type)}" value="${esc(
                el.value
              )}" data-source-id="${el.id}"${el.required ? ' required' : ''}>`;
        body.push(`<div class="field">${labelHtml}${field}</div>`);
        break;
      }

      case 'select': {
        const { labelHtml, inputId } = renderControlLabel(el, 'Unlabeled choice');
        const opts = el.options
          .map(
            (o: string) =>
              `<option${o === el.value ? ' selected' : ''}>${esc(o)}</option>`
          )
          .join('');
        body.push(
          `<div class="field">${labelHtml}<select id="${inputId}" data-source-id="${el.id}">${opts}</select></div>`
        );
        break;
      }

      case 'checkbox': {
        const inputId = 'f-' + el.id;
        const text = el.label
          ? esc(el.label)
          : `<span class="aia-derived">Unlabeled checkbox</span>`;
        body.push(
          `<div class="choice"><input type="checkbox" id="${inputId}" data-source-id="${el.id}"${
            el.checked ? ' checked' : ''
          }><label for="${inputId}">${text}</label></div>`
        );
        break;
      }

      case 'radio': {
        // Consume the whole run of radios sharing this group name.
        const group = el.group;
        const run: any[] = [];
        let j = i;
        while (
          j < elements.length &&
          (elements[j] as any).kind === 'radio' &&
          (elements[j] as any).group === group
        ) {
          run.push(elements[j]);
          j++;
        }
        const items = run
          .map((r: any) => {
            const inputId = 'f-' + r.id;
            const text = r.label
              ? esc(r.label)
              : `<span class="aia-derived">Unlabeled option</span>`;
            return `<div class="choice"><input type="radio" id="${inputId}" name="g-${esc(
              group || 'group'
            )}" data-source-id="${r.id}"${
              r.checked ? ' checked' : ''
            }><label for="${inputId}">${text}</label></div>`;
          })
          .join('');
        body.push(
          `<fieldset><legend>${esc(
            group ? `Choose: ${group}` : 'Choose one'
          )}</legend>${items}</fieldset>`
        );
        i = j;
        continue;
      }

      case 'image': {
        if (!el.src) break;
        // alt text known: meaningful image. alt missing on the source page:
        // still worth showing, but flag the gap textually for context.
        if (el.alt) {
          body.push(
            `<figure><img src="${esc(el.src)}" alt="${esc(
              el.alt
            )}" data-source-id="${el.id}"></figure>`
          );
        } else {
          body.push(
            `<figure><img src="${esc(el.src)}" alt="" data-source-id="${
              el.id
            }"><figcaption class="aia-derived">Image without description on the original page</figcaption></figure>`
          );
        }
        break;
      }
    }
    i++;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessible view: ${esc(page.title || page.url)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="aia-banner">
<p>Accessible view of <a href="${esc(page.url)}">${esc(
    page.url
  )}</a>, regenerated by AIA.</p>
</header>
<main>
<h1>${esc(page.title || 'Untitled page')}</h1>
${body.join('\n')}
</main>
</body>
</html>`;
}
