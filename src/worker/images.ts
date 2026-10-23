import type { Env } from "./env";
import { ApiError } from "./errors";
import { sha256Hex } from "../shared/text";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(",");
  const raw = input.startsWith("data:") && comma >= 0 ? input.slice(comma + 1) : input;
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    throw new ApiError(400, "INVALID_IMAGE", "画像データを読み取れませんでした。");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength === 0) {
    throw new ApiError(400, "INVALID_IMAGE", "画像が空です。");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", "画像は8MB以下にしてください。");
  }
  return bytes;
}

export interface StoreImageInput {
  dataBase64: string;
  contentType: string;
  sha256: string;
}

export async function storeImage(
  env: Env,
  input: StoreImageInput,
): Promise<{ key: string; deduped: boolean }> {
  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw new ApiError(400, "INVALID_IMAGE_TYPE", "WebP・JPEG・PNG のみ保存できます。");
  }
  const bytes = decodeBase64(input.dataBase64);
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== input.sha256) {
    throw new ApiError(400, "IMAGE_HASH_MISMATCH", "画像の検証に失敗しました。");
  }

  const existing = await env.DB.prepare("SELECT key FROM images WHERE sha256 = ?")
    .bind(actualHash)
    .first<{ key: string }>();
  if (existing) return { key: existing.key, deduped: true };

  const key = crypto.randomUUID();
  const now = Date.now();
  await env.IMAGES.put(`img:${key}`, bytes, {
    metadata: { contentType: input.contentType, sha256: actualHash },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO images (key, sha256, content_type, size, created_at, ref_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
      .bind(key, actualHash, input.contentType, bytes.byteLength, now)
      .run();
  } catch (error) {
    // A concurrent request may have stored the same hash first.
    await env.IMAGES.delete(`img:${key}`);
    const raced = await env.DB.prepare("SELECT key FROM images WHERE sha256 = ?")
      .bind(actualHash)
      .first<{ key: string }>();
    if (raced) return { key: raced.key, deduped: true };
    throw error;
  }
  return { key, deduped: false };
}

export async function getImage(
  env: Env,
  key: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const row = await env.DB.prepare("SELECT content_type FROM images WHERE key = ?")
    .bind(key)
    .first<{ content_type: string }>();
  if (!row) return null;
  const bytes = await env.IMAGES.get(`img:${key}`, { type: "arrayBuffer" });
  if (!bytes) return null;
  return { bytes, contentType: row.content_type };
}

export async function releaseImageIfUnused(env: Env, key: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM translations WHERE image_key = ?) +
       (SELECT COUNT(*) FROM word_examples WHERE image_key = ?) AS c`,
  )
    .bind(key, key)
    .first<{ c: number }>();
  if (Number(row?.c ?? 0) > 0) return;
  await Promise.all([
    env.IMAGES.delete(`img:${key}`),
    env.DB.prepare("DELETE FROM images WHERE key = ?").bind(key).run(),
  ]);
}

export async function imageExists(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM images WHERE key = ?")
    .bind(key)
    .first<{ ok: number }>();
  return Boolean(row?.ok);
}
