import type { OcrTextLine } from "./ocr-layout";

type Box = OcrTextLine["bbox"];

/** Regions sharing at least this much of the smaller box are treated as a misdetection. */
export const OVERLAP_THRESHOLD = 0.5;
/** Each conflict is re-read from this many differently framed crops before giving up. */
export const MAX_OVERLAP_RETRIES = 3;

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/** Intersection area divided by the smaller box's area (0..1). */
export function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? (w * h) / smaller : 0;
}

export function hasHeavyOverlap<T extends { bbox: Box }>(regions: T[], threshold = OVERLAP_THRESHOLD): boolean {
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (overlapRatio(regions[i].bbox, regions[j].bbox) >= threshold) return true;
    }
  }
  return false;
}

export interface OverlapCluster<T> {
  members: T[];
  bbox: Box;
}

/**
 * Splits regions into ones that can be shown as-is and clusters of regions
 * that overlap each other by at least `threshold` (transitively connected).
 */
export function splitOverlaps<T extends { bbox: Box }>(
  regions: T[],
  threshold = OVERLAP_THRESHOLD,
): { clean: T[]; clusters: OverlapCluster<T>[] } {
  const parent = regions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (overlapRatio(regions[i].bbox, regions[j].bbox) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, T[]>();
  regions.forEach((region, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), region]);
  });
  const clean: T[] = [];
  const clusters: OverlapCluster<T>[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      clean.push(members[0]);
      continue;
    }
    const bbox = members.reduce<Box>(
      (box, m) => ({
        x0: Math.min(box.x0, m.bbox.x0),
        y0: Math.min(box.y0, m.bbox.y0),
        x1: Math.max(box.x1, m.bbox.x1),
        y1: Math.max(box.y1, m.bbox.y1),
      }),
      { ...members[0].bbox },
    );
    clusters.push({ members, bbox });
  }
  return { clean, clusters };
}

/**
 * The crop for retry `attempt` around a conflict. Each attempt frames a
 * different area — moderate context, wide context, then a tight crop that is
 * enlarged — so the detector sees the text at a different scale every time.
 */
export function retryWindow(
  bbox: Box,
  attempt: number,
  imageWidth: number,
  imageHeight: number,
): { box: Box; scale: number } {
  const w = bbox.x1 - bbox.x0;
  const h = bbox.y1 - bbox.y0;
  const size = Math.max(w, h);
  const pad = [0.25, 0.6, 0.06][Math.min(attempt, 2)] * size;
  const box = {
    x0: Math.max(0, Math.floor(bbox.x0 - pad)),
    y0: Math.max(0, Math.floor(bbox.y0 - pad)),
    x1: Math.min(imageWidth, Math.ceil(bbox.x1 + pad)),
    y1: Math.min(imageHeight, Math.ceil(bbox.y1 + pad)),
  };
  const longest = Math.max(1, box.x1 - box.x0, box.y1 - box.y0);
  // Enlarge small crops so glyphs reach a size the detector handles well,
  // without producing an oversized canvas on phones.
  const target = attempt === 2 ? 1600 : 1200;
  const scale = Math.min(attempt === 2 ? 3 : 2, Math.max(1, target / longest));
  return { box, scale };
}

/** Keep re-read lines that belong to the conflict, not neighbours caught by the wider crop. */
export function linesInside<T extends { bbox: Box }>(lines: T[], bbox: Box): T[] {
  return lines.filter((line) => {
    const cx = (line.bbox.x0 + line.bbox.x1) / 2;
    const cy = (line.bbox.y0 + line.bbox.y1) / 2;
    return cx >= bbox.x0 && cx <= bbox.x1 && cy >= bbox.y0 && cy <= bbox.y1;
  });
}
