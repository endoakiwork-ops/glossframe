import { describe, expect, it } from "vitest";
import { phraseForSelection, tokenize } from "../src/client/lib/tokenize";

describe("tokenize", () => {
  it("marks words and punctuation separately", () => {
    const tokens = tokenize("Hello, world!", "en");
    expect(tokens.map((token) => token.text).join("")).toBe("Hello, world!");
    expect(tokens.filter((token) => token.isWord).map((token) => token.text)).toEqual([
      "Hello",
      "world",
    ]);
  });

  it("keeps whitespace in the token stream", () => {
    const tokens = tokenize("a b", "en");
    expect(tokens.some((token) => token.text === " " && !token.isWord)).toBe(true);
  });
});

describe("phraseForSelection", () => {
  const tokens = tokenize("The quick brown fox jumps.", "en");

  it("returns the text spanning selected word tokens", () => {
    const selected = tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => token.isWord && ["quick", "brown"].includes(token.text))
      .map(({ index }) => index);
    expect(phraseForSelection(tokens, new Set(selected))).toBe("quick brown");
  });

  it("returns an empty string when nothing is selected", () => {
    expect(phraseForSelection(tokens, new Set())).toBe("");
  });
});
