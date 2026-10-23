import { Hono } from "hono";
import type { AppEnv } from "../env";
import { parseBody } from "../validate";
import { settingsPatchSchema } from "../../shared/schemas";
import { ensureSettings, getStats, mapSettings } from "../db";
import { getAccountKvBytes, getAccountNeurons } from "../account-usage";

// Cloudflare free plan: 500 MB per D1 database, 1 GB of KV storage per account.
const D1_FREE_DB_BYTES = 500 * 1000 * 1000;
const KV_FREE_BYTES = 1000 * 1000 * 1000;

async function getDatabaseBytes(db: D1Database): Promise<number | null> {
  try {
    // D1 reports the database file size in every query's metadata.
    const result = await db.prepare("SELECT 1").run();
    const size = Number((result.meta as { size_after?: number }).size_after);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}
import { ApiError } from "../errors";
import { configuredModel, configuredWordModel, fallbackModel } from "../ai";
import { PROMPT_VERSION } from "../../shared/types";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings", async (c) => {
  return c.json(await ensureSettings(c.env.DB));
});

settingsRoutes.put("/settings", async (c) => {
  const patch = await parseBody(c, settingsPatchSchema);
  const current = await ensureSettings(c.env.DB);
  const next = { ...current, ...patch };
  if (next.sourceLang === next.targetLang) {
    throw new ApiError(400, "SAME_LANGUAGE", "翻訳元と翻訳先には別の言語を選んでください。");
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE settings SET source_lang = ?, target_lang = ?, save_images = ?,
     review_interval_days = ?, review_target_count = ?, review_batch_size = ?,
     review_show_image = ?, review_order = ?, updated_at = ? WHERE id = 1`,
  )
    .bind(
      next.sourceLang,
      next.targetLang,
      next.saveImages ? 1 : 0,
      next.reviewIntervalDays,
      next.reviewTargetCount,
      next.reviewBatchSize,
      next.reviewShowImage ? 1 : 0,
      next.reviewOrder,
      now,
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").first<
    Record<string, unknown>
  >();
  return c.json(mapSettings(row ?? {}));
});

settingsRoutes.get("/stats", async (c) => {
  const [stats, account, d1Bytes, kvBytes] = await Promise.all([
    getStats(c.env.DB),
    getAccountNeurons(c.env),
    getDatabaseBytes(c.env.DB),
    getAccountKvBytes(c.env),
  ]);
  stats.ai.account = account;
  stats.storage = {
    d1: { usedBytes: d1Bytes, limitBytes: D1_FREE_DB_BYTES },
    kv:
      kvBytes !== null
        ? { usedBytes: kvBytes, limitBytes: KV_FREE_BYTES, source: "account" }
        : { usedBytes: stats.imageBytes, limitBytes: KV_FREE_BYTES, source: "app" },
  };
  return c.json(stats);
});

settingsRoutes.get("/config", async (c) => {
  return c.json({
    appName: c.env.APP_NAME ?? "GlossFrame",
    model: configuredModel(c.env),
    wordModel: configuredWordModel(c.env),
    fallbackModel: fallbackModel(c.env),
    maxTextLength: 6000,
    maxImageBytes: 8 * 1024 * 1024,
    promptVersion: PROMPT_VERSION,
  });
});
