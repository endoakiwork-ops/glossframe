import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors";

export async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
  maxBytes = 2_000_000,
): Promise<z.infer<S>> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "送信データが大きすぎます。");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "リクエストの形式が正しくありません。");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      issue?.message ?? "入力内容を確認してください。",
      parsed.error.issues.slice(0, 8),
    );
  }
  return parsed.data;
}
