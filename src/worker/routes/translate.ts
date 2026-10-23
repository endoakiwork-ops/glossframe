import { Hono } from "hono";
import type { AppEnv } from "../env";
import { parseBody } from "../validate";
import {
  chatRequestSchema,
  chatResultSchema,
  explainRequestSchema,
  explainResultSchema,
  translateSchema,
  translationResultSchema,
  ttsRequestSchema,
} from "../../shared/schemas";
import { runJsonModel } from "../ai";
import {
  CHAT_SYSTEM,
  EXPLAIN_SYSTEM,
  TRANSLATION_SYSTEM,
  chatUser,
  explainUser,
  translationUser,
} from "../prompts";
import { mapTranslation } from "../db";
import { preserveSourceSegments } from "../../shared/translation-segments";
import { speechRoutes } from "./speech";
import { pruneTranslationHistory } from "../history";
import { releaseImageIfUnused } from "../images";
import { ApiError } from "../errors";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const translateRoutes = new Hono<AppEnv>();

translateRoutes.post("/translate", async (c) => {
  const body = await parseBody(c, translateSchema, 200_000);
  if (body.sourceLang === body.targetLang) {
    throw new ApiError(400, "SAME_LANGUAGE", "翻訳元と翻訳先に同じ言語が選ばれています。");
  }

  const { value, cached } = await runJsonModel(c.env, {
    kind: "translate",
    system: TRANSLATION_SYSTEM,
    user: translationUser(body),
    schema: translationResultSchema,
    maxTokens: Math.min(6000, 1800 + Math.ceil(body.text.length * 1.2)),
    temperature: 0.15,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  });

  const sourceText = body.text.trim();
  const translatedText = value.translatedText.trim();
  if (!translatedText) {
    throw new ApiError(
      502,
      "EMPTY_TRANSLATION",
      "翻訳結果が空でした。文章を確認してもう一度お試しください。",
    );
  }

  const segments = preserveSourceSegments(sourceText, translatedText, value.segments.slice(0, 30));
  const grammarNotes = value.grammarNotes
    .filter((n) => n.title.trim() && n.explanation.trim())
    .slice(0, 8);
  const keyPhrases = value.keyPhrases.filter((p) => p.term.trim() && p.meaning.trim() && sourceText.includes(p.term)).slice(0, 12);

  const now = Date.now();
  const id = crypto.randomUUID();
  if (body.saveHistory) {
    await c.env.DB.prepare(
      `INSERT INTO translations
       (id, source_text, translated_text, source_lang, target_lang, segments_json,
        grammar_notes_json, key_phrases_json, image_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        id,
        sourceText,
        translatedText,
        body.sourceLang,
        body.targetLang,
        JSON.stringify(segments),
        JSON.stringify(grammarNotes),
        JSON.stringify(keyPhrases),
        now,
      )
      .run();
    await pruneTranslationHistory(c.env);
  }

  return c.json({
    id: body.saveHistory ? id : null,
    sourceText,
    translatedText,
    sourceLang: body.sourceLang,
    targetLang: body.targetLang,
    segments,
    grammarNotes,
    keyPhrases,
    imageKey: null,
    createdAt: now,
    cached,
  });
});

translateRoutes.get("/translations", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30) || 30));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const where = q
    ? "WHERE source_text LIKE ? OR translated_text LIKE ?"
    : "";
  const params = q ? [like, like] : [];
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM translations ${where}`)
    .bind(...params)
    .first<{ c: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM translations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit + 1, offset)
    .all<Record<string, unknown>>();
  const all = (rows.results ?? []).map(mapTranslation);
  const items = all.slice(0, limit);
  return c.json({
    items,
    total: Number(count?.c ?? 0),
    hasMore: all.length > limit,
    nextOffset: offset + items.length,
  });
});

translateRoutes.get("/translations/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM translations WHERE id = ?")
    .bind(c.req.param("id"))
    .first<Record<string, unknown>>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "翻訳履歴が見つかりません。");
  }
  return c.json(mapTranslation(row));
});

translateRoutes.delete("/translations/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT image_key FROM translations WHERE id = ?")
    .bind(id)
    .first<{ image_key: string | null }>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "翻訳履歴が見つかりません。");
  }
  await c.env.DB.prepare("DELETE FROM translations WHERE id = ?").bind(id).run();
  if (row.image_key) await releaseImageIfUnused(c.env, row.image_key);
  return c.json({ ok: true });
});

translateRoutes.post("/translate/explain", async (c) => {
  const body = await parseBody(c, explainRequestSchema, 100_000);
  const { value, cached } = await runJsonModel(c.env, {
    kind: "explain",
    system: EXPLAIN_SYSTEM,
    user: explainUser(body),
    schema: explainResultSchema,
    maxTokens: 900,
    temperature: 0.15,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  });

  const points = value.points.map((p) => p.trim()).filter(Boolean).slice(0, 6);
  return c.json({ points, cached });
});

translateRoutes.post("/translate/chat", async (c) => {
  const body = await parseBody(c, chatRequestSchema, 100_000);
  let selectedRange;
  if (body.selectedRange) {
    const selection = body.selectedRange;
    const source = selection.side === "translation" ? body.translatedText : body.sourceText;
    const start = selection.start ?? source.indexOf(selection.text);
    const end = selection.end ?? start + selection.text.length;
    if (start < 0 || end <= start || source.slice(start, end) !== selection.text) {
      throw new ApiError(400, "INVALID_SELECTION", "選択した範囲が文章と一致しません。");
    }
    selectedRange = { ...selection, start, end };
  }
  const { value, cached } = await runJsonModel(c.env, {
    kind: "chat",
    system: CHAT_SYSTEM,
    user: chatUser({ ...body, selectedRange }),
    schema: chatResultSchema,
    maxTokens: 900,
    temperature: 0.2,
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

  return c.json({
    answer: value.answer.trim(),
    cached,
  });
});

// Compatibility for the reader's JSON transport; synthesis and caching share /speech.
translateRoutes.post("/tts", async (c) => {
  const body = await parseBody(c, ttsRequestSchema, 50_000);
  const response = await speechRoutes.request("https://internal/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: body.text, lang: body.lang }),
  }, c.env);
  if (!response.ok) return response;
  return c.json({
    audioBase64: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
    mimeType: response.headers.get("content-type") || "audio/wav",
    cached: response.headers.get("x-speech-cache") === "hit",
  });
});
