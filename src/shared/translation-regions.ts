import type { Segment } from './types';

/**
 * A translated OCR region whose geometry is normalized against the image
 * (`0..1`, origin at the top-left). The source text is the corrected text used for translation; originalSource
 * preserves the OCR output for comparison.
 */
export interface TranslationRegion {
  id: string;
  phase?: "ocr" | "draft" | "final";
  source: string;
  /** OCR output before AI correction; source is the text used for learning. */
  originalSource?: string;
  needsReview?: boolean;
  translation: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TranslationRegionInput {
  id: string;
  text: string;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

interface Span {
  start: number;
  end: number;
}

interface SegmentSpan extends Span {
  contentStart: number;
  contentEnd: number;
  translation: string;
}

interface PlacedRegion {
  id: string;
  text: string;
  content: Span;
  x: number;
  y: number;
  width: number;
  height: number;
}

const WHITESPACE = /\s/u;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hasNonWhitespace(source: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!WHITESPACE.test(source[index])) return true;
  }
  return false;
}

/**
 * Shrink a span to the characters that actually carry meaning. OCR output and
 * AI segment sources commonly absorb separators at their edges; those may sit
 * just outside an OCR box without making the translation ambiguous.
 */
function contentBounds(source: string, span: Span): Span {
  let start = span.start;
  let end = span.end;
  while (start < end && WHITESPACE.test(source[start])) start += 1;
  while (end > start && WHITESPACE.test(source[end - 1])) end -= 1;
  return { start, end };
}

/**
 * Find `text` at or after `cursor`. Sequential lookup is intentional: it both
 * proves source order and prevents the same occurrence from matching twice.
 */
function findInOrder(source: string, text: string, cursor: number): Span | null {
  if (typeof text !== 'string' || !text || !/\S/u.test(text)) return null;
  const start = source.indexOf(text, cursor);
  if (start < 0) return null;
  return { start, end: start + text.length };
}

function normalizeBounds(
  bbox: TranslationRegionInput['bbox'] | null | undefined,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!bbox) return null;
  const { x0, y0, x1, y1 } = bbox;
  if (
    !isFiniteNumber(x0) ||
    !isFiniteNumber(y0) ||
    !isFiniteNumber(x1) ||
    !isFiniteNumber(y1)
  ) {
    return null;
  }
  if (x0 < 0 || y0 < 0 || x1 > imageWidth || y1 > imageHeight) return null;
  if (x1 <= x0 || y1 <= y0) return null;

  const x = clamp01(x0 / imageWidth);
  const y = clamp01(y0 / imageHeight);
  const width = Math.min(clamp01((x1 - x0) / imageWidth), 1 - x);
  const height = Math.min(clamp01((y1 - y0) / imageHeight), 1 - y);
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Map full-text translation segments onto OCR regions without inventing an
 * association. A region is returned only when:
 *
 * - its OCR text occurs verbatim in `source`, in order;
 * - its bbox is finite, non-empty and inside the image;
 * - every non-whitespace character in the region is covered by segments;
 * - every covering segment is fully contained in that same region.
 *
 * Segments that straddle region boundaries, edited text, missing coverage and
 * malformed geometry are rejected instead of producing a misleading overlay.
 */
export function buildTranslationRegions(
  source: string,
  segments: Segment[],
  regions: TranslationRegionInput[],
  imageWidth: number,
  imageHeight: number,
): TranslationRegion[] {
  if (typeof source !== 'string' || !source) return [];
  if (!isFiniteNumber(imageWidth) || !isFiniteNumber(imageHeight)) return [];
  if (imageWidth <= 0 || imageHeight <= 0) return [];

  const segmentSpans: SegmentSpan[] = [];
  let segmentCursor = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || typeof segment.source !== 'string') continue;
    const span = findInOrder(source, segment.source, segmentCursor);
    if (!span) continue;
    segmentCursor = span.end;
    if (typeof segment.translation !== 'string' || !/\S/u.test(segment.translation)) {
      continue;
    }
    const content = contentBounds(source, span);
    if (content.start >= content.end) continue;
    segmentSpans.push({
      ...span,
      contentStart: content.start,
      contentEnd: content.end,
      translation: segment.translation.trim(),
    });
  }

  const placed: PlacedRegion[] = [];
  let regionCursor = 0;
  for (const region of Array.isArray(regions) ? regions : []) {
    if (!region || typeof region.id !== 'string' || typeof region.text !== 'string') {
      continue;
    }
    const bounds = normalizeBounds(region.bbox, imageWidth, imageHeight);
    if (!bounds) continue;
    const span = findInOrder(source, region.text, regionCursor);
    if (!span) continue;
    regionCursor = span.end;
    const content = contentBounds(source, span);
    if (content.start >= content.end) continue;
    placed.push({ id: region.id, text: region.text, content, ...bounds });
  }

  const result: TranslationRegion[] = [];
  for (const region of placed) {
    let cursor = region.content.start;
    let complete = true;
    const translations: string[] = [];

    for (const segment of segmentSpans) {
      const intersects =
        segment.contentStart < region.content.end &&
        segment.contentEnd > region.content.start;
      if (!intersects) continue;

      // A segment may only be used when all of its meaningful characters live
      // inside this region. Otherwise it belongs to several boxes (or to none).
      if (
        segment.contentStart < region.content.start ||
        segment.contentEnd > region.content.end
      ) {
        complete = false;
        break;
      }

      if (segment.contentStart > cursor) {
        if (hasNonWhitespace(source, cursor, segment.contentStart)) {
          complete = false;
          break;
        }
      } else if (segment.contentStart < cursor) {
        // Overlapping segment content is ambiguous even if both spans matched.
        complete = false;
        break;
      }

      translations.push(segment.translation);
      cursor = segment.contentEnd;
    }

    if (!complete) continue;
    if (hasNonWhitespace(source, cursor, region.content.end)) continue;
    if (!translations.length) continue;

    result.push({
      id: region.id,
      source: region.text,
      translation: translations.join('\n'),
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });
  }

  return result;
}

/** Replace in place; a late preview must never replace a refined translation. */
export function mergeTranslationRegions(current: TranslationRegion[], updates: TranslationRegion[]): TranslationRegion[] {
  const rank = {ocr: 0, draft: 1, final: 2};
  const byId = new Map(updates.map(region => [region.id, region]));
  return current.map(region => {
    const update = byId.get(region.id);
    return update && rank[update.phase ?? 'final'] >= rank[region.phase ?? 'final'] ? update : region;
  });
}
