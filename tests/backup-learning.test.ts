import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../src/worker/env";
import { ApiError } from "../src/worker/errors";
import { backupRoutes } from "../src/worker/routes/backup";

interface StatementRecord {
  sql: string;
  params: unknown[];
}

type QueryHandler = (sql: string, params: unknown[]) => unknown;

class FakeDb {
  readonly statements: StatementRecord[] = [];

  constructor(private readonly handler: QueryHandler) {}

  prepare(sql: string) {
    const record: StatementRecord = { sql, params: [] };
    const statement = {
      bind: (...params: unknown[]) => {
        record.params = params;
        return statement;
      },
      first: async () => {
        this.statements.push(record);
        return this.handler(sql, record.params);
      },
      all: async () => {
        this.statements.push(record);
        return this.handler(sql, record.params) ?? { results: [] };
      },
      run: async () => {
        this.statements.push(record);
        return this.handler(sql, record.params) ?? { meta: { changes: 0 } };
      },
    };
    return statement;
  }
}

const settingsRow = {
  id: 1,
  source_lang: "en",
  target_lang: "ja",
  save_images: 1,
  review_interval_days: 7,
  review_target_count: 3,
  review_batch_size: 20,
  review_show_image: 1,
  review_order: "due",
  created_at: 10,
  updated_at: 20,
};

function makeEnv(db: FakeDb): Env {
  const images = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return { DB: db, IMAGES: images } as unknown as Env;
}

function makeApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.status,
      );
    }
    throw error;
  });
  app.route("/api", backupRoutes);
  return app;
}

const translationRow = {
  id: "t1",
  source_text: "Hello world.",
  translated_text: "こんにちは世界。",
  source_lang: "en",
  target_lang: "ja",
  segments_json: JSON.stringify([{ source: "Hello", translation: "こんにちは" }]),
  grammar_notes_json: "[]",
  key_phrases_json: "[]",
  image_key: null,
  created_at: 100,
};

const wordRow = {
  id: "w1",
  term: "apple",
  normalized_term: "apple",
  base_form: "apple",
  part_of_speech: "noun",
  meaning: "りんご",
  source_lang: "en",
  target_lang: "ja",
  origin: "manual",
  review_count: 9,
  known_count: 2,
  recall_count: 4,
  known_reviewed_day: "2026-10-20",
  recall_reviewed_day: "2026-10-21",
  cloze_options_json: JSON.stringify({
    sourceText: "I ate an apple.",
    surface: "apple",
    choices: ["apple", "orange", "banana", "grape"],
    updatedAt: 123,
  }),
  mastered: 1,
  next_review_at: null,
  last_reviewed_at: 456,
  created_at: 100,
  updated_at: 200,
};

const region = {
  id: "r1",
  source: "Hello",
  translation: "こんにちは",
  x: 0,
  y: 0,
  width: 0.5,
  height: 0.5,
};

