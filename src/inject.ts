// Bundle entry point. esbuild bundles this (with dom-accessibility-api) into
// an IIFE exposing window.AIAExtractor, injectable into any page — via
// page.evaluate (see harness.ts), or a content script in an extension.

export { extractPage } from './extractor';
export type { ExtractionResult, ExtractedElement } from './extractor';
