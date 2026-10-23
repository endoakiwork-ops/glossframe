import { Hono } from "hono";
import type { AppEnv } from "../env";
import { parseBody } from "../validate";
import { backupSchema } from "../../shared/schemas";
import { ensureLearningSchema, ensureSettings, mapExample, mapTranslation, mapWord } from "../db";
import { storeImage } from "../images";
import { normalizeTerm } from "../../shared/srs";
import { sha256Hex } from "../../shared/text";
import type { ClozeOptionSet } from "../../shared/types";
import type { TranslationRegion } from "../../shared/translation-regions";
import { ApiError } from "../errors";
import { translationRegionsSchema } from "./regions";

export const backupRoutes = new Hono<AppEnv>();

// The whole backup is one JSON response, so base64 images multiply memory use.
// Keep a conservative ceiling and let callers opt out with includeImages=false.
const MAX_BACKUP_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REGIONS_PER_TRANSLATION = 100;

function finiteCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseClozeOptions(raw: unknown): ClozeOptionSet | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const sourceText = typeof item.sourceText === "string" ? item.sourceText.trim() : "";
  const surface = typeof item.surface === "string" ? item.surface.trim() : "";
  if (!sourceText || !surface || !sourceText.includes(surface)) return null;
  if (!Array.isArray(item.choices) || item.choices.length !== 4) return null;
  const choices = item.choices.map((choice) =>
    typeof choice === "string" ? choice.trim() : "",
  );
  if (choices.some((choice) => !choice)) return null;
  const normalized = choices.map(normalizeTerm);
  if (normalized.some((choice) => !choice)) return null;
  if (new Set(normalized).size !== 4) return null;
  if (!normalized.includes(normalizeTerm(surface))) return null;

  const options: ClozeOptionSet = { sourceText, surface, choices };
  const updatedAt = Number(item.updatedAt);
  if (Number.isFinite(updatedAt)) options.updatedAt = updatedAt;
  return options;
}

