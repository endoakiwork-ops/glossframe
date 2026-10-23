import type { ApiError as ApiErrorBody } from "../../shared/types";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeoutMs?: number;
  onEvent?: (event: unknown) => void;
}

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;
  const method = (options.method ?? "GET").toUpperCase();
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  } else if (method !== "GET" && method !== "HEAD") {
    // The worker requires a JSON content type on every state-changing request
    // as a CSRF barrier, including body-less ones such as DELETE.
    headers.set("content-type", "application/json");
    body = "{}";
  }
  headers.set("accept", options.onEvent ? "application/x-ndjson" : "application/json");
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      body,
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (response.ok && options.onEvent) {
      if (!response.body) throw new Error("翻訳結果を受信できませんでした。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      let result: T | undefined;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === "error") throw new ApiError(502, "TRANSLATION_FAILED", event.message);
        if (event.type === "complete") { completed = true; result = event.result as T; }
        else options.onEvent?.(event);
      };
      try {
        while (true) {
          const {done, value} = await reader.read();
          buffer += decoder.decode(value, {stream: !done});
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            consume(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (done) break;
        }
        consume(buffer);
        if (!completed) throw new ApiError(502, "INCOMPLETE", "翻訳の受信が途切れました。もう一度お試しください。");
        return result as T;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      if (response.status === 401) unauthorizedHandler?.();
      throw new ApiError(
        response.status,
        error?.code ?? "HTTP_ERROR",
        error?.message ?? `通信に失敗しました (${response.status})`,
        error?.details,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", "通信がタイムアウトしました。もう一度お試しください。");
    }
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "ネットワークに接続できませんでした。オフラインの場合はオンラインに戻ってからお試しください。",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function apiBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw new ApiError(response.status, "HTTP_ERROR", "ファイルを取得できませんでした。");
  }
  return response.blob();
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "エラーが発生しました。";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
