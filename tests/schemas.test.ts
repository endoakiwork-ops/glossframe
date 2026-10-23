import { describe, expect, it } from "vitest";
import {
  aiQuizBatchRequestSchema,
  backupSchema,
  chatRequestSchema,
  explainRequestSchema,
  reviewRatingSchema,
  settingsPatchSchema,
  translateSchema,
  wordCompleteRequestSchema,
  wordCreateSchema,
  wordLookupSchema,
} from "../src/shared/schemas";

describe("translateSchema", () => {
  it("trims text and accepts a supported language pair", () => {
    const result = translateSchema.parse({
      text: "  Hello world  ",
      sourceLang: "en",
      targetLang: "ja",
    });
    expect(result.text).toBe("Hello world");
    expect(result.saveHistory).toBe(true);
  });

  it("rejects empty text, unsupported languages, and overly long text", () => {
    expect(() =>
      translateSchema.parse({ text: "   ", sourceLang: "en", targetLang: "ja" }),
    ).toThrow();
    expect(() =>
      translateSchema.parse({ text: "hi", sourceLang: "xx", targetLang: "ja" }),
    ).toThrow();
    expect(() =>
      translateSchema.parse({ text: "a".repeat(6001), sourceLang: "en", targetLang: "ja" }),
    ).toThrow();
  });
});

describe("settingsPatchSchema", () => {
  it("accepts a partial patch", () => {
    const result = settingsPatchSchema.parse({
      saveImages: false,
      reviewIntervalDays: 14,
      reviewOrder: "random",
    });
    expect(result.reviewIntervalDays).toBe(14);
  });

  it("rejects empty and out-of-range patches", () => {
    expect(() => settingsPatchSchema.parse({})).toThrow();
    expect(() => settingsPatchSchema.parse({ reviewIntervalDays: 0 })).toThrow();
    expect(() => settingsPatchSchema.parse({ reviewTargetCount: 11 })).toThrow();
    expect(() => settingsPatchSchema.parse({ reviewOrder: "alphabetical" })).toThrow();
  });
});

describe("wordCreateSchema", () => {
  it("fills optional fields with defaults", () => {
    const result = wordCreateSchema.parse({
      term: "serendipity",
      meaning: "偶然の幸運",
      sourceText: "It was pure serendipity.",
      sourceLang: "en",
      targetLang: "ja",
    });
    expect(result.baseForm).toBe("");
    expect(result.contextMeaning).toBe("");
    expect(result.image).toBeUndefined();
  });

  it("accepts a deduplicated existing image key", () => {
    const result = wordCreateSchema.parse({
      term: "serendipity",
      meaning: "偶然の幸運",
      sourceText: "It was pure serendipity.",
      sourceLang: "en",
      targetLang: "ja",
      existingImageKey: "a".repeat(64),
    });
    expect(result.existingImageKey).toBe("a".repeat(64));
  });

  it("rejects an unsupported image content type", () => {
    expect(() =>
      wordCreateSchema.parse({
        term: "word",
        meaning: "意味",
        sourceText: "word",
        sourceLang: "en",
        targetLang: "ja",
        image: {
          dataBase64: "AAAA",
          contentType: "image/gif",
          sha256: "a".repeat(64),
        },
      }),
    ).toThrow();
  });
});

describe("wordLookupSchema", () => {
  it("defaults to the source side", () => {
    const result = wordLookupSchema.parse({
      term: "run",
      sentence: "I run every morning.",
      sourceLang: "en",
      targetLang: "ja",
    });
    expect(result.side).toBe("source");
  });
});

describe("backupSchema", () => {
  const valid = {
    format: "glossframe-backup",
    version: 1,
    exportedAt: 1_700_000_000_000,
    settings: {
      sourceLang: "en",
      targetLang: "ja",
      saveImages: true,
      reviewIntervalDays: 7,
      reviewTargetCount: 3,
      reviewBatchSize: 20,
      reviewShowImage: true,
      reviewOrder: "due",
      createdAt: 1,
      updatedAt: 2,
    },
    translations: [],
    words: [],
    examples: [],
    reviewEvents: [],
    images: [],
  };

  it("accepts a valid empty backup", () => {
    expect(backupSchema.parse(valid).format).toBe("glossframe-backup");
  });

  it("rejects a different format or version", () => {
    expect(() => backupSchema.parse({ ...valid, format: "other" })).toThrow();
    expect(() => backupSchema.parse({ ...valid, version: 2 })).toThrow();
  });

  it("requires image entries to carry base64 data", () => {
    expect(() =>
      backupSchema.parse({
        ...valid,
        images: [{ key: "abc", contentType: "image/webp" }],
      }),
    ).toThrow();
  });
});

describe("learning & AI schemas", () => {
  it("parses reviewRatingSchema with defaults for mode, assisted, and retry", () => {
    const parsed = reviewRatingSchema.parse({ rating: "known" });
    expect(parsed.mode).toBe("card");
    expect(parsed.assisted).toBe(false);
    expect(parsed.retry).toBe(false);
  });

  it("parses explainRequestSchema and chatRequestSchema with learnerLevel defaults", () => {
    const explain = explainRequestSchema.parse({ sourceText: "We ran out of milk." });
    expect(explain.learnerLevel).toBe("800");

    const chat = chatRequestSchema.parse({
      sourceText: "We ran out of milk.",
      question: "どういう意味ですか？",
    });
    expect(chat.learnerLevel).toBe("800");
    expect(chat.history).toEqual([]);
  });

  it("parses wordCompleteRequestSchema and aiQuizBatchRequestSchema", () => {
    const complete = wordCompleteRequestSchema.parse({ term: "run out of" });
    expect(complete.learnerLevel).toBe("800");

    const quiz = aiQuizBatchRequestSchema.parse({ count: 10, mode: "cloze" });
    expect(quiz.count).toBe(10);
    expect(quiz.mode).toBe("cloze");
  });
});
