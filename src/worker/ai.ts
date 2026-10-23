import { z } from "zod";
import type { Env } from "./env";
import { AiQuotaError, AiUnavailableError, ApiError } from "./errors";
import { recordUsage } from "./db";
import { estimateTokens, sha256Hex } from "../shared/text";
import { PROMPT_VERSION } from "../shared/types";

const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

export interface JsonModelOptions<S extends z.ZodTypeAny> {
  kind: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  temperature?: number;
  cacheTtlMs?: number;
}

export interface JsonModelResult<T> {
  value: T;
  cached: boolean;
  model: string;
}

interface ModelReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Neurons reported by Workers AI; 0 when the response did not include them. */
  neurons: number;
}

export function configuredModel(env: Env): string {
  return env.DEFAULT_MODEL?.trim() || DEFAULT_MODEL;
}

export function fallbackModel(env: Env): string {
  return env.FALLBACK_MODEL?.trim() || FALLBACK_MODEL;
}

export function configuredWordModel(env: Env): string {
  return env.WORD_MODEL?.trim() || FALLBACK_MODEL;
}

function modelsFor(env: Env, kind: string): string[] {
  // Similar expressions and quiz generation run on the default model: in
  // measurements it answered short JSON roughly twice as fast as the word model.
  // The quiz critic uses the other model so it does not grade its own sentences.
  const primary = kind === "word" || kind === "quiz-quality" ? configuredWordModel(env) : configuredModel(env);
  // Keep the configured fallback chain, but never call the same model twice.
  return [...new Set([primary, fallbackModel(env), configuredModel(env)])].filter(Boolean);
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.response === "string") return r.response;
  const choices = r.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    const content = message?.content ?? choice.text;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            return String((part as { text: unknown }).text ?? "");
          }
          return "";
        })
        .join("");
      if (joined.trim()) return joined;
    }
    // Some reasoning models (for example Qwen 3) return the JSON in a
    // reasoning field while leaving message.content null.
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === "string") return reasoning;
  }
  const nested = r.result as Record<string, unknown> | undefined;
  if (nested && typeof nested.response === "string") return nested.response;
  return "";
}

