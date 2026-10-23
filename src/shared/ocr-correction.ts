import type {Segment} from './types';

/** A conservative review signal, not an automatic grammatical rewrite. */
export function ocrCorrectionNeedsReview(source: string, segments: Segment[], modelNeedsReview = false): boolean {
  if (modelNeedsReview) return true;
  // A model can mark an incomplete correction as confident. When it has split
  // an IF clause, a finite verb starting the main clause suggests a lost subject.
  return /^if\b/i.test(source.trim()) && segments.slice(1).some(segment =>
    /^(?:gets|becomes|has|is|was|does|eats|drinks)\b/i.test(segment.source.trim()),
  );
}
