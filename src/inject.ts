// Bundle entry point. esbuild bundles this (with dom-accessibility-api) into
// an IIFE exposing window.AIAExtractor, injectable into any page — via
// addScriptTag in tests, via a content script in the extension.

export { extractPage } from './extractor';
export type { ExtractionResult, ExtractedElement } from './extractor';
