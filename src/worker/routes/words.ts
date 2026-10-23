import { Hono } from "hono";
import { filterUnambiguousQuestions } from "../quiz-quality";
import type { AppEnv } from "../env";
import { parseBody } from "../validate";
import {
  aiQuizBatchRequestSchema,
  aiQuizPlanResultSchema,
  aiQuizExamplesRequestSchema,
  aiQuizExamplesResultSchema,
  clozeBatchRequestSchema,
  clozeBatchResultSchema,
  reviewRatingSchema,
  similarExpressionsSchema,
  similarRequestSchema,
  wordCompleteRequestSchema,
  wordCompleteResultSchema,
  wordCreateSchema,
  wordDetailSchema,
  wordExamplesRequestSchema,
  wordExamplesResultSchema,
  wordLookupSchema,
  wordUpdateSchema,
} from "../../shared/schemas";
import {
  ensureLearningSchema,
  ensureSettings,
  getWord,
  getWordByTerm,
  getWordsForReview,
  listWords,
  mapExample,
} from "../db";
import {
  computeTrackReview,
  findTermRanges,
  normalizeTerm,
  selectReferenceProfile,
  validateQuizQuestion,
} from "../../shared/srs";
import type { AiQuizExample, ClozeOptionSet } from "../../shared/types";
import { validateQuizPlanItem, type QuizPlanItem } from "../../shared/quiz-plan";
import { learnerLevelInfo } from "../../shared/types";
import { runJsonModel } from "../ai";
import {
  ALT_EXAMPLES_SYSTEM,
  CLOZE_BATCH_SYSTEM,
  COMPLETE_WORD_SYSTEM,
  QUIZ_EXAMPLES_SYSTEM,
  QUIZ_PLAN_SYSTEM,
  QUIZ_THEMES,
  SIMILAR_SYSTEM,
  WORD_SYSTEM,
  altExamplesUser,
  clozeBatchUser,
  completeWordUser,
  quizExamplesUser,
  quizPlanUser,
  similarUser,
  wordUser,
} from "../prompts";
import { imageExists, storeImage, releaseImageIfUnused } from "../images";
import { ApiError } from "../errors";
import { recordReview } from "../review";

export const wordRoutes = new Hono<AppEnv>();

wordRoutes.post("/words/lookup", async (c) => {
  const body = await parseBody(c, wordLookupSchema);
  const { value, cached } = await runJsonModel(c.env, {
    kind: "word",
    system: WORD_SYSTEM,
    user: wordUser(body),
    schema: wordDetailSchema,
    maxTokens: 700,
    temperature: 0.1,
    cacheTtlMs: 90 * 24 * 60 * 60 * 1000,
  });

  const resolved =
    body.side === "translation"
      ? (value.sourceEquivalent || value.term || body.term).trim()
      : (value.term || body.term).trim();
  return c.json({
    ...value,
    term: resolved || body.term,
    baseForm: value.baseForm || resolved || body.term,
    meaning: value.meaning || value.contextMeaning || "",
    contextMeaning: value.contextMeaning || value.meaning || "",
    sourceEquivalent:
      value.sourceEquivalent || (body.side === "translation" ? resolved : value.term || body.term),
    cached,
  });
});

wordRoutes.post("/words/similar", async (c) => {
  const body = await parseBody(c, similarRequestSchema);
  const { value, cached } = await runJsonModel(c.env, {
    kind: "similar",
    system: SIMILAR_SYSTEM,
    user: similarUser({
      term: body.term,
      sentence: body.sentence,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
      learnerLevel: body.learnerLevel,
    }),
    schema: similarExpressionsSchema,
    maxTokens: 320,
    temperature: 0.2,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  });
  return c.json({
    expressions: value.expressions.filter((e) => e.term.trim() && e.meaning.trim()).slice(0, 3),
    cached,
  });
});

