import type { Env } from "./env";
import { releaseImageIfUnused } from "./images";

/**
 * Translation history keeps only the newest entries. Word cards store their
 * own example text and image references, so pruning history never touches the
 * wordbook; shared images survive while a word example still uses them.
 */
export const HISTORY_LIMIT = 100;

export async function pruneTranslationHistory(env: Env): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, image_key FROM translations
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
      .bind(HISTORY_LIMIT)
      .all<{ id: string; image_key: string | null }>();
    const stale = rows.results ?? [];
    if (!stale.length) return;
    await env.DB.batch(
      stale.map((row) => env.DB.prepare("DELETE FROM translations WHERE id = ?").bind(row.id)),
    );
    const keys = [...new Set(stale.map((row) => row.image_key).filter((key): key is string => Boolean(key)))];
    await Promise.all(keys.map((key) => releaseImageIfUnused(env, key)));
  } catch (error) {
    // A failed cleanup must not fail the translation that triggered it.
    console.warn("Translation history pruning failed", error);
  }
}
