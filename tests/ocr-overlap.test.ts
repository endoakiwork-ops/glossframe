import { describe, expect, it } from "vitest";
import { linesInside, overlapRatio, retryWindow, splitOverlaps } from "../src/shared/ocr-overlap";

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

describe("overlapRatio", () => {
  it("measures against the smaller box", () => {
    expect(overlapRatio(box(0, 0, 100, 100), box(50, 0, 100, 50))).toBe(1);
    expect(overlapRatio(box(0, 0, 100, 100), box(80, 0, 180, 100))).toBeCloseTo(0.2);
    expect(overlapRatio(box(0, 0, 10, 10), box(20, 20, 30, 30))).toBe(0);
  });
});

describe("splitOverlaps", () => {
  it("keeps non-overlapping regions and clusters heavy overlaps transitively", () => {
    const regions = [
      { id: "a", bbox: box(0, 0, 100, 40) },
      { id: "b", bbox: box(10, 5, 90, 35) }, // fully inside a
      { id: "c", bbox: box(50, 10, 110, 40) }, // overlaps b by > 50% of c
      { id: "d", bbox: box(300, 300, 400, 340) }, // far away
      { id: "e", bbox: box(105, 0, 205, 40) }, // brushes c by under 10%
    ];
    const { clean, clusters } = splitOverlaps(regions);
    expect(clean.map((r) => r.id).sort()).toEqual(["d", "e"]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    expect(clusters[0].bbox).toEqual(box(0, 0, 110, 40));
  });
});

describe("retryWindow", () => {
  it("frames three different areas and stays inside the image", () => {
    const conflict = box(100, 100, 200, 150);
    const windows = [0, 1, 2].map((attempt) => retryWindow(conflict, attempt, 400, 300));
    const keys = new Set(windows.map((w) => JSON.stringify(w.box)));
    expect(keys.size).toBe(3);
    for (const { box: b, scale } of windows) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(400);
      expect(b.y1).toBeLessThanOrEqual(300);
      expect(b.x0).toBeLessThanOrEqual(100);
      expect(b.x1).toBeGreaterThanOrEqual(200);
      expect(scale).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("linesInside", () => {
  it("drops neighbours caught by a wider crop", () => {
    const lines = [{ bbox: box(10, 10, 50, 20) }, { bbox: box(500, 10, 540, 20) }];
    expect(linesInside(lines, box(0, 0, 100, 100))).toHaveLength(1);
  });
});
