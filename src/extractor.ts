// Page-semantics extractor.
//
// Runs inside the target page. Consumed as a bundle (src/inject.ts entry,
// built with esbuild) evaluated in the page by harness.ts — so imports are
// fine, but only browser APIs exist at runtime.
//
// Labeling strategy: first ask the W3C accessible-name algorithm
// (dom-accessibility-api — what a screen reader would announce). When that
// comes up empty — i.e. the page is built badly — fall back to our repair
// heuristics (nearby text, placeholder, descendant icon names).

import { computeAccessibleName } from 'dom-accessibility-api';

export interface PageInfo {
  url: string;
  title: string;
}

export type ExtractedElement =
  | { id: string; kind: 'heading'; level: number; text: string }
  | { id: string; kind: 'text'; text: string; alert?: boolean }
  | { id: string; kind: 'link'; text: string; href: string }
  | { id: string; kind: 'button'; text: string; disabled: boolean }
  | {
      id: string;
      kind: 'input';
      inputType: string;
      label: string | null;
      value: string;
      required: boolean;
    }
  | {
      id: string;
      kind: 'checkbox';
      label: string | null;
      checked: boolean;
    }
  | {
      id: string;
      kind: 'radio';
      label: string | null;
      group: string;
      checked: boolean;
    }
  | {
      id: string;
      kind: 'select';
      label: string | null;
      options: string[];
      value: string;
    }
  | { id: string; kind: 'image'; src: string; alt: string | null };

export interface ExtractionResult {
  page: PageInfo;
  elements: ExtractedElement[];
}

