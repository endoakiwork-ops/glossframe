import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  status: ContentfulStatusCode;
  code: string;
  details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

export class AiQuotaError extends ApiError {
  constructor(message = "Workers AI の無料枠を使い切った可能性があります。") {
    super(429, "AI_QUOTA", message);
  }
}

export class AiUnavailableError extends ApiError {
  constructor(message = "Workers AI に接続できませんでした。") {
    super(503, "AI_UNAVAILABLE", message);
  }
}
