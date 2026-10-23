import type { Segment } from './types';

/** Restore omitted separators without ever inventing or dropping source characters. */
export function preserveSourceSegments(source: string, translation: string, proposed: Segment[]): Segment[] {
  const fallback = () => [{ source, translation }];
  if (!proposed.length) return fallback();
  const starts: number[] = [];
  let cursor = 0;
  for (const segment of proposed) {
    const text = segment.source.trim();
    if (!text || !segment.translation.trim()) return fallback();
    const start = source.indexOf(text, cursor);
    if (start < 0 || !/^[\s\p{P}\p{S}]*$/u.test(source.slice(cursor, start))) return fallback();
    starts.push(start);
    cursor = start + text.length;
  }
  if (!/^[\s\p{P}\p{S}]*$/u.test(source.slice(cursor))) return fallback();
  return proposed.map((segment, index) => ({
    source: source.slice(index === 0 ? 0 : starts[index], starts[index + 1] ?? source.length),
    translation: segment.translation.trim(),
  }));
}
