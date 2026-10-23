import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { AiQuotaError, AiUnavailableError, ApiError } from "../errors";
import { parseBody } from "../validate";
import { recordUsage } from "../db";
import { SPEECH_MODEL_ID } from "../../shared/neurons";
import { countChars, sha256Hex } from "../../shared/text";

export const SPEECH_MODEL = SPEECH_MODEL_ID;
export const SPEECH_LANG = "en";
export const SPEECH_MAX_TEXT_CHARS = 2000;
export const SPEECH_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
function audioContentType(bytes: Uint8Array): string {
  const tag = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE") return "audio/wav";
  if (tag(0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return invalidAudio("対応する音声形式ではありませんでした。");
}

const speechSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "読み上げる英文を入力してください。")
    .refine(
      (value) => countChars(value) <= SPEECH_MAX_TEXT_CHARS,
      `読み上げる英文は${SPEECH_MAX_TEXT_CHARS}文字以内にしてください。`,
    ),
  // MeloTTS is multilingual, but this app exposes English playback first.
  lang: z.string().optional().default(SPEECH_LANG),
});

export const speechRoutes = new Hono<AppEnv>();
speechRoutes.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  return c.json({ error: { code: "SPEECH_FAILED", message: "音声を生成できませんでした。" } }, 503);
});

/**
 * Cache identity for generated speech. Keep this stable: a change to the
 * version, model, language or text must produce a different key.
 */
export async function speechCacheKey(
  text: string,
  lang: string = SPEECH_LANG,
  model: string = SPEECH_MODEL,
): Promise<string> {
  const digest = await sha256Hex(JSON.stringify([model, lang, text]));
  return `speech:${CACHE_VERSION}:${digest}`;
}

interface SpeechAi {
  run(model: string, input: { prompt: string; lang: string }): Promise<unknown>;
}

function audioTooLarge(): never {
  throw new ApiError(
    502,
    "SPEECH_AUDIO_TOO_LARGE",
    "生成された音声データが大きすぎます。文章を短くしてお試しください。",
  );
}

function invalidAudio(
  message = "AI が生成した音声データを読み取れませんでした。もう一度お試しください。",
): never {
  throw new ApiError(502, "SPEECH_INVALID_AUDIO", message);
}

function assertAudioSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) invalidAudio("音声データが空でした。");
  if (bytes.byteLength > SPEECH_MAX_AUDIO_BYTES) audioTooLarge();
  audioContentType(bytes);
  return bytes;
}

function decodeBase64Audio(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const raw = /^data:/i.test(value) && comma >= 0 ? value.slice(comma + 1) : value;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) invalidAudio("音声データが空でした。");

  // Reject obviously oversized payloads before allocating the decoded buffer.
  const maxEncodedLength = Math.ceil(SPEECH_MAX_AUDIO_BYTES / 3) * 4 + 4;
  if (compact.length > maxEncodedLength) audioTooLarge();
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    invalidAudio();
  }

  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    invalidAudio();
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return assertAudioSize(bytes);
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

async function readAudioStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > SPEECH_MAX_AUDIO_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size check below is the source of truth.
        }
        audioTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors from an already closed stream.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return assertAudioSize(bytes);
}

/**
 * Workers AI may return a Uint8Array (binary), an object with base64 `audio`,
 * a ReadableStream, or a Response when the generated audio is fetched directly.
 * Normalize all of them into an in-memory MP3 byte array.
 */
async function normalizeAudio(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) invalidAudio();
  if (typeof value === "string") return decodeBase64Audio(value);
  if (value instanceof Uint8Array) return assertAudioSize(value);
  if (value instanceof ArrayBuffer) return assertAudioSize(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return assertAudioSize(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return assertAudioSize(new Uint8Array(await value.arrayBuffer()));
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    if (value.status === 429) throw new AiQuotaError();
    if (!value.ok) {
      throw new AiUnavailableError(
        "Workers AI から音声を取得できませんでした。少し待ってからもう一度お試しください。",
      );
    }
    if (!value.body) invalidAudio("音声データが空でした。");
    return readAudioStream(value.body);
  }
  if (isReadableStream(value)) return readAudioStream(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("audio" in record) return normalizeAudio(record.audio);
    if ("result" in record) return normalizeAudio(record.result);
  }
  return invalidAudio();
}