export function extractPage(): ExtractionResult {
  let counter = 0;
  const elements: any[] = [];
  // Text nodes sharing a parent element merge into one entry: the parent
  // carries a single data-poc-id, so it must map to a single entry.
  const textByParent = new Map<Element, { text: string }>();
  // Text nodes already used as a control's label — don't re-emit as text.
  const consumedTextNodes = new Set<Node>();

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'IFRAME',
    'HEAD',
    'META',
    'LINK',
  ]);

  function clean(s: string | null | undefined): string {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
      return anyEl.checkVisibility();
    }
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }

  function stampId(el: Element): string {
    const id = 'e' + ++counter;
    el.setAttribute('data-poc-id', id);
    return id;
  }

  // Spec-computed accessible name: exactly what a screen reader would
  // announce today. Empty on badly built pages.
  function specName(el: Element): string {
    try {
      return clean(computeAccessibleName(el));
    } catch {
      return '';
    }
  }

  // Label hunt for form controls. The spec name covers everything properly
  // wired (label[for], wrapping label, aria-*); the rest is our repair
  // layer for pages that offer none of that.
  function findLabel(el: Element): string | null {
    const spec = specName(el);
    if (spec) return spec;

    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;

    // Nearby-text heuristic: closest preceding sibling (or parent's preceding
    // sibling) that carries short text.
    let node: Node | null = el.previousSibling;
    let hops = 0;
    let scope: Element | null = el.parentElement;
    while (hops < 6) {
      if (!node) {
        if (!scope || scope === document.body) break;
        node = scope.previousSibling;
        scope = scope.parentElement;
        continue;
      }
      hops++;
      let text = '';
      if (node.nodeType === Node.TEXT_NODE) {
        text = clean(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const cand = node as Element;
        // A preceding form control means we crossed into another field's zone.
        if (cand.querySelector('input,select,textarea,button')) break;
        if (isVisible(cand)) text = clean(cand.textContent);
      }
      if (text && text.length <= 60) return text;
      if (text) break; // long text block: likely prose, not a label
      node = node.previousSibling;
    }

    const title = clean(el.getAttribute('title'));
    if (title) return title;

    return null;
  }

  // Last-resort name for links/buttons whose only content is an icon:
  // pull alt/title/aria-label from the element or its descendants.
  function iconName(el: Element): string {
    const own =
      clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title'));
    if (own) return own;
    const named = el.querySelector('[alt], [title], [aria-label]');
    if (named) {
      return (
        clean(named.getAttribute('aria-label')) ||
        clean(named.getAttribute('alt')) ||
        clean(named.getAttribute('title'))
      );
    }
    return '';
  }

  // Checkbox/radio labels conventionally sit AFTER the control; grab the
  // next sibling text node if the usual channels found nothing.
  function followingText(el: Element): string | null {
    let node: Node | null = el.nextSibling;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.textContent);
        if (text) {
          consumedTextNodes.add(node);
          return text;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        break;
      }
      node = node.nextSibling;
    }
    return null;
  }

  // Returns an entry if el is a semantic "leaf" we emit directly (its subtree
  // is consumed); returns null to keep descending into children.
  function classify(el: Element): any | null {
    const tag = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();

    if (/^H[1-6]$/.test(tag)) {
      const text = clean(el.textContent);
      if (!text) return null;
      return { kind: 'heading', level: Number(tag[1]), text };
    }

    if (role === 'alert') {
      const text = clean(el.textContent);
      if (!text) return null;
      return { kind: 'text', text, alert: true };
    }

    if (tag === 'A' && el.hasAttribute('href') && role !== 'button') {
      return {
        kind: 'link',
        text: clean(el.textContent) || specName(el) || iconName(el),
        href: el.getAttribute('href') || '',
      };
    }

    const isNativeButton =
      tag === 'BUTTON' ||
      (tag === 'INPUT' &&
        /^(button|submit|reset)$/.test((el as HTMLInputElement).type));
    // Catch div-soup "buttons": role=button, or a bare onclick handler.
    const isFakeButton =
      role === 'button' || (tag !== 'A' && el.hasAttribute('onclick'));
    if (isNativeButton || isFakeButton) {
      const text =
        tag === 'INPUT'
          ? clean((el as HTMLInputElement).value) || specName(el)
          : clean(el.textContent) || specName(el) || iconName(el);
      return {
        kind: 'button',
        text,
        disabled:
          (el as HTMLButtonElement).disabled === true ||
          el.getAttribute('aria-disabled') === 'true',
      };
    }

    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') return { skip: true };
      if (input.type === 'checkbox') {
        return {
          kind: 'checkbox',
          label: findLabel(el) ?? followingText(el),
          checked: input.checked,
        };
      }
      if (input.type === 'radio') {
        return {
          kind: 'radio',
          label: findLabel(el) ?? followingText(el),
          group: input.name || '',
          checked: input.checked,
        };
      }
      return {
        kind: 'input',
        inputType: input.type,
        label: findLabel(el),
        value: input.value,
        required: input.required || el.getAttribute('aria-required') === 'true',
      };
    }

    if (tag === 'TEXTAREA') {
      const ta = el as HTMLTextAreaElement;
      return {
        kind: 'input',
        inputType: 'textarea',
        label: findLabel(el),
        value: ta.value,
        required: ta.required,
      };
    }

    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      return {
        kind: 'select',
        label: findLabel(el),
        options: Array.from(sel.options).map((o) => clean(o.textContent)),
        value: clean(sel.selectedOptions[0]?.textContent),
      };
    }

    if (tag === 'IMG') {
      const rect = el.getBoundingClientRect();
      // Tiny images are decoration/tracking pixels — not content.
      if (rect.width < 16 || rect.height < 16) return { skip: true };
      const img = el as HTMLImageElement;
      return {
        kind: 'image',
        src: img.currentSrc || img.src || '',
        alt: el.hasAttribute('alt') ? clean(el.getAttribute('alt')) : null,
      };
    }

    return null;
  }

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      if (consumedTextNodes.has(node)) return;
      const text = clean(node.textContent);
      const parent = (node as Text).parentElement;
      if (!text || !parent || !isVisible(parent)) return;
      const existing = textByParent.get(parent);
      if (existing) {
        existing.text += ' ' + text;
        return;
      }
      // Punctuation-only crumbs (e.g. "[", ") ,") left between inline links
      // carry no meaning on their own — skip unless merged above.
      if (!/[\p{L}\p{N}]/u.test(text)) return;
      const entry = { id: stampId(parent), kind: 'text', text };
      elements.push(entry);
      textByParent.set(parent, entry);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!isVisible(el)) return;

    const entry = classify(el);
    if (entry) {
      if (!entry.skip) {
        entry.id = stampId(el);
        elements.push(entry);
      }
      return; // subtree consumed either way
    }

    for (const child of Array.from(el.childNodes)) visit(child);
  }

  visit(document.body);

  return {
    page: { url: location.href, title: document.title },
    elements: elements as ExtractedElement[],
  };
}
