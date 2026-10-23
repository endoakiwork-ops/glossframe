import { FREE_DAILY_NEURONS, SPEECH_MODEL_ID, estimateNeurons, quotaDayStart } from "../shared/neurons";
import type {
  AiUsageSummary,
  ClozeOptionSet,
  Settings,
  Stats,
  TranslationRecord,
  WordCard,
  WordExample,
  WordOrigin,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";

type Row = Record<string, unknown>;

const migratedDbs = new WeakSet<object>();

export async function ensureLearningSchema(db: D1Database): Promise<void> {
  if (migratedDbs.has(db as unknown as object)) return;
  // Migrations are applied by the startup/deployment command, never on a read request.
  // Re-running the legacy copy here would incorrectly turn recall progress into comprehension.
  await db.prepare("SELECT known_count, recall_count, origin, known_reviewed_day, recall_reviewed_day, cloze_options_json FROM words LIMIT 0").all();
  migratedDbs.add(db as unknown as object);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : Number(value ?? fallback);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return num(value) !== 0;
}

export function mapSettings(row: Row): Settings {
  return {
    sourceLang: str(row.source_lang, DEFAULT_SETTINGS.sourceLang),
    targetLang: str(row.target_lang, DEFAULT_SETTINGS.targetLang),
    saveImages: bool(row.save_images),
    reviewIntervalDays: num(row.review_interval_days, DEFAULT_SETTINGS.reviewIntervalDays),
    reviewTargetCount: num(row.review_target_count, DEFAULT_SETTINGS.reviewTargetCount),
    reviewBatchSize: num(row.review_batch_size, DEFAULT_SETTINGS.reviewBatchSize),
    reviewShowImage: bool(row.review_show_image),
    reviewOrder: (str(row.review_order, "due") as Settings["reviewOrder"]) || "due",
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

export async function ensureSettings(db: D1Database): Promise<Settings> {
  const existing = await db.prepare("SELECT * FROM settings WHERE id = 1").first<Row>();
  if (existing) return mapSettings(existing);
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO settings
       (id, source_lang, target_lang, save_images, review_interval_days, review_target_count,
        review_batch_size, review_show_image, review_order, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      DEFAULT_SETTINGS.sourceLang,
      DEFAULT_SETTINGS.targetLang,
      1,
      DEFAULT_SETTINGS.reviewIntervalDays,
      DEFAULT_SETTINGS.reviewTargetCount,
      DEFAULT_SETTINGS.reviewBatchSize,
      1,
      DEFAULT_SETTINGS.reviewOrder,
      now,
      now,
    )
    .run();
  const row = await db.prepare("SELECT * FROM settings WHERE id = 1").first<Row>();
  return mapSettings(row ?? {});
}

export function mapTranslation(row: Row): TranslationRecord {
  const parseArray = (value: unknown) => {
    try {
      const parsed = JSON.parse(str(value, "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: str(row.id),
    sourceText: str(row.source_text),
    translatedText: str(row.translated_text),
    sourceLang: str(row.source_lang),
    targetLang: str(row.target_lang),
    segments: parseArray(row.segments_json),
    grammarNotes: parseArray(row.grammar_notes_json),
    keyPhrases: parseArray(row.key_phrases_json),
    imageKey: row.image_key ? str(row.image_key) : null,
    createdAt: num(row.created_at),
    hasImage: Boolean(row.image_key),
  } as TranslationRecord;
}

function parseClozeOptions(value: unknown): ClozeOptionSet | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.sourceText === "string" &&
      typeof parsed.surface === "string" &&
      Array.isArray(parsed.choices) &&
      parsed.choices.length === 4
    ) {
      return {
        sourceText: parsed.sourceText,
        surface: parsed.surface,
        choices: parsed.choices.map((c) => String(c)),
        updatedAt: num(parsed.updatedAt),
      };
    }
  } catch {
    // ignore invalid json
  }
  return null;
}

export function mapWord(row: Row): WordCard {
  const reviewCount = num(row.review_count);
  const knownCount = row.known_count != null ? num(row.known_count) : reviewCount;
  const recallCount = row.recall_count != null ? num(row.recall_count) : 0;
  const rawOrigin = str(row.origin, "translation");
  const origin: WordOrigin =
    rawOrigin === "manual" || rawOrigin === "ai" ? rawOrigin : "translation";

  return {
    id: str(row.id),
    term: str(row.term),
    normalizedTerm: str(row.normalized_term),
    baseForm: row.base_form ? str(row.base_form) : null,
    partOfSpeech: row.part_of_speech ? str(row.part_of_speech) : null,
    meaning: str(row.meaning),
    sourceLang: str(row.source_lang),
    targetLang: str(row.target_lang),
    origin,
    reviewCount,
    knownCount,
    recallCount,
    knownReviewedDay: row.known_reviewed_day ? str(row.known_reviewed_day) : null,
    recallReviewedDay: row.recall_reviewed_day ? str(row.recall_reviewed_day) : null,
    clozeOptions: parseClozeOptions(row.cloze_options_json),
    mastered: bool(row.mastered),
    nextReviewAt: row.next_review_at == null ? null : num(row.next_review_at),
    lastReviewedAt: row.last_reviewed_at == null ? null : num(row.last_reviewed_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    exampleCount: row.example_count == null ? undefined : num(row.example_count),
    imageKey: row.first_image_key ? str(row.first_image_key) : null,
    exampleSource: row.first_source_text ? str(row.first_source_text) : null,
    exampleTranslation: row.first_translated_text ? str(row.first_translated_text) : null,
    exampleContext: row.first_context_meaning ? str(row.first_context_meaning) : null,
    exampleGrammarNote: row.first_grammar_note ? str(row.first_grammar_note) : null,
    examples: undefined,
  };
}

export function mapExample(row: Row): WordExample {
  return {
    id: str(row.id),
    wordId: str(row.word_id),
    translationId: row.translation_id ? str(row.translation_id) : null,
    sourceText: str(row.source_text),
    translatedText: str(row.translated_text),
    contextMeaning: row.context_meaning ? str(row.context_meaning) : null,
    grammarNote: row.grammar_note ? str(row.grammar_note) : null,
    imageKey: row.image_key ? str(row.image_key) : null,
    createdAt: num(row.created_at),
  };
}

export async function listExamples(db: D1Database, wordId: string): Promise<WordExample[]> {
  const result = await db
    .prepare("SELECT * FROM word_examples WHERE word_id = ? ORDER BY created_at DESC")
    .bind(wordId)
    .all<Row>();
  return (result.results ?? []).map(mapExample);
}

export async function getWord(db: D1Database, id: string): Promise<WordCard | null> {
  await ensureLearningSchema(db);
  const row = await db.prepare("SELECT * FROM words WHERE id = ?").bind(id).first<Row>();
  if (!row) return null;
  const word = mapWord(row);
  word.examples = await listExamples(db, id);
  return word;
}

export async function getWordByTerm(
  db: D1Database,
  normalized: string,
  sourceLang: string,
  targetLang: string,
): Promise<WordCard | null> {
  await ensureLearningSchema(db);
  const row = await db
    .prepare(
      "SELECT * FROM words WHERE normalized_term = ? AND source_lang = ? AND target_lang = ?",
    )
    .bind(normalized, sourceLang, targetLang)
    .first<Row>();
  return row ? mapWord(row) : null;
}

export async function listWords(
  db: D1Database,
  params: { filter: string; q: string; sort: string; limit: number; offset: number },
): Promise<{ words: WordCard[]; total: number }> {
  await ensureLearningSchema(db);
  const now = Date.now();
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.filter === "due") {
    where.push("mastered = 0 AND (next_review_at IS NULL OR next_review_at <= ?)");
    values.push(now);
  } else if (params.filter === "waiting") {
    where.push("mastered = 0 AND next_review_at IS NOT NULL AND next_review_at > ?");
    values.push(now);
  } else if (params.filter === "mastered") {
    where.push("mastered = 1");
  }
  if (params.q.trim()) {
    const like = `%${params.q.trim().replace(/[%_]/g, "")}%`;
    where.push("(term LIKE ? OR meaning LIKE ? OR coalesce(base_form,'') LIKE ?)");
    values.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql =
    params.sort === "term"
      ? "ORDER BY term COLLATE NOCASE ASC"
      : params.sort === "due"
        ? "ORDER BY (next_review_at IS NULL) ASC, next_review_at ASC, created_at DESC"
        : params.sort === "progress"
          ? "ORDER BY (coalesce(known_count, review_count) + coalesce(recall_count, 0)) DESC, created_at DESC"
          : "ORDER BY created_at DESC";
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM words ${whereSql}`)
    .bind(...values)
    .first<Row>();
  const rows = await db
    .prepare(
      `SELECT w.*,
        (SELECT COUNT(*) FROM word_examples e WHERE e.word_id = w.id) AS example_count,
        (SELECT image_key FROM word_examples e
          WHERE e.word_id = w.id AND e.image_key IS NOT NULL
          ORDER BY e.created_at DESC LIMIT 1) AS first_image_key,
        (SELECT source_text FROM word_examples e
          WHERE e.word_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS first_source_text,
        (SELECT translated_text FROM word_examples e
          WHERE e.word_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS first_translated_text,
        (SELECT context_meaning FROM word_examples e
          WHERE e.word_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS first_context_meaning,
        (SELECT grammar_note FROM word_examples e
          WHERE e.word_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS first_grammar_note
       FROM words w ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset)
    .all<Row>();
  return {
    words: (rows.results ?? []).map(mapWord),
    total: num(countRow?.c),
  };
}

export async function getDueWords(
  db: D1Database,
  limit: number,
  order: Settings["reviewOrder"],
): Promise<WordCard[]> {
  return getWordsForReview(db, { limit, order, scope: "due" });
}

export async function getWordsForReview(
  db: D1Database,
  params: {
    limit: number;
    order: Settings["reviewOrder"];
    scope?: "due" | "all";
  },
): Promise<WordCard[]> {
  await ensureLearningSchema(db);
  const now = Date.now();
  const scope = params.scope === "all" ? "all" : "due";
  const orderSql =
    params.order === "random"
      ? "ORDER BY RANDOM()"
      : params.order === "created"
        ? "ORDER BY created_at ASC"
        : scope === "all"
          ? "ORDER BY mastered ASC, (next_review_at IS NULL) DESC, next_review_at ASC, created_at ASC"
          : "ORDER BY (next_review_at IS NULL) DESC, next_review_at ASC, created_at ASC";
  if (scope === "all") {
    const rows = await db
      .prepare(`SELECT * FROM words ${orderSql} LIMIT ?`)
      .bind(params.limit)
      .all<Row>();
    return (rows.results ?? []).map(mapWord);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM words
       WHERE mastered = 0 AND (next_review_at IS NULL OR next_review_at <= ?)
       ${orderSql} LIMIT ?`,
    )
    .bind(now, params.limit)
    .all<Row>();
  return (rows.results ?? []).map(mapWord);
}

export async function getAiUsage(db: D1Database, now = Date.now()): Promise<AiUsageSummary> {
  // Count from the free-quota reset (00:00 UTC = 09:00 JST) so the Neuron total
  // lines up with what Cloudflare compares against the 10,000 daily allocation.
  const startMs = quotaDayStart(now);
  const rows = await db
    .prepare(
      `SELECT kind, model, COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(neurons) AS neurons,
              SUM(CASE WHEN neurons > 0 THEN 0 ELSE input_tokens END) AS unmeasured_input,
              SUM(CASE WHEN neurons > 0 THEN 0 ELSE output_tokens END) AS unmeasured_output
       FROM ai_usage WHERE created_at >= ? GROUP BY kind, model`,
    )
    .bind(startMs)
    .all<Row>();
  const kinds = new Map<string, AiUsageSummary["byKind"][number]>();
  const models = new Map<string, AiUsageSummary["byModel"][number]>();
  for (const r of rows.results ?? []) {
    const kind = str(r.kind);
    const model = str(r.model);
    const inputTokens = num(r.input_tokens);
    const outputTokens = num(r.output_tokens);
    const item = kinds.get(kind) ?? { kind, requests: 0, inputTokens: 0, outputTokens: 0, neurons: 0 };
    item.requests += num(r.requests);
    // Speech rows hold character counts, not tokens.
    if (str(r.model) !== SPEECH_MODEL_ID) {
      item.inputTokens += inputTokens;
      item.outputTokens += outputTokens;
    }
    // Prefer the Neurons Workers AI reported; estimate only rows without them.
    const neurons =
      num(r.neurons) + estimateNeurons(model, num(r.unmeasured_input), num(r.unmeasured_output));
    item.neurons += neurons;
    kinds.set(kind, item);
    const byModel = models.get(model) ?? { model, requests: 0, neurons: 0 };
    byModel.requests += num(r.requests);
    byModel.neurons += neurons;
    models.set(model, byModel);
  }
  const byKind = [...kinds.values()];
  return {
    date: new Date(startMs).toISOString().slice(0, 10),
    requests: byKind.reduce((a, b) => a + b.requests, 0),
    inputTokens: byKind.reduce((a, b) => a + b.inputTokens, 0),
    outputTokens: byKind.reduce((a, b) => a + b.outputTokens, 0),
    neurons: byKind.reduce((a, b) => a + b.neurons, 0),
    neuronLimit: FREE_DAILY_NEURONS,
    account: null,
    byKind,
    byModel: [...models.values()].filter((row) => row.model !== "cache"),
  };
}

export async function getStats(db: D1Database): Promise<Stats> {
  const now = Date.now();
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM translations) AS translations,
        (SELECT COUNT(*) FROM words) AS words,
        (SELECT COUNT(*) FROM words WHERE mastered = 0 AND (next_review_at IS NULL OR next_review_at <= ?)) AS due_words,
        (SELECT COUNT(*) FROM words WHERE mastered = 1) AS mastered_words,
        (SELECT COUNT(*) FROM images) AS images,
        (SELECT COALESCE(SUM(size),0) FROM images) AS image_bytes`,
    )
    .bind(now)
    .first<Row>();
  return {
    translations: num(counts?.translations),
    words: num(counts?.words),
    dueWords: num(counts?.due_words),
    masteredWords: num(counts?.mastered_words),
    images: num(counts?.images),
    imageBytes: num(counts?.image_bytes),
    ai: await getAiUsage(db, now),
  };
}

export async function recordUsage(
  db: D1Database,
  params: {
    kind: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** Measured Neurons; leave 0 to have the summary estimate from tokens. */
    neurons?: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_usage (id, kind, model, input_tokens, output_tokens, created_at, neurons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      params.kind,
      params.model,
      Math.max(0, Math.round(params.inputTokens)),
      Math.max(0, Math.round(params.outputTokens)),
      Date.now(),
      Math.max(0, params.neurons ?? 0),
    )
    .run();
}

export async function cleanupExpired(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM ai_cache WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM auth_attempts WHERE created_at < ?").bind(now - 24 * 60 * 60 * 1000),
  ]);
}