function isQuotaError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown; statusCode?: unknown }).status;
    const statusCode = (error as { status?: unknown; statusCode?: unknown }).statusCode;
    if (Number(status) === 429 || Number(statusCode) === 429) return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("quota") ||
    message.includes("exhaust") ||
    message.includes("free allocation") ||
    message.includes("neurons") ||
    message.includes("3036") ||
    message.includes("402") ||
    message.includes("429")
  );
}

async function synthesizeSpeech(env: Env, text: string): Promise<Uint8Array> {
  const ai = env.AI as unknown as SpeechAi | undefined;
  if (!ai || typeof ai.run !== "function") {
    throw new AiUnavailableError(
      "Workers AI バインディングが設定されていません。wrangler.jsonc の ai.binding を確認してください。",
    );
  }

  let result: unknown;
  try {
    result = await ai.run(SPEECH_MODEL, { prompt: text, lang: SPEECH_LANG });
  } catch (error) {
    if (isQuotaError(error)) throw new AiQuotaError();
    throw new AiUnavailableError(
      "音声を生成できませんでした。少し待ってからもう一度お試しください。",
    );
  }

  try {
    return await normalizeAudio(result);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "SPEECH_INVALID_AUDIO",
      "AI が生成した音声データを読み取れませんでした。もう一度お試しください。",
    );
  }
}

async function readCachedAudio(env: Env, key: string): Promise<Uint8Array | null> {
  try {
    const value = await env.IMAGES.get(key, { type: "arrayBuffer" });
    if (!value) return null;
    const bytes = new Uint8Array(value);
    if (bytes.byteLength === 0 || bytes.byteLength > SPEECH_MAX_AUDIO_BYTES) return null;
    return assertAudioSize(bytes);
  } catch {
    // A cache outage must behave like a miss, not like a failed request.
    return null;
  }
}

async function writeCachedAudio(env: Env, key: string, bytes: Uint8Array): Promise<void> {
  try {
    await env.IMAGES.put(key, bytes, {
      expirationTtl: CACHE_TTL_SECONDS,
      metadata: { contentType: audioContentType(bytes), model: SPEECH_MODEL, lang: SPEECH_LANG },
    });
  } catch {
    // Cache failure must never discard generated audio.
  }
}

async function recordSpeechUsage(env: Env, text: string): Promise<void> {
  try {
    // MeloTTS is billed by audio minutes, not tokens. Store the character
    // count in input_tokens so the usage summary can estimate audio minutes.
    await recordUsage(env.DB, {
      kind: "speech",
      model: SPEECH_MODEL,
      inputTokens: text.length,
      outputTokens: 0,
    });
  } catch {
    // Usage statistics are best-effort.
  }
}

function audioResponse(bytes: Uint8Array, cached: boolean): Response {
  // Copy into a standalone ArrayBuffer so the response body owns exactly the
  // audio bytes even when the source is a view into a larger buffer.
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    status: 200,
    headers: {
      "content-type": audioContentType(bytes),
      "content-length": String(body.byteLength),
      "cache-control": `private, max-age=${CACHE_TTL_SECONDS}`,
      "x-content-type-options": "nosniff",
      "x-speech-cache": cached ? "hit" : "miss",
    },
  });
}

speechRoutes.post("/speech", async (c) => {
  const body = await parseBody(c, speechSchema, 64_000);
  if (body.lang !== SPEECH_LANG) {
    throw new ApiError(400, "UNSUPPORTED_LANGUAGE", "現在は英語の読み上げのみ対応しています。");
  }

  const text = body.text.trim();
  const key = await speechCacheKey(text, SPEECH_LANG);
  const cached = await readCachedAudio(c.env, key);
  if (cached) return audioResponse(cached, true);

  const bytes = await synthesizeSpeech(c.env, text);
  await writeCachedAudio(c.env, key, bytes);
  await recordSpeechUsage(c.env, text);
  return audioResponse(bytes, false);
});
