import { describe, expect, it } from "vitest";
import { SPEECH_MODEL_ID, estimateNeurons, quotaDayStart } from "../src/shared/neurons";

describe("estimateNeurons", () => {
  it("applies Cloudflare's per-model token rates", () => {
    // Qwen3 30B: 4,625 in / 30,475 out per 1M tokens.
    expect(estimateNeurons("@cf/qwen/qwen3-30b-a3b-fp8", 1_000_000, 0)).toBeCloseTo(4_625);
    expect(estimateNeurons("@cf/qwen/qwen3-30b-a3b-fp8", 2_000, 500)).toBeCloseTo(9.25 + 15.2375);
  });

  it("prices unknown models at the highest known rate", () => {
    expect(estimateNeurons("@cf/unknown/model", 1_000_000, 0)).toBeCloseTo(5_500);
  });

  it("estimates speech from characters as audio minutes", () => {
    // 840 characters ≈ 60 s of audio ≈ 18.63 Neurons.
    expect(estimateNeurons(SPEECH_MODEL_ID, 840, 0)).toBeCloseTo(18.63);
  });
});

describe("quotaDayStart", () => {
  it("resets at 00:00 UTC (09:00 JST)", () => {
    const beforeReset = Date.parse("2026-10-22T08:59:00+09:00");
    const afterReset = Date.parse("2026-10-22T09:01:00+09:00");
    expect(new Date(quotaDayStart(beforeReset)).toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(new Date(quotaDayStart(afterReset)).toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });
});
