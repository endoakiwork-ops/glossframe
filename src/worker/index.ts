import { Hono } from "hono";
import type { AppEnv } from "./env";
import { authRoutes } from "./routes/auth";
import { translateRoutes } from "./routes/translate";
import { wordRoutes } from "./routes/words";
import { settingsRoutes } from "./routes/settings";
import { imageRoutes } from "./routes/images";
import { backupRoutes } from "./routes/backup";
import { speechRoutes } from "./routes/speech";
import { imageTranslationRoutes } from "./routes/translate-regions";
import { regionRoutes } from "./routes/regions";
import { requireAuth } from "./auth";
import { configuredModel } from "./ai";
import { ApiError } from "./errors";

const app = new Hono<AppEnv>();

const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/recover",
  "/api/auth/setup",
  "/api/auth/logout",
]);

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "manifest-src 'self'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "same-origin");
  c.header("permissions-policy", "camera=(self), microphone=(), geolocation=()");
  c.header("content-security-policy", CSP);
  if (new URL(c.req.url).protocol === "https:") {
    c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});

// Cookies are SameSite=Lax; same-origin checks and JSON-only bodies add a
// second CSRF barrier for every state-changing API request.
app.use("/api/*", async (c, next) => {
  c.header("cache-control", "no-store");
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const url = new URL(c.req.url);
    const origin = c.req.header("origin");
    const expected = url.origin;
    const localDev =
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      origin !== undefined &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
    if (origin !== expected && !localDev) {
      throw new ApiError(403, "CSRF_CHECK_FAILED", "リクエスト元を確認できませんでした。");
    }
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw new ApiError(415, "JSON_REQUIRED", "JSON 形式で送信してください。");
    }
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  if (PUBLIC_API.has(c.req.path)) return next();
  return requireAuth()(c, next);
});

app.get("/api/health", async (c) => {
  const checks: Record<string, boolean> = { db: false, kv: false, ai: Boolean(c.env.AI) };
  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
    checks.db = true;
  } catch {
    checks.db = false;
  }
  try {
    await c.env.IMAGES.get("__health__");
    checks.kv = true;
  } catch {
    checks.kv = false;
  }
  const ok = checks.db && checks.kv;
  return c.json(
    {
      ok,
      checks,
      model: configuredModel(c.env),
      time: Date.now(),
    },
    ok ? 200 : 503,
  );
});

app.route("/api/auth", authRoutes);
app.route("/api", translateRoutes);
app.route("/api", imageTranslationRoutes);
app.route("/api", wordRoutes);
app.route("/api", settingsRoutes);
app.route("/api", imageRoutes);
app.route("/api", backupRoutes);
app.route("/api", speechRoutes);
app.route("/api", regionRoutes);

app.all("/api/*", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "API が見つかりません。" } }, 404),
);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      error.status,
    );
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("no such table")) {
    return c.json(
      {
        error: {
          code: "DB_NOT_MIGRATED",
          message:
            "データベースの初期化が完了していません。管理者は wrangler d1 migrations apply を実行してください。",
        },
      },
      503,
    );
  }
  console.error("Unhandled API error", {
    path: new URL(c.req.url).pathname,
    name: error instanceof Error ? error.name : "Error",
    message: message.slice(0, 300),
  });
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "サーバーでエラーが発生しました。" } },
    500,
  );
});

export default app;