wordRoutes.post("/words/complete", async (c) => {
  const body = await parseBody(c, wordCompleteRequestSchema);
  const { value, cached } = await runJsonModel(c.env, {
    kind: "word_complete",
    system: COMPLETE_WORD_SYSTEM,
    user: completeWordUser({
      term: body.term,
      meaning: body.meaning,
      sourceText: body.sourceText,
      translatedText: body.translatedText,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
      learnerLevel: body.learnerLevel,
    }),
    schema: wordCompleteResultSchema,
    maxTokens: 800,
    temperature: 0.2,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  });

  // Preserve any field the user already entered so manual input is never overwritten.
  const meaning = body.meaning.trim() || value.meaning.trim();
  const sourceText = body.sourceText.trim() || value.sourceText.trim();
  const translatedText = body.translatedText.trim() || value.translatedText.trim();

  return c.json({
    term: body.term.trim(),
    baseForm: (value.baseForm || body.term).trim(),
    partOfSpeech: value.partOfSpeech.trim(),
    meaning,
    sourceText,
    translatedText,
    grammarNote: (value.grammarNote ?? "").trim(),
    cached,
  });
});

wordRoutes.get("/words", async (c) => {
  const filter = ["all", "due", "waiting", "mastered"].includes(c.req.query("filter") ?? "")
    ? (c.req.query("filter") as string)
    : "all";
  const q = (c.req.query("q") ?? "").slice(0, 100);
  const sort = ["created", "term", "due", "progress"].includes(c.req.query("sort") ?? "")
    ? (c.req.query("sort") as string)
    : "created";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const result = await listWords(c.env.DB, { filter, q, sort, limit, offset });
  return c.json({
    items: result.words,
    total: result.total,
    hasMore: offset + result.words.length < result.total,
    nextOffset: offset + result.words.length,
  });
});

