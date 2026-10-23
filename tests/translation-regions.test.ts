import { describe, expect, it } from 'vitest';
import { buildTranslationRegions } from '../src/shared/translation-regions';

describe('buildTranslationRegions', () => {
  it('maps translation segments onto two OCR regions with normalized bounds', () => {
    const source = 'Hello, world!\n\nGood morning.';
    const regions = [
      { id: 'r1', text: 'Hello, world!', bbox: { x0: 10, y0: 20, x1: 110, y1: 60 } },
      { id: 'r2', text: 'Good morning.', bbox: { x0: 20, y0: 100, x1: 120, y1: 140 } },
    ];
    const segments = [
      { source: 'Hello, world!', translation: 'こんにちは、世界！' },
      { source: 'Good morning.', translation: 'おはよう。' },
    ];

    expect(buildTranslationRegions(source, segments, regions, 200, 200)).toEqual([
      {
        id: 'r1',
        source: 'Hello, world!',
        translation: 'こんにちは、世界！',
        x: 0.05,
        y: 0.1,
        width: 0.5,
        height: 0.2,
      },
      {
        id: 'r2',
        source: 'Good morning.',
        translation: 'おはよう。',
        x: 0.1,
        y: 0.5,
        width: 0.5,
        height: 0.2,
      },
    ]);
  });

  it('keeps case, symbols and separators while combining segments inside one region', () => {
    const source = 'Go → 2 MILES.\n\nHello, world!';
    const regions = [
      { id: 'r1', text: 'Go → 2 MILES.', bbox: { x0: 0, y0: 0, x1: 100, y1: 50 } },
      { id: 'r2', text: 'Hello, world!', bbox: { x0: 0, y0: 50, x1: 200, y1: 100 } },
    ];
    const segments = [
      // preserveSourceSegments may leave a separator at the end of a segment.
      { source: 'Go → 2 MILES.\n', translation: '2マイル進む →' },
      { source: 'Hello, world!', translation: 'こんにちは、世界！' },
    ];

    const result = buildTranslationRegions(source, segments, regions, 200, 100);
    expect(result).toHaveLength(2);
    expect(result.map((region) => region.source)).toEqual(['Go → 2 MILES.', 'Hello, world!']);
    expect(result.map((region) => region.translation)).toEqual([
      '2マイル進む →',
      'こんにちは、世界！',
    ]);
  });

  it('combines several segments that all fit inside one region', () => {
    const source = 'Hello world.';
    const regions = [
      { id: 'r1', text: source, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
    ];
    const segments = [
      { source: 'Hello ', translation: 'こんにちは、' },
      { source: 'world.', translation: '世界。' },
    ];

    expect(buildTranslationRegions(source, segments, regions, 100, 40)[0].translation).toBe(
      'こんにちは、\n世界。',
    );
  });

  it('rejects regions when a segment crosses multiple region boundaries', () => {
    const source = 'First line.\nSecond line.';
    const regions = [
      { id: 'r1', text: 'First line.', bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
      { id: 'r2', text: 'Second line.', bbox: { x0: 0, y0: 40, x1: 100, y1: 80 } },
    ];
    const segments = [{ source, translation: '一行目。二行目。' }];

    expect(buildTranslationRegions(source, segments, regions, 100, 80)).toEqual([]);
  });

  it('rejects edited or mismatched text instead of attaching a wrong translation', () => {
    const regions = [
      { id: 'r1', text: 'Hello world.', bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
    ];

    expect(
      buildTranslationRegions(
        'Hello world.',
        [{ source: 'Hello there.', translation: 'やあ。' }],
        regions,
        100,
        40,
      ),
    ).toEqual([]);

    expect(
      buildTranslationRegions(
        'Hello world.',
        [{ source: 'Hello world.', translation: 'こんにちは、世界。' }],
        [{ ...regions[0], text: 'Hello there.' }],
        100,
        40,
      ),
    ).toEqual([]);
  });

  it('rejects a region when segments do not cover all of its non-whitespace characters', () => {
    const source = 'Hello world.';
    const regions = [
      { id: 'r1', text: source, bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
    ];

    expect(
      buildTranslationRegions(
        source,
        [{ source: 'Hello', translation: 'こんにちは' }],
        regions,
        100,
        40,
      ),
    ).toEqual([]);
  });

  it('rejects non-finite, zero-sized and out-of-image bboxes', () => {
    const segments = [{ source: 'Hello', translation: 'やあ' }];
    const invalid = [
      { x0: Number.NaN, y0: 0, x1: 100, y1: 40 },
      { x0: 0, y0: Number.POSITIVE_INFINITY, x1: 100, y1: 40 },
      { x0: -1, y0: 0, x1: 100, y1: 40 },
      { x0: 0, y0: 0, x1: 100.5, y1: 40 },
      { x0: 50, y0: 0, x1: 50, y1: 40 },
      { x0: 0, y0: 20, x1: 100, y1: 20 },
    ];

    for (const bbox of invalid) {
      expect(
        buildTranslationRegions(
          'Hello',
          segments,
          [{ id: 'r1', text: 'Hello', bbox }],
          100,
          40,
        ),
      ).toEqual([]);
    }

    const validRegion = [
      { id: 'r1', text: 'Hello', bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
    ];
    expect(buildTranslationRegions('Hello', segments, validRegion, 0, 40)).toEqual([]);
    expect(buildTranslationRegions('Hello', segments, validRegion, 100, 0)).toEqual([]);
  });

  it('omits only the region without usable coverage and keeps other safe mappings', () => {
    const source = 'Hello.\n\nWorld.';
    const regions = [
      { id: 'r1', text: 'Hello.', bbox: { x0: 0, y0: 0, x1: 100, y1: 40 } },
      { id: 'r2', text: 'World.', bbox: { x0: 0, y0: 40, x1: 100, y1: 80 } },
    ];
    const segments = [{ source: 'Hello.', translation: 'こんにちは。' }];

    expect(buildTranslationRegions(source, segments, regions, 100, 80)).toEqual([
      {
        id: 'r1',
        source: 'Hello.',
        translation: 'こんにちは。',
        x: 0,
        y: 0,
        width: 1,
        height: 0.5,
      },
    ]);
  });
});