function extractUsage(result: unknown): { input: number; output: number; neurons: number } {
  if (!result || typeof result !== "object") return { input: 0, output: 0, neurons: 0 };
  const r = result as Record<string, unknown>;
  const usage = (r.usage ?? (r.result as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return { input: 0, output: 0, neurons: 0 };
  return {
    input: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    output: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    // Workers AI reports the exact Neurons billed for the call.
    neurons: Number(usage.neurons ?? 0) || 0,
  };
}

function isQuotaError(error: unknown): boolean {
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

function isUnsupportedOptionError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("chat_template") ||
    message.includes("enable_thinking") ||
    message.includes("unknown") ||
    message.includes("unsupported")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invoke(
  env: Env,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): Promise<ModelReply> {
  const ai = env.AI as unknown as { run: (name: string, input: unknown) => Promise<unknown> } | undefined;
  if (!ai || typeof ai.run !== "function") {
    throw new AiUnavailableError(
      "Workers AI バインディングが設定されていません。wrangler.jsonc の ai.binding を確認してください。",
    );
  }

  const base = {
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };

  let result: unknown;
  try {
    result = await ai.run(model, {
      ...base,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    });
  } catch (error) {
    if (isQuotaError(error)) throw new AiQuotaError();
    if (!isUnsupportedOptionError(error)) {
      // One lightweight retry for transient upstream failures.
      await sleep(250);
      try {
        result = await ai.run(model, base);
      } catch (retryError) {
        if (isQuotaError(retryError)) throw new AiQuotaError();
        throw retryError;
      }
    } else {
      try {
        result = await ai.run(model, base);
      } catch (retryError) {
        if (isQuotaError(retryError)) throw new AiQuotaError();
        throw retryError;
      }
    }
  }

  const text = extractText(result);
  const usage = extractUsage(result);
  const estimatedInput = estimateTokens(messages.map((m) => m.content).join("\n"));
  return {
    text,
    model,
    inputTokens: usage.input || estimatedInput,
    outputTokens: usage.output || estimateTokens(text),
    neurons: usage.neurons,
  };
}

function tryParseJson(text: string): unknown {
  const cleaned = text.trim();
  if (!cleaned) return null;
  const candidates = [cleaned];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const repaired = candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      try {
        return JSON.parse(repaired);
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

export async function runJsonModel<S extends z.ZodTypeAny>(
  env: Env,
  options: JsonModelOptions<S>,
): Promise<JsonModelResult<z.infer<S>>> {
  const cacheKey = await sha256Hex(
    [PROMPT_VERSION, ...modelsFor(env, options.kind), options.kind, options.system, options.user, options.schema.description ?? ""].join("\u0000"),
  );
  const now = Date.now();
  const cached = await env.DB.prepare(
    "SELECT value FROM ai_cache WHERE key = ? AND expires_at > ?",
  )
    .bind(cacheKey, now)
    .first<{ value: string }>();
  if (cached?.value) {
    const parsed = tryParseJson(cached.value);
    const validated = options.schema.safeParse(parsed);
    if (validated.success) {
      return { value: validated.data, cached: true, model: "cache" };
    }
  }

  const models = modelsFor(env, options.kind);

  let lastRaw = "";
  let usedModel = models[0];

  for (const model of models) {
    usedModel = model;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const messages =
          attempt === 0
            ? [
                { role: "system", content: options.system },
                { role: "user", content: options.user },
              ]
            : [
                { role: "system", content: options.system },
                { role: "user", content: options.user },
                {
                  role: "assistant",
                  content: lastRaw.slice(0, 4000) || "(empty)",
                },
                {
                  role: "user",
                  content:
                    "Your previous answer was invalid. Return ONLY a corrected JSON object that exactly matches the requested schema. No markdown, no commentary.",
                },
              ];
        const reply = await invoke(
          env,
          model,
          messages,
          options.maxTokens ?? 1400,
          attempt === 0 ? (options.temperature ?? 0.15) : 0,
        );
        try {
          await recordUsage(env.DB, {
            kind: options.kind,
            model: reply.model,
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            neurons: reply.neurons,
          });
        } catch {
          // Usage statistics are best-effort.
        }
        lastRaw = reply.text;
        const parsed = tryParseJson(reply.text);
        const validated = options.schema.safeParse(parsed);
        if (!validated.success) {
          console.warn("AI response failed schema validation", { kind: options.kind, model,
            length: reply.text.length, issues: validated.error.issues.slice(0, 5).map(issue => ({ path: issue.path.join("."), code: issue.code })) });
        }
        if (validated.success) {
          try {
            await env.DB.prepare(
              `INSERT INTO ai_cache (key, kind, value, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at`,
            )
              .bind(
                cacheKey,
                options.kind,
                JSON.stringify(validated.data),
                now,
                now + (options.cacheTtlMs ?? 30 * 24 * 60 * 60 * 1000),
              )
              .run();
          } catch {
            // Cache failure should never lose a valid result.
          }
          return { value: validated.data, cached: false, model: reply.model };
        }
      } catch (error) {
        if (error instanceof AiQuotaError || error instanceof AiUnavailableError) throw error;
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        if (
          message.includes("needs to be run remotely") ||
          message.includes("binding") ||
          message.includes("fetch failed") ||
          message.includes("network") ||
          message.includes("timed out") ||
          message.includes("timeout")
        ) {
          throw new AiUnavailableError(
            "Workers AI に接続できませんでした。少し待ってからもう一度お試しください。",
          );
        }
      }
    }
  }

  throw new ApiError(
    502,
    "AI_INVALID_RESPONSE",
    "AI の応答を正しく解釈できませんでした。もう一度お試しください。",
  );
}
