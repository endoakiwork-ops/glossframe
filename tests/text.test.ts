import { describe, expect, it } from "vitest";
import {
  countChars,
  estimateTokens,
  safeJsonParse,
  sha256Hex,
  truncate,
} from "../src/shared/text";

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes bytes and strings identically", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256Hex(bytes)).toBe(await sha256Hex("hello"));
  });
});

describe("truncate", () => {
  it("counts code points rather than UTF-16 units", () => {
    expect(truncate("あいうえお", 3)).toBe("あいう…");
    expect(truncate("😀😀😀", 2)).toBe("😀😀…");
    expect(truncate("short", 10)).toBe("short");
  });
});

describe("countChars", () => {
  it("counts emoji as one character", () => {
    expect(countChars("a😀b")).toBe(3);
  });
});

describe("estimateTokens", () => {
  it("returns a rough positive estimate", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdef")).toBe(2);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON and returns null for invalid input", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("{nope")).toBeNull();
  });
});
