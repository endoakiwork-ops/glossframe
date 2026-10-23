import { describe, it, expect } from 'vitest';
import { preserveSourceSegments } from '../src/shared/translation-segments';

describe('source preserving translation segments', () => {
  it('restores punctuation and spaces omitted by AI without changing text', () => {
    const source = 'We are about to leave.\nPlease take your time.';
    const segments = preserveSourceSegments(source, 'もうすぐ出発します。ゆっくりどうぞ。', [
      { source: 'We are about to leave', translation: 'もうすぐ出発します。' },
      { source: 'Please take your time', translation: 'ゆっくりどうぞ。' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments.map(segment => segment.source).join('')).toBe(source);
  });
  it('falls back to one faithful pair when AI drops words or rearranges source', () => {
    for (const segments of [
      [{ source: 'We leave.', translation: '出発します' }],
      [{ source: 'leave', translation: '出発する' }, { source: 'We', translation: '私たち' }],
      [{ source: 'We', translation: '私たち' }],
    ]) expect(preserveSourceSegments('We will leave.', '私たちは出発します。', segments)).toEqual([{ source: 'We will leave.', translation: '私たちは出発します。' }]);
  });
  it('keeps repeated phrases, arrows, numbers, and exact case', () => {
    const source = 'Go → 2 MILES. Go → 2 MILES!';
    const segments = preserveSourceSegments(source, '進んでください', [
      { source: 'Go → 2 MILES', translation: '2マイル進む →' },
      { source: 'Go → 2 MILES', translation: '2マイル進む →' },
    ]);
    expect(segments.map(segment => segment.source).join('')).toBe(source);
    expect(segments).toHaveLength(2);
  });
});