describe("GET /api/backup", () => {
  it("exports learning tracks, cloze options, review metadata and regions", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("SELECT known_count")) return { results: [] };
      if (sql.includes("SELECT * FROM settings")) return settingsRow;
      if (sql.includes("COALESCE(SUM(size)")) return { bytes: 0 };
      if (sql.includes("FROM translations")) return { results: [translationRow] };
      if (sql.includes("FROM word_examples")) return { results: [] };
      if (sql.includes("FROM words ORDER BY")) return { results: [wordRow] };
      if (sql.includes("FROM review_events")) {
        return {
          results: [
            {
              id: "e1",
              word_id: "w1",
              rating: "known",
              mode: "cloze",
              assisted: 1,
              gained: 1,
              review_count_after: 7,
              reviewed_at: 100,
              next_review_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM translation_regions")) {
        return { results: [{ translation_id: "t1", regions_json: JSON.stringify([region]) }] };
      }
      if (sql.includes("FROM images")) return { results: [] };
      return undefined;
    });

    const response = await makeApp().request("/api/backup", undefined, makeEnv(db));
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;

    expect(body.version).toBe(1);
    expect(body.translations[0].regions).toEqual([region]);

    const word = body.words[0];
    expect(word.reviewCount).toBe(9);
    // Stored comprehension must not be inflated to the legacy review count.
    expect(word.knownCount).toBe(2);
    expect(word.recallCount).toBe(4);
    expect(word.origin).toBe("manual");
    expect(word.knownReviewedDay).toBe("2026-10-20");
    expect(word.recallReviewedDay).toBe("2026-10-21");
    expect(word.clozeOptions).toEqual({
      sourceText: "I ate an apple.",
      surface: "apple",
      choices: ["apple", "orange", "banana", "grape"],
      updatedAt: 123,
    });

    expect(body.reviewEvents[0]).toMatchObject({
      mode: "cloze",
      assisted: true,
      gained: true,
      rating: "known",
      reviewCountAfter: 7,
    });
  });

  it("rejects an image-heavy export with 413 and supports includeImages=false", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("SELECT known_count")) return { results: [] };
      if (sql.includes("SELECT * FROM settings")) return settingsRow;
      if (sql.includes("COALESCE(SUM(size)")) return { bytes: 25 * 1024 * 1024 };
      if (sql.includes("FROM translations")) return { results: [] };
      if (sql.includes("FROM word_examples")) return { results: [] };
      if (sql.includes("FROM words ORDER BY")) return { results: [] };
      if (sql.includes("FROM review_events")) return { results: [] };
      if (sql.includes("FROM translation_regions")) return { results: [] };
      if (sql.includes("FROM images")) return { results: [] };
      return undefined;
    });
    const app = makeApp();

    const rejected = await app.request("/api/backup", undefined, makeEnv(db));
    expect(rejected.status).toBe(413);
    const error = (await rejected.json()) as any;
    expect(error.error.code).toBe("BACKUP_TOO_LARGE");
    expect(error.error.message).toContain("includeImages=false");
    expect(error.error.details.imageBytes).toBe(25 * 1024 * 1024);

    const withoutImages = await app.request(
      "/api/backup?includeImages=false",
      undefined,
      makeEnv(db),
    );
    expect(withoutImages.status).toBe(200);
    const body = (await withoutImages.json()) as any;
    expect(body.images).toEqual([]);
    expect(db.statements.some((item) => item.sql.includes("FROM images ORDER BY"))).toBe(false);
  });
});

