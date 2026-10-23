import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Env } from "../src/worker/env";
import { ApiError } from "../src/worker/errors";
import {
  SPEECH_MAX_AUDIO_BYTES,
  SPEECH_MODEL,
  speechCacheKey,
  speechRoutes,
} from "../src/worker/routes/speech";

const SEVEN_DAYS = 7 * 24 * 60 * 60;

function arrayBufferOf(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  throw new TypeError("Expected binary value");
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface HarnessOptions {
  ai?: unknown;
  failPut?: boolean;
  failGet?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const cache = new Map<string, ArrayBuffer>();
  const puts: Array<{ key: string; value: ArrayBuffer; options: unknown }> = [];
  const dbWrites: Array<{ sql: string; args: unknown[] }> = [];

  const aiRun = vi.fn(
    async (_model: string, _input: { prompt: string; lang?: string }): Promise<unknown> => ({
      audio: base64Of(bytesOf(0x49, 0x44, 0x33, 1, 2, 3)),
    }),
  );

  const kv = {
    get: vi.fn(async (key: string) => {
      if (options.failGet) throw new Error("KV get failed");
      return cache.get(key) ?? null;
    }),
    put: vi.fn(
      async (key: string, value: unknown, putOptions: { expirationTtl?: number }) => {
        if (options.failPut) throw new Error("KV put failed");
        const buffer = arrayBufferOf(value);
        puts.push({ key, value: buffer, options: putOptions });
        cache.set(key, buffer);
      },
    ),
  };

  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => {
          args = values;
          return statement;
        },
        first: async () => null,
        run: async () => {
          dbWrites.push({ sql, args });
          return {};
        },
      };
      return statement;
    },
  };

  const env = {
    AI: options.ai === undefined ? { run: aiRun } : options.ai,
    IMAGES: kv,
    DB: db,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    );
  });
  app.route("/api", speechRoutes);

  return { app, env, aiRun, kv, cache, puts, dbWrites };
}