function parseBackupRegions(raw: unknown, sourceText: string): TranslationRegion[] {
  if (!Array.isArray(raw)) return [];
  const regions: TranslationRegion[] = [];
  const ids = new Set<string>();
  for (const candidate of raw.slice(0, 1000)) {
    const parsed = translationRegionsSchema.safeParse({ regions: [candidate] });
    if (!parsed.success) continue;
    const region = parsed.data.regions[0];
    if (!region) continue;
    // Regions are positioned over the translation's source text. A stale or
    // hand-edited backup must not attach an overlay to different copy.
    if (ids.has(region.id) || !sourceText.includes(region.source)) continue;
    ids.add(region.id);
    regions.push(region);
    if (regions.length >= MAX_REGIONS_PER_TRANSLATION) break;
  }
  return regions;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const raw = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

backupRoutes.get("/backup", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const settings = await ensureSettings(c.env.DB);
  const includeImages = c.req.query("includeImages") !== "false" && c.req.query("includeImages") !== "0";
  const imageSize = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS bytes FROM images",
  ).first<{ bytes: number }>();
  const totalImageBytes = finiteCount(imageSize?.bytes);
  if (includeImages && totalImageBytes > MAX_BACKUP_IMAGE_BYTES) {
    const megabytes = (totalImageBytes / (1024 * 1024)).toFixed(1);
    throw new ApiError(
      413,
      "BACKUP_TOO_LARGE",
      `画像を含むバックアップは約${megabytes}MBで上限20MBを超えます。画像なしで書き出すには includeImages=false を指定してください。`,
      {
        imageBytes: totalImageBytes,
        limitBytes: MAX_BACKUP_IMAGE_BYTES,
        retryWith: "includeImages=false",
      },
    );
  }

  const translationRows = await c.env.DB.prepare("SELECT * FROM translations ORDER BY created_at")
    .all<Record<string, unknown>>();
  const wordRows = await c.env.DB.prepare("SELECT * FROM words ORDER BY created_at").all<
    Record<string, unknown>
  >();
  const exampleRows = await c.env.DB.prepare("SELECT * FROM word_examples ORDER BY created_at").all<
    Record<string, unknown>
  >();
  const reviewRows = await c.env.DB.prepare("SELECT * FROM review_events ORDER BY reviewed_at").all<
    Record<string, unknown>
  >();
  const regionRows = await c.env.DB.prepare(
    "SELECT translation_id, regions_json FROM translation_regions",
  ).all<Record<string, unknown>>();

  const regionsByTranslation = new Map<string, unknown[]>();
  for (const row of regionRows.results ?? []) {
    const translationId = String(row.translation_id ?? "");
    if (!translationId || typeof row.regions_json !== "string") continue;
    try {
      const parsed = JSON.parse(row.regions_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        regionsByTranslation.set(translationId, parsed);
      }
    } catch {
      // A corrupt cache is omitted; the translation itself is still exported.
    }
  }

  let imageRows: Array<Record<string, unknown>> = [];
  if (includeImages) {
    const result = await c.env.DB.prepare("SELECT * FROM images ORDER BY created_at").all<
      Record<string, unknown>
    >();
    imageRows = result.results ?? [];
  }

  const images: Array<{ key: string; contentType: string; dataBase64: string }> = [];
  for (const row of imageRows) {
    const key = String(row.key ?? "");
    if (!key) continue;
    const bytes = await c.env.IMAGES.get(`img:${key}`, { type: "arrayBuffer" });
    if (!bytes) continue;
    images.push({
      key,
      contentType: String(row.content_type ?? "image/webp"),
      dataBase64: bytesToBase64(new Uint8Array(bytes)),
    });
  }

  const payload = {
    format: "glossframe-backup" as const,
    version: 1 as const,
    exportedAt: Date.now(),
    settings,
    translations: (translationRows.results ?? []).map((row) => {
      const translation = mapTranslation(row);
      const regions = regionsByTranslation.get(translation.id);
      return regions ? { ...translation, regions } : translation;
    }),
    words: (wordRows.results ?? []).map((row) => {
      const word = mapWord(row);
      // mapWord exposes a UI-friendly fallback; a backup must retain the raw
      // comprehension count so restore never merges recall into comprehension.
      const knownCount =
        row.known_count == null ? finiteCount(row.review_count) : finiteCount(row.known_count);
      return { ...word, knownCount, examples: [] };
    }),
    examples: (exampleRows.results ?? []).map(mapExample),
    reviewEvents: (reviewRows.results ?? []).map((row) => ({
      id: String(row.id),
      wordId: String(row.word_id),
      rating: String(row.rating) as "known" | "unknown",
      mode:
        row.mode === "cloze" || row.mode === "recall" ? (row.mode as "cloze" | "recall") : "card",
      assisted: flag(row.assisted),
      gained: flag(row.gained),
      reviewCountAfter: Number(row.review_count_after),
      reviewedAt: Number(row.reviewed_at),
      nextReviewAt: row.next_review_at == null ? null : Number(row.next_review_at),
    })),
    images,
  };

  const date = new Date().toISOString().slice(0, 10);
  c.header("content-disposition", `attachment; filename="glossframe-backup-${date}.json"`);
  return c.json(payload);
});