describe("POST /api/backup/restore", () => {
  it("keeps comprehension and recall binds separate and filters invalid caches/regions", async () => {
    const db = new FakeDb((sql, params) => {
      if (sql.includes("SELECT known_count")) return { results: [] };
      if (sql.includes("SELECT * FROM settings")) return settingsRow;
      if (sql.includes("UPDATE settings")) return { meta: { changes: 1 } };
      if (sql.includes("INSERT OR IGNORE INTO translations")) {
        return { meta: { changes: params[0] === "t-new" ? 1 : 0 } };
      }
      if (sql.includes("INTO translation_regions")) return { meta: { changes: 1 } };
      if (sql.includes("SELECT id FROM words WHERE normalized_term")) return null;
      if (sql.includes("INSERT INTO words")) return { meta: { changes: 1 } };
      if (sql.includes("SELECT id FROM words WHERE id")) return { id: params[0] };
      if (sql.includes("INSERT OR IGNORE INTO review_events")) return { meta: { changes: 1 } };
      return undefined;
    });

    const backup = {
      format: "glossframe-backup",
      version: 1,
      exportedAt: 1,
      settings: {
        sourceLang: "en",
        targetLang: "ja",
        saveImages: true,
        reviewIntervalDays: 7,
        reviewTargetCount: 3,
        reviewBatchSize: 20,
        reviewShowImage: true,
        reviewOrder: "due",
        createdAt: 10,
        updatedAt: 20,
      },
      translations: [
        {
          id: "t-new",
          sourceText: "Hello world.",
          translatedText: "こんにちは世界。",
          sourceLang: "en",
          targetLang: "ja",
          segments: [],
          grammarNotes: [],
          keyPhrases: [],
          createdAt: 100,
          regions: [
            region,
            { ...region, source: "world" }, // duplicate id
            { ...region, id: "r2", source: "missing" }, // not in sourceText
            { ...region, id: "r3", x: 0.8, width: 0.5 }, // outside the image
          ],
        },
        {
          id: "t-existing",
          sourceText: "Existing text.",
          translatedText: "既存の翻訳",
          sourceLang: "en",
          targetLang: "ja",
          segments: [],
          grammarNotes: [],
          keyPhrases: [],
          createdAt: 101,
          regions: [{ ...region, id: "keep", source: "Existing" }],
        },
      ],
      words: [
        {
          id: "w1",
          term: "apple",
          meaning: "りんご",
          sourceLang: "en",
          targetLang: "ja",
          origin: "manual",
          reviewCount: 9,
          knownCount: 2,
          recallCount: 4,
          knownReviewedDay: "2026-10-20",
          recallReviewedDay: "2026-10-21",
          mastered: true,
          lastReviewedAt: 456,
          createdAt: 100,
          updatedAt: 200,
          clozeOptions: {
            sourceText: "I ate an apple.",
            surface: "apple",
            choices: ["apple", "orange", "banana", "grape"],
          },
        },
        {
          id: "w2",
          term: "pear",
          meaning: "なし",
          sourceLang: "en",
          targetLang: "ja",
          reviewCount: 3,
          clozeOptions: {
            sourceText: "A pear.",
            surface: "pear",
            choices: ["pear", "pear", "apple", "orange"], // duplicate choices
          },
        },
        {
          id: "w3",
          term: "plum",
          meaning: "すもも",
          sourceLang: "en",
          targetLang: "ja",
          reviewCount: 5,
          knownCount: 1,
          clozeOptions: {
            sourceText: "A plum.",
            surface: "pear", // surface does not occur in sourceText
            choices: ["pear", "apple", "orange", "grape"],
          },
        },
      ],
      examples: [],
      reviewEvents: [
        {
          id: "e1",
          wordId: "w1",
          rating: "known",
          mode: "recall",
          assisted: true,
          gained: true,
          reviewCountAfter: 7,
          reviewedAt: 100,
          nextReviewAt: null,
        },
        {
          id: "e2",
          wordId: "w1",
          rating: "unknown",
          reviewCountAfter: 8,
          reviewedAt: 101,
          nextReviewAt: 102,
        },
      ],
      images: [],
    };

    const response = await makeApp().request(
      "/api/backup/restore",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(backup),
      },
      makeEnv(db),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result.counts).toMatchObject({ translations: 1, words: 3, reviewEvents: 2 });

    const wordInserts = db.statements.filter((item) => item.sql.includes("INSERT INTO words"));
    expect(wordInserts).toHaveLength(3);

    const insertedW1 = wordInserts.find((item) => item.params[0] === "w1");
    expect(insertedW1).toBeDefined();
    expect(insertedW1!.params[9]).toBe(9); // reviewCount
    expect(insertedW1!.params[10]).toBe(2); // knownCount stays 2, never max(9, 2)
    expect(insertedW1!.params[11]).toBe(4); // recallCount
    expect(insertedW1!.params[12]).toBe("2026-10-20");
    expect(insertedW1!.params[13]).toBe("2026-10-21");
    expect(JSON.parse(String(insertedW1!.params[14]))).toEqual({
      sourceText: "I ate an apple.",
      surface: "apple",
      choices: ["apple", "orange", "banana", "grape"],
    });
    expect(insertedW1!.params[15]).toBe(1); // mastered

    const insertedW2 = wordInserts.find((item) => item.params[0] === "w2");
    expect(insertedW2!.params[10]).toBe(3); // legacy backup: fall back to reviewCount
    expect(insertedW2!.params[14]).toBeNull(); // duplicate choices are discarded

    const insertedW3 = wordInserts.find((item) => item.params[0] === "w3");
    expect(insertedW3!.params[10]).toBe(1);
    expect(insertedW3!.params[14]).toBeNull(); // source/surface mismatch is discarded

    const reviewInserts = db.statements.filter((item) =>
      item.sql.includes("INSERT OR IGNORE INTO review_events"),
    );
    expect(reviewInserts).toHaveLength(2);
    const event1 = reviewInserts.find((item) => item.params[0] === "e1");
    const event2 = reviewInserts.find((item) => item.params[0] === "e2");
    expect(event1!.params.slice(2, 6)).toEqual(["known", "recall", 1, 1]);
    // version-1 records without mode/flags stay card / false / false.
    expect(event2!.params.slice(2, 6)).toEqual(["unknown", "card", 0, 0]);

    const regionInserts = db.statements.filter((item) =>
      item.sql.includes("INTO translation_regions"),
    );
    expect(regionInserts).toHaveLength(1);
    expect(regionInserts[0].params[0]).toBe("t-new");
    expect(JSON.parse(String(regionInserts[0].params[1]))).toEqual([region]);
  });
});
