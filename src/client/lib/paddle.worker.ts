import { PaddleOcrService } from 'ppu-paddle-ocr/web';
import { env } from 'onnxruntime-web';
import { groupPaddleLines } from '../../shared/paddle-layout';
import type { OcrTextLine } from '../../shared/ocr-layout';
import {
  MAX_OVERLAP_RETRIES,
  OVERLAP_THRESHOLD,
  linesInside,
  overlapRatio,
  retryWindow,
  splitOverlaps,
  hasHeavyOverlap,
} from '../../shared/ocr-overlap';
import type { OcrBBox } from './ocr';

// One WASM thread works without COOP/COEP and leaves the UI responsive.
env.wasm.numThreads = 1;
env.wasm.wasmPaths = new URL('/models/ocr/v5-en-int8/', self.location.origin).href;
let service: PaddleOcrService | null = null;
let initPromise: Promise<PaddleOcrService> | null = null;

async function getOrCreateService(): Promise<PaddleOcrService> {
  if (service) return service;
  if (!initPromise) {
    initPromise = (async () => {
      const base = new URL('/models/ocr/v5-en-int8/', self.location.origin).href;
      const s = new PaddleOcrService({
        model: { detection: base + 'det.ort', recognition: base + 'rec.ort', charactersDictionary: base + 'dict.txt' },
        session: { executionProviders: ['wasm'] },
        recognition: { strategy: 'per-box', charactersDictionary: [] },
      });
      await s.initialize();
      service = s;
      return s;
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function readLines(
  activeService: PaddleOcrService,
  source: OffscreenCanvas,
  offset = { x: 0, y: 0 },
  scale = 1,
): Promise<OcrTextLine[]> {
  const output = await activeService.recognize(source, { flatten: true, noCache: true });
  return output.results.map((item) => ({
    text: item.text,
    confidence: item.confidence * 100,
    bbox: {
      x0: offset.x + item.box.x / scale,
      y0: offset.y + item.box.y / scale,
      x1: offset.x + (item.box.x + item.box.width) / scale,
      y1: offset.y + (item.box.y + item.box.height) / scale,
    },
  }));
}

/**
 * Text boxes that overlap by half or more are almost always one bubble read
 * twice or two bubbles fused. Each such conflict is re-read from up to three
 * differently framed crops of the surrounding area; boxes without conflicts
 * are kept untouched. A conflict that never resolves is dropped and counted.
 */
async function resolveOverlaps(
  activeService: PaddleOcrService,
  canvas: OffscreenCanvas,
  regions: OcrTextLine[],
  panels: OcrBBox[],
): Promise<{ regions: OcrTextLine[]; unresolved: number }> {
  const { clean, clusters } = splitOverlaps(regions);
  if (!clusters.length) return { regions, unresolved: 0 };

  const resolved: OcrTextLine[] = [...clean];
  let unresolved = 0;
  for (const cluster of clusters) {
    let replacement: OcrTextLine[] | null = null;
    for (let attempt = 0; attempt < MAX_OVERLAP_RETRIES && !replacement; attempt++) {
      const { box, scale } = retryWindow(cluster.bbox, attempt, canvas.width, canvas.height);
      const width = Math.max(1, Math.round((box.x1 - box.x0) * scale));
      const height = Math.max(1, Math.round((box.y1 - box.y0) * scale));
      const crop = new OffscreenCanvas(width, height);
      const ctx = crop.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 0, 0, width, height);
      try {
        const lines = linesInside(await readLines(activeService, crop, { x: box.x0, y: box.y0 }, scale), cluster.bbox);
        const candidate = groupPaddleLines(lines, panels);
        const collides = candidate.some((region) =>
          clean.some((other) => overlapRatio(region.bbox, other.bbox) >= OVERLAP_THRESHOLD),
        );
        if (candidate.length && !hasHeavyOverlap(candidate) && !collides) replacement = candidate;
      } catch {
        // A failed crop counts as a failed attempt.
      }
    }
    if (replacement) resolved.push(...replacement);
    else unresolved += 1;
  }
  return { regions: resolved, unresolved };
}

export interface PaddleWorkerInitMessage {
  type: 'init';
}

export interface PaddleWorkerRecognizeMessage {
  type?: 'recognize';
  bitmap: ImageBitmap;
  panels?: OcrBBox[];
  debug?: boolean;
}

export type PaddleWorkerInbound = PaddleWorkerInitMessage | PaddleWorkerRecognizeMessage;

self.onmessage = async ({ data }: MessageEvent<PaddleWorkerInbound>) => {
  if ('type' in data && data.type === 'init') {
    try {
      await getOrCreateService();
      self.postMessage({ type: 'init_done', success: true });
    } catch (error) {
      self.postMessage({
        type: 'init_done',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const { bitmap, panels = [] } = data as PaddleWorkerRecognizeMessage;
  try {
    const activeService = await getOrCreateService();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const lines = await readLines(activeService, canvas);
    const { regions: grouped, unresolved } = await resolveOverlaps(
      activeService,
      canvas,
      groupPaddleLines(lines, panels),
      panels,
    );
    const regions = grouped
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
      .map((line, i) => ({ ...line, id: `paddle_r${i}` }));
    self.postMessage({
      result: {
        regions,
        unresolved,
        text: regions.map((r) => r.text).join('\n\n'),
        confidence: regions.length
          ? regions.reduce((n, r) => n + r.confidence, 0) / regions.length
          : 0,
        ...(data.debug ? { debug: { lines, panels } } : {}),
      },
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    try {
      bitmap?.close();
    } catch {
      // ignore close errors
    }
  }
};
