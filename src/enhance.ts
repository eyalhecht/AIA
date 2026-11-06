// LLM enhancement stage (optional, fail-safe).
//
// The deterministic renderer guarantees accessibility; the LLM's only job is
// editorial judgment on top of the extraction:
//   - group elements into named sections
//   - give meaningless names better ones ("Click here" -> "Killer bees advice")
//   - infer labels for controls the heuristics could not label
//   - drop boilerplate noise (legal footers, repeated nav)
//
// Guardrails: the LLM returns a *plan* referencing existing element ids, and
// applyPlan enforces that it can only reorganize/rename/drop — never invent
// elements, never touch an existing label, never drop a form control. Any
// failure (bad JSON, network, missing key) falls back to the original
// extraction unchanged.

import * as fs from 'fs';
import * as path from 'path';
import type { ExtractionResult, ExtractedElement } from './extractor';

export interface EnhancementPlan {
  sections?: { heading: string; ids: string[] }[];
  renames?: Record<string, string>;
  labels?: Record<string, string>;
  drop?: string[];
}

export type LlmCall = (system: string, user: string) => Promise<string>;

export function loadOpenAiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs
      .readFileSync(envPath, 'utf8')
      .match(/^OPENAI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1].trim();
  }
  return null;
}

const SYSTEM_PROMPT = `You reorganize extracted web page content to improve readability for assistive-technology users. You receive a JSON list of page elements, each with an "id". Reply with ONLY a JSON object:
{
  "sections": [{"heading": "...", "ids": ["e1", "e2"]}],   // group related elements under descriptive headings, in sensible reading order, main content first
  "renames": {"e5": "better name"},                        // ONLY for links/buttons whose current text is empty or meaningless (e.g. "Click here", "Read More...")
  "labels": {"e7": "inferred label"},                      // ONLY for form controls whose label is null, when nearby elements make the purpose clear
  "drop": ["e90"]                                          // ONLY pure boilerplate: legal footers, copyright lines, redundant navigation
}
Rules: use only ids that exist. Never invent content that is not evident from the elements. Every id you do not mention stays in place. All keys are optional.`;

export function realOpenAiCall(model = 'gpt-4o-mini'): LlmCall {
  return async (system, user) => {
    const key = loadOpenAiKey();
    if (!key) throw new Error('OPENAI_API_KEY not configured');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  };
}

const PROTECTED_KINDS = new Set(['input', 'select', 'checkbox', 'radio', 'button']);

export function applyPlan(
  extraction: ExtractionResult,
  plan: EnhancementPlan
): ExtractionResult {
  const byId = new Map(extraction.elements.map((e) => [e.id, e]));

  const dropped = new Set<string>();
  for (const id of plan.drop || []) {
    const el: any = byId.get(id);
    // Form controls and buttons are actions the user may need — undroppable.
    if (el && !PROTECTED_KINDS.has(el.kind)) dropped.add(id);
  }

  const cloned = new Map<string, any>();
  for (const el of extraction.elements) {
    cloned.set(el.id, { ...el });
  }

  for (const [id, name] of Object.entries(plan.renames || {})) {
    const el = cloned.get(id);
    const text = typeof name === 'string' ? name.trim() : '';
    if (el && text && (el.kind === 'link' || el.kind === 'button')) {
      el.text = text;
    }
  }

  for (const [id, label] of Object.entries(plan.labels || {})) {
    const el = cloned.get(id);
    const text = typeof label === 'string' ? label.trim() : '';
    // Only fill gaps; a label the page (or spec algorithm) provided wins.
    if (el && text && 'label' in el && el.label == null) {
      el.label = text;
    }
  }

  // Rebuild element order: sections first (with synthetic headings), then
  // whatever the plan did not mention, in original order.
  const placed = new Set<string>();
  const out: ExtractedElement[] = [];
  let sectionN = 0;

  for (const section of plan.sections || []) {
    const ids: string[] = [];
    for (const id of section.ids || []) {
      if (cloned.has(id) && !placed.has(id) && !dropped.has(id)) {
        ids.push(id);
        placed.add(id); // immediately, so duplicates within a section are caught
      }
    }
    if (ids.length === 0) continue;
    sectionN++;
    const heading =
      typeof section.heading === 'string' && section.heading.trim()
        ? section.heading.trim()
        : `Section ${sectionN}`;
    out.push({
      id: `sec${sectionN}`,
      kind: 'heading',
      level: 2,
      text: heading,
    } as ExtractedElement);
    for (const id of ids) {
      out.push(cloned.get(id));
      placed.add(id);
    }
  }

  for (const el of extraction.elements) {
    if (!placed.has(el.id) && !dropped.has(el.id)) {
      out.push(cloned.get(el.id));
    }
  }

  return { page: extraction.page, elements: out };
}

// Compact one-line-per-element digest keeps the prompt small.
export function extractionDigest(extraction: ExtractionResult): string {
  return extraction.elements
    .map((e: any) => {
      const parts = [e.id, e.kind];
      if (e.kind === 'heading') parts.push(`h${e.level}`, JSON.stringify(e.text));
      else if (e.text !== undefined) parts.push(JSON.stringify(e.text));
      if ('label' in e) parts.push(`label=${JSON.stringify(e.label)}`);
      if (e.href) parts.push(`href=${e.href.slice(0, 80)}`);
      if (e.options) parts.push(`options=[${e.options.slice(0, 5).join('; ')}]`);
      if (e.alert) parts.push('ALERT');
      return parts.join(' | ');
    })
    .join('\n');
}

export async function enhanceExtraction(
  extraction: ExtractionResult,
  llm: LlmCall = realOpenAiCall()
): Promise<{ result: ExtractionResult; plan: EnhancementPlan | null }> {
  try {
    const user = `Page title: ${extraction.page.title}\nURL: ${extraction.page.url}\n\nElements:\n${extractionDigest(extraction)}`;
    const raw = await llm(SYSTEM_PROMPT, user);
    const plan: EnhancementPlan = JSON.parse(raw);
    return { result: applyPlan(extraction, plan), plan };
  } catch {
    // Fail-safe: enhancement is a bonus, never a blocker.
    return { result: extraction, plan: null };
  }
}