backupRoutes.post("/backup/restore", async (c) => {
  await ensureLearningSchema(c.env.DB);
  const body = await parseBody(c, backupSchema, 80_000_000);
  const now = Date.now();
  const counts = {
    images: 0,
    translations: 0,
    words: 0,
    examples: 0,
    reviewEvents: 0,
    skipped: 0,
  };

  // 1. Images first, so references can be remapped.
  const imageMap = new Map<string, string>();
  for (const image of body.images) {
    try {
      const bytes = base64ToBytes(image.dataBase64);
      if (bytes.byteLength > 8 * 1024 * 1024) continue;
      const hash = await sha256Hex(bytes);
      const stored = await storeImage(c.env, {
        dataBase64: bytesToBase64(bytes),
        contentType: ["image/webp", "image/jpeg", "image/png"].includes(image.contentType)
          ? (image.contentType as "image/webp" | "image/jpeg" | "image/png")
          : "image/webp",
        sha256: hash,
      });
      imageMap.set(image.key, stored.key);
      if (!stored.deduped) counts.images++;
    } catch {
      counts.skipped++;
    }
  }

  // 2. Settings (not credentials).
  const s = body.settings;
  if (s.sourceLang && s.targetLang && s.sourceLang !== s.targetLang) {
    await c.env.DB.prepare(
      `UPDATE settings SET source_lang = ?, target_lang = ?, save_images = ?,
       review_interval_days = ?, review_target_count = ?, review_batch_size = ?,
       review_show_image = ?, review_order = ?, updated_at = ? WHERE id = 1`,
    )
      .bind(
        s.sourceLang,
        s.targetLang,
        s.saveImages ? 1 : 0,
        Math.min(365, Math.max(1, s.reviewIntervalDays || 7)),
        Math.min(10, Math.max(1, s.reviewTargetCount || 3)),
        Math.min(100, Math.max(1, s.reviewBatchSize || 20)),
        s.reviewShowImage ? 1 : 0,
        ["due", "created", "random"].includes(s.reviewOrder) ? s.reviewOrder : "due",
        now,
      )
      .run();
  }

  // 3. Translations.
  for (const raw of body.translations) {
    const t = raw as Record<string, unknown>;
    const id = String(t.id ?? "").slice(0, 80);
    const sourceText = String(t.sourceText ?? "").slice(0, 6000);
    const translatedText = String(t.translatedText ?? "").slice(0, 6000);
    if (!id || !sourceText || !translatedText) {
      counts.skipped++;
      continue;
    }
    const imageKey = t.imageKey ? imageMap.get(String(t.imageKey)) ?? null : null;
    try {
      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO translations
         (id, source_text, translated_text, source_lang, target_lang, segments_json,
          grammar_notes_json, key_phrases_json, image_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          sourceText,
          translatedText,
          String(t.sourceLang ?? "en"),
          String(t.targetLang ?? "ja"),
          JSON.stringify(Array.isArray(t.segments) ? t.segments : []),
          JSON.stringify(Array.isArray(t.grammarNotes) ? t.grammarNotes : []),
          JSON.stringify(Array.isArray(t.keyPhrases) ? t.keyPhrases : []),
          imageKey,
          Number(t.createdAt ?? now),
        )
        .run();
      const changes = Number(result.meta.changes ?? 0);
      counts.translations += changes;
      // Never replace regions on a translation that already exists locally.
      if (changes > 0) {
        const regions = parseBackupRegions(t.regions, sourceText);
        if (regions.length > 0) {
          try {
            await c.env.DB.prepare(
              `INSERT OR IGNORE INTO translation_regions (translation_id, regions_json)
               VALUES (?, ?)`,
            )
              .bind(id, JSON.stringify(regions))
              .run();
          } catch {
            // The translation is already restored; keep it even if the
            // optional overlay cache cannot be written.
          }
        }
      }
    } catch {
      counts.skipped++;
    }
  }

  // 4. Words and examples.
  const wordMap = new Map<string, string>();
  for (const raw of body.words) {
    const w = raw as Record<string, unknown>;
    const oldId = String(w.id ?? "");
    const term = String(w.term ?? "").trim().slice(0, 200);
    const meaning = String(w.meaning ?? "").trim().slice(0, 1000);
    const sourceLang = String(w.sourceLang ?? "en");
    const targetLang = String(w.targetLang ?? "ja");
    if (!oldId || !term || !meaning) {
      counts.skipped++;
      continue;
    }
    const normalized = String(w.normalizedTerm ?? "") || normalizeTerm(term);
    const existing = await c.env.DB.prepare(
      "SELECT id FROM words WHERE normalized_term = ? AND source_lang = ? AND target_lang = ?",
    )
      .bind(normalized, sourceLang, targetLang)
      .first<{ id: string }>();
    if (existing) {
      wordMap.set(oldId, existing.id);
      counts.skipped++;
      continue;
    }
    const id = oldId.slice(0, 80);
    try {
      const reviewCount = finiteCount(w.reviewCount);
      // Comprehension and recall are separate tracks. When knownCount exists it
      // is authoritative, even if it is lower than the legacy review counter;
      // only pre-learning-track backups fall back to reviewCount.
      const knownCount =
        w.knownCount == null ? reviewCount : finiteCount(w.knownCount);
      const recallCount = finiteCount(w.recallCount);
      const clozeOptions = parseClozeOptions(w.clozeOptions);
      const origin = w.origin === "manual" || w.origin === "ai" ? w.origin : "translation";
      await c.env.DB.prepare(
        `INSERT INTO words
         (id, term, normalized_term, base_form, part_of_speech, meaning, source_lang, target_lang,
          origin, review_count, known_count, recall_count, known_reviewed_day, recall_reviewed_day,
          cloze_options_json, mastered, next_review_at, last_reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          term,
          normalized,
          String(w.baseForm ?? term),
          w.partOfSpeech ? String(w.partOfSpeech) : null,
          meaning,
          sourceLang,
          targetLang,
          origin,
          reviewCount,
          knownCount,
          recallCount,
          w.knownReviewedDay ? String(w.knownReviewedDay) : null,
          w.recallReviewedDay ? String(w.recallReviewedDay) : null,
          clozeOptions ? JSON.stringify(clozeOptions) : null,
          w.mastered ? 1 : 0,
          w.nextReviewAt == null ? null : Number(w.nextReviewAt),
          w.lastReviewedAt == null ? null : Number(w.lastReviewedAt),
          Number(w.createdAt ?? now),
          Number(w.updatedAt ?? now),
        )
        .run();
      wordMap.set(oldId, id);
      counts.words++;
    } catch {
      const raced = await c.env.DB.prepare(
        "SELECT id FROM words WHERE normalized_term = ? AND source_lang = ? AND target_lang = ?",
      )
        .bind(normalized, sourceLang, targetLang)
        .first<{ id: string }>();
      if (raced) {
        wordMap.set(oldId, raced.id);
        counts.skipped++;
      }
    }
  }

  for (const raw of body.examples) {
    const e = raw as Record<string, unknown>;
    const oldWordId = String(e.wordId ?? "");
    const wordId = wordMap.get(oldWordId) ?? oldWordId;
    const sourceText = String(e.sourceText ?? "").slice(0, 6000);
    const translatedText = String(e.translatedText ?? "").slice(0, 6000);
    if (!wordId || !sourceText) {
      counts.skipped++;
      continue;
    }
    const word = await c.env.DB.prepare("SELECT id FROM words WHERE id = ?").bind(wordId).first();
    if (!word) {
      counts.skipped++;
      continue;
    }
    const duplicate = await c.env.DB.prepare(
      "SELECT id FROM word_examples WHERE word_id = ? AND source_text = ? AND translated_text = ?",
    )
      .bind(wordId, sourceText, translatedText)
      .first();
    if (duplicate) {
      counts.skipped++;
      continue;
    }
    try {
      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO word_examples
         (id, word_id, translation_id, source_text, translated_text, context_meaning,
          grammar_note, image_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          String(e.id ?? crypto.randomUUID()).slice(0, 80),
          wordId,
          e.translationId ? String(e.translationId) : null,
          sourceText,
          translatedText,
          e.contextMeaning ? String(e.contextMeaning).slice(0, 1000) : null,
          e.grammarNote ? String(e.grammarNote).slice(0, 2000) : null,
          e.imageKey ? imageMap.get(String(e.imageKey)) ?? null : null,
          Number(e.createdAt ?? now),
        )
        .run();
      const changes = Number(result.meta.changes ?? 0);
      if (changes > 0) counts.examples++;
      else counts.skipped++;
    } catch {
      counts.skipped++;
    }
  }

  for (const raw of body.reviewEvents) {
    const r = raw as Record<string, unknown>;
    const wordId = wordMap.get(String(r.wordId ?? "")) ?? String(r.wordId ?? "");
    const exists = await c.env.DB.prepare("SELECT id FROM words WHERE id = ?").bind(wordId).first();
    if (!exists) {
      counts.skipped++;
      continue;
    }
    try {
      const mode =
        r.mode === "cloze" || r.mode === "recall" ? (r.mode as "cloze" | "recall") : "card";
      const assisted = flag(r.assisted);
      const gained = flag(r.gained);
      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO review_events
         (id, word_id, rating, mode, assisted, gained, review_count_after, reviewed_at, next_review_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          String(r.id ?? crypto.randomUUID()).slice(0, 80),
          wordId,
          r.rating === "unknown" ? "unknown" : "known",
          mode,
          assisted ? 1 : 0,
          gained ? 1 : 0,
          Math.max(0, Number(r.reviewCountAfter ?? 0)),
          Number(r.reviewedAt ?? now),
          r.nextReviewAt == null ? null : Number(r.nextReviewAt),
        )
        .run();
      const changes = Number(result.meta.changes ?? 0);
      if (changes > 0) counts.reviewEvents++;
      else counts.skipped++;
    } catch {
      counts.skipped++;
    }
  }

  return c.json({ ok: true, counts });
});

backupRoutes.get("/backup/meta", async (c) => {
  const stats = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM translations) AS translations,
      (SELECT COUNT(*) FROM words) AS words,
      (SELECT COUNT(*) FROM word_examples) AS examples,
      (SELECT COUNT(*) FROM images) AS images,
      (SELECT COALESCE(SUM(size),0) FROM images) AS image_bytes`,
  ).first<Record<string, unknown>>();
  return c.json({
    translations: Number(stats?.translations ?? 0),
    words: Number(stats?.words ?? 0),
    examples: Number(stats?.examples ?? 0),
    images: Number(stats?.images ?? 0),
    imageBytes: Number(stats?.image_bytes ?? 0),
  });
});