async function postSpeech(
  app: Hono<AppEnv>,
  env: Env,
  body: unknown,
): Promise<Response> {
  return await app.request(
    "https://app.example/api/speech",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code ?? "";
}

describe("POST /api/speech", () => {
  it("uses a versioned sha256 cache key built from model, lang and text", async () => {
    const first = await speechCacheKey("Hello.", "en");
    expect(first).toMatch(/^speech:v1:[a-f0-9]{64}$/);
    expect(await speechCacheKey("Hello.", "en")).toBe(first);
    expect(await speechCacheKey("Hello!", "en")).not.toBe(first);

    const otherModel = await speechCacheKey("Hello.", "en", "@cf/example/other");
    expect(otherModel).not.toBe(first);
  });

  it("returns a cached MP3 without calling Workers AI", async () => {
    const h = harness();
    const text = "This sentence is already cached.";
    const audio = bytesOf(0x49, 0x44, 0x33, 4, 0, 0, 0);
    h.cache.set(await speechCacheKey(text, "en"), arrayBufferOf(audio));

    const response = await postSpeech(h.app, h.env, { text, lang: "en" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-speech-cache")).toBe("hit");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.kv.put).not.toHaveBeenCalled();
  });

  it("defaults to English when lang is omitted", async () => {
    const h = harness();
    h.aiRun.mockResolvedValueOnce({ audio: base64Of(bytesOf(0x49, 0x44, 0x33, 9, 8, 7)) });

    const response = await postSpeech(h.app, h.env, { text: "Read this." });

    expect(response.status).toBe(200);
    expect(h.aiRun).toHaveBeenCalledWith(SPEECH_MODEL, {
      prompt: "Read this.",
      lang: "en",
    });
  });

  it("rejects empty, overlong, and non-English input before calling AI", async () => {
    const h = harness();

    const empty = await postSpeech(h.app, h.env, { text: "   ", lang: "en" });
    const overlong = await postSpeech(h.app, h.env, {
      text: "a".repeat(2001),
      lang: "en",
    });
    const japanese = await postSpeech(h.app, h.env, { text: "こんにちは", lang: "ja" });

    expect(empty.status).toBe(400);
    expect(overlong.status).toBe(400);
    expect(japanese.status).toBe(400);
    expect(h.aiRun).not.toHaveBeenCalled();
  });

  it("returns 503 when the AI binding is missing", async () => {
    const h = harness({ ai: null });

    const response = await postSpeech(h.app, h.env, { text: "Hello.", lang: "en" });

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("AI_UNAVAILABLE");
  });

  it("returns 502 when AI returns an unusable audio payload", async () => {
    const h = harness();
    h.aiRun.mockResolvedValueOnce({ audio: "not base64!!" });

    const response = await postSpeech(h.app, h.env, { text: "Hello.", lang: "en" });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("SPEECH_INVALID_AUDIO");
    expect(h.kv.put).not.toHaveBeenCalled();
    expect(h.dbWrites).toHaveLength(0);
  });

  it("returns 502 when AI returns an empty payload", async () => {
    const h = harness();
    h.aiRun.mockResolvedValueOnce({});

    const response = await postSpeech(h.app, h.env, { text: "Hello.", lang: "en" });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("SPEECH_INVALID_AUDIO");
  });

  it("accepts a ReadableStream and caches the MP3 for seven days", async () => {
    const h = harness();
    const first = bytesOf(0xff, 0xfb, 0x90, 0x64);
    const second = bytesOf(0x01, 0x02, 0x03);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    h.aiRun.mockResolvedValueOnce(stream);

    const text = "Streaming audio.";
    const response = await postSpeech(h.app, h.env, { text, lang: "en" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-speech-cache")).toBe("miss");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      bytesOf(0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03),
    );

    const key = await speechCacheKey(text, "en");
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].key).toBe(key);
    expect(h.puts[0].options).toMatchObject({ expirationTtl: SEVEN_DAYS });
    expect(new Uint8Array(h.puts[0].value)).toEqual(
      bytesOf(0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03),
    );

    const usage = h.dbWrites.find((write) =>
      write.sql.includes("INSERT INTO ai_usage"),
    );
    expect(usage).toBeDefined();
    expect(usage?.args[1]).toBe("speech");
    expect(usage?.args[2]).toBe(SPEECH_MODEL);
    // Character count, used to estimate billed audio minutes.
    expect(usage?.args[3]).toBe(text.length);
    expect(usage?.args[4]).toBe(0);
    expect(
      h.dbWrites.every((write) => !write.sql.toLowerCase().includes("images")),
    ).toBe(true);

    const secondResponse = await postSpeech(h.app, h.env, { text, lang: "en" });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get("x-speech-cache")).toBe("hit");
    expect(h.aiRun).toHaveBeenCalledTimes(1);
  });

  it("decodes the base64 audio object form", async () => {
    const h = harness();
    const audio = bytesOf(0x49, 0x44, 0x33, 1, 1);
    h.aiRun.mockResolvedValueOnce({
      audio: `data:audio/mpeg;base64,${base64Of(audio)}`,
    });

    const response = await postSpeech(h.app, h.env, {
      text: "Base64 audio.",
      lang: "en",
    });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
  });

  it("returns WAV MIME for actual MeloTTS RIFF responses", async () => {
    const h = harness();
    const wav = new TextEncoder().encode("RIFF0000WAVEfmt ");
    h.aiRun.mockResolvedValueOnce({ audio: base64Of(wav) });
    const response = await postSpeech(h.app, h.env, { text: "WAV audio.", lang: "en" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
  });

  it("rejects base64 that decodes to non-audio data", async () => {
    const h = harness();
    h.aiRun.mockResolvedValueOnce({ audio: btoa("not an audio file") });
    const response = await postSpeech(h.app, h.env, { text: "Invalid audio.", lang: "en" });
    expect(response.status).toBe(502);
  });

  it("maps Workers AI quota failures to HTTP 429", async () => {
    const h = harness();
    h.aiRun.mockRejectedValueOnce(
      Object.assign(new Error("429 free allocation exhausted"), { status: 429 }),
    );

    const response = await postSpeech(h.app, h.env, { text: "Quota.", lang: "en" });

    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("AI_QUOTA");
  });

  it("keeps the generated audio when the KV cache write fails", async () => {
    const h = harness({ failPut: true });
    const audio = bytesOf(0x49, 0x44, 0x33, 5, 6, 7);
    h.aiRun.mockResolvedValueOnce({ audio: base64Of(audio) });

    const response = await postSpeech(h.app, h.env, {
      text: "Cache write failure.",
      lang: "en",
    });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(h.kv.put).toHaveBeenCalledTimes(1);
  });

  it("treats a KV read failure as a cache miss", async () => {
    const h = harness({ failGet: true });
    const audio = bytesOf(0x49, 0x44, 0x33, 4, 4, 4);
    h.aiRun.mockResolvedValueOnce({ audio: base64Of(audio) });

    const response = await postSpeech(h.app, h.env, {
      text: "Cache read failure.",
      lang: "en",
    });

    expect(response.status).toBe(200);
    expect(h.aiRun).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
  });

  it("rejects generated audio larger than 10 MB", async () => {
    const h = harness();
    h.aiRun.mockResolvedValueOnce(new Uint8Array(SPEECH_MAX_AUDIO_BYTES + 1));

    const response = await postSpeech(h.app, h.env, {
      text: "Too much audio.",
      lang: "en",
    });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("SPEECH_AUDIO_TOO_LARGE");
  });
});