wordRoutes.post("/words", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const body = await parseBody(c, wordCreateSchema, 14_000_000);
  const now = Date.now();
  const normalized = normalizeTerm(body.baseForm || body.term) || normalizeTerm(body.term);
  if (!normalized) {
    throw new ApiError(400, "INVALID_TERM", "単語を正しく入力してください。");
  }

  const origin = body.origin ?? "translation";
  if (origin === "translation" && body.translationId && body.term.trim().split(/\s+/).length > 1) {
    const original = await c.env.DB.prepare("SELECT key_phrases_json FROM translations WHERE id = ?")
      .bind(body.translationId).first<{key_phrases_json: string}>();
    const phrases = original ? JSON.parse(original.key_phrases_json) as Array<{term: string}> : [];
    if (!phrases.some(phrase => normalizeTerm(phrase.term) === normalizeTerm(body.term))) {
      throw new ApiError(400, "UNCONFIRMED_PHRASE", "文の範囲は質問に引用できます。単語帳には単語か確認済みの熟語を登録してください。");
    }
  }
  const sourceText = body.sourceText.trim();
  const translatedText = body.translatedText.trim();
  const hasExample = sourceText.length > 0;

  // Manual entries never store or attach images.
  let imageKey: string | null = null;
  if (origin !== "manual" && hasExample) {
    if (body.image) {
      const stored = await storeImage(c.env, body.image);
      imageKey = stored.key;
    } else if (body.existingImageKey && (await imageExists(c.env, body.existingImageKey))) {
      imageKey = body.existingImageKey;
    }
  }

  try {
    const existing = await getWordByTerm(c.env.DB, normalized, body.sourceLang, body.targetLang);
    if (existing) {
      if (origin === "manual" && !hasExample) {
        throw new ApiError(409, "DUPLICATE_WORD", "同じ単語が既に単語帳に登録されています。");
      }
      if (
        origin === "manual" &&
        existing.meaning.trim() === body.meaning.trim() &&
        !hasExample
      ) {
        throw new ApiError(409, "DUPLICATE_WORD", "同じ単語・意味が既に登録されています。");
      }

      let addedExample = false;
      if (hasExample) {
        const duplicate = await c.env.DB.prepare(
          `SELECT id, image_key FROM word_examples
           WHERE word_id = ? AND source_text = ? AND translated_text = ?
           LIMIT 1`,
        )
          .bind(existing.id, sourceText, translatedText)
          .first<{ id: string; image_key: string | null }>();

        if (duplicate) {
          if (imageKey && !duplicate.image_key) {
            await c.env.DB.prepare("UPDATE word_examples SET image_key = ? WHERE id = ?")
              .bind(imageKey, duplicate.id)
              .run();
          } else if (origin === "manual" && existing.meaning.trim() === body.meaning.trim()) {
            throw new ApiError(409, "DUPLICATE_WORD", "同じ単語・意味が既に登録されています。");
          }
        } else {
          await c.env.DB.prepare(
            `INSERT INTO word_examples
             (id, word_id, translation_id, source_text, translated_text, context_meaning,
              grammar_note, image_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              crypto.randomUUID(),
              existing.id,
              body.translationId ?? null,
              sourceText,
              translatedText,
              body.contextMeaning || null,
              body.grammarNote || null,
              imageKey,
              now,
            )
            .run();
          addedExample = true;
        }
      }

      if (body.translationId && imageKey) {
        await c.env.DB.prepare(
          "UPDATE translations SET image_key = ? WHERE id = ? AND (image_key IS NULL OR image_key = ?)",
        )
          .bind(imageKey, body.translationId, imageKey)
          .run();
      }
      await c.env.DB.prepare("UPDATE words SET updated_at = ? WHERE id = ?")
        .bind(now, existing.id)
        .run();
      const word = await getWord(c.env.DB, existing.id);
      return c.json({ word, merged: true, addedExample, imageKey });
    }

    const wordId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO words
         (id, term, normalized_term, base_form, part_of_speech, meaning, source_lang, target_lang,
          origin, review_count, known_count, recall_count, mastered, next_review_at, last_reviewed_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
      ).bind(
        wordId,
        body.term,
        normalized,
        body.baseForm || body.term,
        body.partOfSpeech || null,
        body.meaning,
        body.sourceLang,
        body.targetLang,
        origin,
        now,
        now,
      ),
    ];

    if (hasExample) {
      const exampleId = crypto.randomUUID();
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO word_examples
           (id, word_id, translation_id, source_text, translated_text, context_meaning,
            grammar_note, image_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          exampleId,
          wordId,
          body.translationId ?? null,
          sourceText,
          translatedText,
          body.contextMeaning || null,
          body.grammarNote || null,
          imageKey,
          now,
        ),
      );
    }

    if (body.translationId && imageKey) {
      statements.push(
        c.env.DB.prepare(
          "UPDATE translations SET image_key = ? WHERE id = ? AND (image_key IS NULL OR image_key = ?)",
        ).bind(imageKey, body.translationId, imageKey),
      );
    }
    await c.env.DB.batch(statements);
    const word = await getWord(c.env.DB, wordId);
    return c.json({ word, merged: false, addedExample: hasExample, imageKey });
  } catch (error) {
    if (imageKey) await releaseImageIfUnused(c.env, imageKey);
    throw error;
  }
});

wordRoutes.get("/words/:id", async (c) => {
  const word = await getWord(c.env.DB, c.req.param("id"));
  if (!word) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  return c.json({ word });
});

wordRoutes.patch("/words/:id", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const id = c.req.param("id");
  const body = await parseBody(c, wordUpdateSchema);
  const current = await getWord(c.env.DB, id);
  if (!current) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  const term = body.term ?? current.term;
  const normalized = normalizeTerm(body.baseForm ?? current.baseForm ?? term) || normalizeTerm(term);
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `UPDATE words SET term = ?, normalized_term = ?, base_form = ?, part_of_speech = ?,
       meaning = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        term,
        normalized,
        body.baseForm ?? current.baseForm ?? term,
        body.partOfSpeech ?? current.partOfSpeech ?? null,
        body.meaning ?? current.meaning,
        now,
        id,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("unique")) {
      throw new ApiError(
        409,
        "DUPLICATE_WORD",
        "同じ単語が既に登録されています。統合する場合は既存カードに用例を追加してください。",
      );
    }
    throw error;
  }

  if (body.sourceText !== undefined || body.translatedText !== undefined) {
    const primaryExample = (current.examples ?? [])[0] ?? null;
    const nextSource =
      body.sourceText !== undefined
        ? body.sourceText.trim()
        : (primaryExample?.sourceText ?? "");
    const nextTranslation =
      body.translatedText !== undefined
        ? body.translatedText.trim()
        : (primaryExample?.translatedText ?? "");

    if (nextSource) {
      if (primaryExample) {
        await c.env.DB.prepare(
          `UPDATE word_examples SET source_text = ?, translated_text = ? WHERE id = ?`,
        )
          .bind(nextSource, nextTranslation, primaryExample.id)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO word_examples
           (id, word_id, translation_id, source_text, translated_text, context_meaning,
            grammar_note, image_key, created_at)
           VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, ?)`,
        )
          .bind(crypto.randomUUID(), id, nextSource, nextTranslation, now)
          .run();
      }
      await c.env.DB.prepare("UPDATE words SET cloze_options_json = NULL WHERE id = ?")
        .bind(id)
        .run();
    } else if (primaryExample && !primaryExample.imageKey && !primaryExample.translationId) {
      await c.env.DB.prepare("DELETE FROM word_examples WHERE id = ?")
        .bind(primaryExample.id)
        .run();
    }
  }

  return c.json({ word: await getWord(c.env.DB, id) });
});

wordRoutes.post("/words/:id/examples", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const id = c.req.param("id");
  const word = await getWord(c.env.DB, id);
  if (!word) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  const { learnerLevel } = await parseBody(c, wordExamplesRequestSchema);


  const { value, cached } = await runJsonModel(c.env, {
    kind: "examples",
    system: ALT_EXAMPLES_SYSTEM,
    user: altExamplesUser({
      term: word.term,
      meaning: word.meaning,
      existingSources: (word.examples ?? []).map((e) => e.sourceText),
      sourceLang: word.sourceLang,
      targetLang: word.targetLang,
      learnerLevel,
    }),
    schema: wordExamplesResultSchema,
    maxTokens: 900,
    temperature: 0.3,
    cacheTtlMs: 14 * 24 * 60 * 60 * 1000,
  });

  return c.json({
    examples: value.examples.filter((e) => e.sourceText.trim() && e.translatedText.trim()),
    cached,
  });
});

wordRoutes.delete("/words/:id", async (c) => {
  const id = c.req.param("id");
  const word = await getWord(c.env.DB, id);
  if (!word) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  const imageKeys = [...new Set((word.examples ?? []).map((e) => e.imageKey).filter(Boolean))] as string[];
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM review_events WHERE word_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM word_examples WHERE word_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM words WHERE id = ?").bind(id),
  ]);
  for (const key of imageKeys) await releaseImageIfUnused(c.env, key);
  return c.json({ ok: true });
});

// Starts both learning tracks over: the word becomes due again and is no
// longer mastered. Review history is kept for the record.
wordRoutes.post("/words/:id/reset-progress", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const id = c.req.param("id");
  const word = await getWord(c.env.DB, id);
  if (!word) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  await c.env.DB.prepare(
    `UPDATE words SET review_count = 0, known_count = 0, recall_count = 0,
       known_reviewed_day = NULL, recall_reviewed_day = NULL,
       mastered = 0, next_review_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(Date.now(), id)
    .run();
  return c.json({ word: await getWord(c.env.DB, id) });
});

wordRoutes.post("/words/:id/review", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const id = c.req.param("id");
  const body = await parseBody(c, reviewRatingSchema);
  const word = await getWord(c.env.DB, id);
  if (!word) throw new ApiError(404, "NOT_FOUND", "単語が見つかりません。");
  const settings = await ensureSettings(c.env.DB);
  const now = Date.now();

  const requestId = body.requestId ?? crypto.randomUUID();
  const prior = await c.env.DB.prepare("SELECT word_id FROM review_events WHERE id = ?").bind(requestId).first<{word_id: string}>();
  if (prior && prior.word_id !== id) throw new ApiError(409, "REQUEST_CONFLICT", "復習の送信IDが一致しません。");
  const receipt = await recordReview(c.env.DB, {
    wordId: id, requestId, mode: body.mode, rating: body.rating, assisted: body.assisted,
    retry: body.retry, targetCount: settings.reviewTargetCount, intervalDays: settings.reviewIntervalDays, now,
  });
  const updated = (await getWord(c.env.DB, id)) ?? word;
  return c.json({
    word: updated, nextReviewAt: updated.nextReviewAt, mastered: updated.mastered,
    reviewCount: updated.reviewCount, knownCount: updated.knownCount, recallCount: updated.recallCount,
    gained: receipt.gained, sameDaySkipped: body.rating === "known" && !receipt.gained,
  });
});

wordRoutes.get("/review/queue", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const settings = await ensureSettings(c.env.DB);
  const requested = Number(c.req.query("limit") ?? settings.reviewBatchSize) || settings.reviewBatchSize;
  const limit = Math.min(100, Math.max(1, requested));
  const scope = c.req.query("scope") === "all" ? "all" : "due";
  const words = await getWordsForReview(c.env.DB, {
    limit,
    order: settings.reviewOrder,
    scope,
  });
  if (!words.length) return c.json({ items: [], settings });

  const placeholders = words.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT * FROM word_examples WHERE word_id IN (${placeholders}) ORDER BY created_at DESC`,
  )
    .bind(...words.map((w) => w.id))
    .all<Record<string, unknown>>();
  const byWord = new Map<string, ReturnType<typeof mapExample>[]>();
  for (const row of rows.results ?? []) {
    const example = mapExample(row);
    const list = byWord.get(example.wordId) ?? [];
    list.push(example);
    byWord.set(example.wordId, list);
  }
  return c.json({
    items: words.map((word) => {
      const examples = byWord.get(word.id) ?? [];
      // Use the same latest-text example as /review/cloze.
      const example = examples.find((entry) => entry.sourceText.trim()) ?? examples[0] ?? null;
      return {
        word: {
          ...word,
          imageKey: example?.imageKey ?? word.imageKey ?? null,
          exampleSource: example?.sourceText ?? word.exampleSource ?? null,
          exampleTranslation: example?.translatedText ?? word.exampleTranslation ?? null,
          exampleContext: example?.contextMeaning ?? word.exampleContext ?? null,
          exampleGrammarNote: example?.grammarNote ?? word.exampleGrammarNote ?? null,
        },
        example,
      };
    }),
    settings,
  });
});

wordRoutes.post("/review/cloze", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const body = await parseBody(c, clozeBatchRequestSchema);
  const ids = [...new Set(body.wordIds)];
  const resultMap: Record<string, ClozeOptionSet> = {};
  const pending: Array<{ id: string; term: string; surface: string; meaning: string; source: string }> = [];

  for (const id of ids) {
    const word = await getWord(c.env.DB, id);
    if (!word) continue;
    const primaryExample = (word.examples ?? []).find((e) => e.sourceText.trim()) ?? null;
    const sourceText = (primaryExample?.sourceText ?? word.exampleSource ?? "").trim();
    if (!sourceText) continue;

    const ranges = findTermRanges(sourceText, word.term);
    const surface = ranges.length
      ? sourceText.slice(ranges[0].start, ranges[0].end)
      : word.term;

    if (
      word.clozeOptions &&
      word.clozeOptions.sourceText === sourceText &&
      word.clozeOptions.choices.length === 4 &&
      word.clozeOptions.choices.some((ch) => normalizeTerm(ch) === normalizeTerm(surface))
    ) {
      resultMap[word.id] = word.clozeOptions;
      continue;
    }

    pending.push({
      id: word.id,
      term: word.term,
      surface,
      meaning: word.meaning,
      source: sourceText,
    });
  }

  let cached = true;
  if (pending.length > 0) {
    const aiRes = await runJsonModel(c.env, {
      kind: "cloze",
      system: CLOZE_BATCH_SYSTEM,
      user: clozeBatchUser({
        items: pending,
        learnerLevel: body.learnerLevel,
      }),
      schema: clozeBatchResultSchema,
      maxTokens: 2400 + pending.length * 80,
      temperature: 0.25,
      cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    cached = aiRes.cached;

    const now = Date.now();
    for (const item of pending) {
      const returned = aiRes.value.items.find((r) => r.id === item.id);
      const rawChoices = returned?.choices ?? [];
      const unique: string[] = [item.surface];
      const seen = new Set<string>([normalizeTerm(item.surface)]);
      for (const ch of rawChoices) {
        const trimmed = ch.trim();
        const norm = normalizeTerm(trimmed);
        if (trimmed && norm && !seen.has(norm)) {
          seen.add(norm);
          unique.push(trimmed);
        }
        if (unique.length >= 4) break;
      }
      if (unique.length === 4) {
        const optionSet: ClozeOptionSet = {
          sourceText: item.source,
          surface: item.surface,
          choices: unique,
          updatedAt: now,
        };
        resultMap[item.id] = optionSet;
        await c.env.DB.prepare("UPDATE words SET cloze_options_json = ? WHERE id = ?")
          .bind(JSON.stringify(optionSet), item.id)
          .run();
      }
    }
  }

  return c.json({ items: resultMap, cached });
});

/**
 * Regular inflections of the term's first word (reimburse → reimbursed,
 * apply → applies), which the dictionary of known irregular forms lacks.
 */
function findInflected(text: string, term: string): { start: number; end: number } | undefined {
  const [head, ...rest] = term.trim().split(/\s+/);
  if (!head || head.length < 3) return undefined;
  const stem = head.replace(/(e|y)$/i, "");
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = rest.length ? "\\s+" + rest.map(escape).join("\\s+") : "";
  const match = new RegExp(`\\b${escape(stem)}[a-z]{0,4}${tail}\\b`, "i").exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

wordRoutes.post("/review/ai-plan", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const body = await parseBody(c, aiQuizBatchRequestSchema);

  const rows = await c.env.DB.prepare(
    `SELECT term, normalized_term, base_form, meaning, review_count, known_count, recall_count, mastered
     FROM words ORDER BY created_at DESC`,
  ).all<Record<string, unknown>>();
  const allWords = (rows.results ?? []).map((row) => ({
    term: String(row.term ?? ""),
    normalizedTerm: String(row.normalized_term ?? ""),
    baseForm: row.base_form ? String(row.base_form) : null,
    meaning: String(row.meaning ?? ""),
    reviewCount: Number(row.review_count ?? 0),
    knownCount: Number(row.known_count ?? row.review_count ?? 0),
    recallCount: Number(row.recall_count ?? 0),
    mastered: Boolean(row.mastered),
  }));
  const existing = new Set<string>();
  for (const word of allWords) {
    for (const t of [word.term, word.normalizedTerm, word.baseForm ?? ""]) {
      const norm = normalizeTerm(t);
      if (norm) existing.add(norm);
    }
  }
  for (const t of body.excludeTerms) {
    const norm = normalizeTerm(t);
    if (norm) existing.add(norm);
  }

  // Spare items cover ones the checks below reject (too easy, ambiguous, known).
  const minCefr = learnerLevelInfo(body.learnerLevel).minCefr;
  const { value } = await runJsonModel(c.env, {
    kind: "quiz-plan",
    system: QUIZ_PLAN_SYSTEM,
    user: quizPlanUser({
      candidateCount: body.count + 4,
      learnerLevel: body.learnerLevel,
      referenceProfile: selectReferenceProfile(allWords, 10),
      // A random theme varies the vocabulary and makes every request unique,
      // so a cached plan is never replayed.
      theme: QUIZ_THEMES[Math.floor(Math.random() * QUIZ_THEMES.length)],
      avoid: body.excludeTerms,
    }),
    schema: aiQuizPlanResultSchema,
    maxTokens: 300 + (body.count + 4) * 115,
    temperature: 0.8,
    cacheTtlMs: 60 * 1000,
  });

  const items: QuizPlanItem[] = [];
  for (const raw of value.items) {
    const item = validateQuizPlanItem(raw, `q${items.length + 1}`, existing, minCefr);
    if (!item) continue;
    existing.add(normalizeTerm(item.term));
    items.push(item);
  }
  if (!items.length) {
    throw new ApiError(502, "QUIZ_PLAN_EMPTY", "紛らわしくない問題を作れませんでした。もう一度お試しください。");
  }
  // Cloze keeps the spares: sentences that fail the critic are dropped later.
  return c.json({ items: body.mode === "cloze" ? items : items.slice(0, body.count) });
});

wordRoutes.post("/review/ai-examples", async (c) => {
  const body = await parseBody(c, aiQuizExamplesRequestSchema);
  const cloze = body.mode === "cloze";
  const { value } = await runJsonModel(c.env, {
    kind: "quiz-examples",
    system: QUIZ_EXAMPLES_SYSTEM,
    user: quizExamplesUser({
      cloze,
      learnerLevel: body.learnerLevel,
      items: body.items.map((item) => ({ id: item.id, term: item.term, distractors: item.distractors })),
    }),
    schema: aiQuizExamplesResultSchema,
    // A generous cap: Japanese translations are token-heavy, and a truncated
    // reply cannot be parsed at all. Only tokens actually written are billed.
    maxTokens: 400 + body.items.length * (cloze ? 320 : 260),
    temperature: 0.3,
    cacheTtlMs: 10 * 60 * 1000,
  });

  const examples: AiQuizExample[] = [];
  for (const item of body.items) {
    // Models sometimes renumber ids; fall back to the item's position.
    const raw =
      value.items.find((entry) => entry.id === item.id) ??
      (value.items.length === body.items.length ? value.items[body.items.indexOf(item)] : undefined);
    if (!raw) {
      console.warn("quiz example missing", { term: item.term });
      continue;
    }
    // Models sometimes put the whole sentence in "surface" and leave "source" empty.
    const misplaced = !raw.source.trim() && /\s/.test(raw.surface.trim()) && raw.surface.trim().length > item.term.length + 8;
    const source = (misplaced ? raw.surface : raw.source).trim();
    if (misplaced) raw.surface = "";
    // Match the term in any inflection and take its spelling from the sentence.
    const range = source
      ? (findTermRanges(source, item.term, raw.surface)[0] ?? findInflected(source, item.term))
      : undefined;
    if (!source || source.includes(";") || !range) {
      console.warn("quiz example rejected", { term: item.term, surface: raw.surface, source });
      continue;
    }
    const surface = source.slice(range.start, range.end);
    if (!cloze) {
      examples.push({ id: item.id, surface, source, translation: raw.translation.trim(), choices: [] });
      continue;
    }
    const check = validateQuizQuestion({
      id: item.id,
      term: item.term,
      meaning: item.meaning || item.term,
      source,
      translation: raw.translation,
      surface,
      choices: raw.choices,
    });
    if (!check.ok || !check.question) {
      console.warn("quiz cloze rejected", { term: item.term, reason: check.reason });
      continue;
    }
    examples.push({
      id: item.id,
      surface: check.question.surface,
      source: check.question.source,
      translation: check.question.translation,
      choices: check.question.choices,
    });
  }

  if (!cloze) return c.json({ items: examples });

  // Cloze sentences must be unambiguous; the critic checks only this chunk.
  const verified = await filterUnambiguousQuestions(
    c.env,
    examples.map((example) => {
      const item = body.items.find((entry) => entry.id === example.id)!;
      return {
        id: example.id,
        term: item.term,
        meaning: item.meaning || item.term,
        source: example.source,
        translation: example.translation,
        surface: example.surface,
        choices: example.choices,
        note: "",
      };
    }),
  );
  const ok = new Set(verified.map((question) => question.id));
  return c.json({ items: examples.filter((example) => ok.has(example.id)) });
});
