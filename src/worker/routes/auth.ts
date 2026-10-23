import type { Context } from "hono";
import { sha256Hex } from "../../shared/text";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  checkLoginRateLimit,
  clearSession,
  clientIp,
  createOwner,
  createSession,
  deleteOtherSessions,
  getOwner,
  readSession,
  recordLoginAttempt,
  requireAuth,
  updateOwnerPassword,
  verifyPassword,
  timingSafeEqual,
  hashPassword,
} from "../auth";
import { changePasswordSchema, loginSchema, setupSchema, recoverySchema } from "../../shared/schemas";
import { parseBody } from "../validate";
import { ApiError } from "../errors";

export const authRoutes = new Hono<AppEnv>();

// Free-form setup is only available on an explicitly enabled local dev server.
function localSetup(c: Context<AppEnv>): boolean {
  return c.env.OWNER_SETUP_DISABLED === "false" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname);
}
function initialPassword(c: Context<AppEnv>): string | null {
  const result = setupSchema.safeParse({ password: c.env.INITIAL_OWNER_PASSWORD });
  return result.success ? result.data.password : null;
}
async function beginAttempt(c: Context<AppEnv>) {
  // Reserve a slot atomically, including malformed requests and simultaneous attempts.
  if (!await recordLoginAttempt(c, false)) {
    const limit = await checkLoginRateLimit(c);
    c.header("Retry-After", String(Math.max(1, limit.retryAfter)));
    throw new ApiError(429, "TOO_MANY_ATTEMPTS", "ログイン試行が多すぎます。しばらく待ってからお試しください。");
  }
}

authRoutes.get("/status", async (c) => {
  const owner = await getOwner(c.env);
  const session = owner.exists ? await readSession(c) : null;
  const setupAllowed = localSetup(c);
  return c.json({
    setupRequired: !owner.exists && setupAllowed,
    setupDisabled: !owner.exists && !setupAllowed && !initialPassword(c),
    initialPasswordRequired: !owner.exists && Boolean(initialPassword(c)),
    authenticated: Boolean(session),
    appName: c.env.APP_NAME ?? "GlossFrame",
    sessionExpiresAt: session?.expiresAt ?? null,
  });
});

authRoutes.post("/setup", async (c) => {
  if (!localSetup(c)) {
    throw new ApiError(403, "SETUP_DISABLED", "このアプリは所有者専用です。設定済みのパスワードで開いてください。");
  }
  const owner = await getOwner(c.env);
  if (owner.exists) {
    throw new ApiError(409, "ALREADY_SETUP", "このインスタンスは既にセットアップ済みです。");
  }
  await beginAttempt(c);
  const body = await parseBody(c, setupSchema);
  try {
    await createOwner(c.env, body.password);
  } catch (error) {
    const again = await getOwner(c.env);
    if (again.exists) {
      throw new ApiError(409, "ALREADY_SETUP", "このインスタンスは既にセットアップ済みです。");
    }
    throw error;
  }
  await createSession(c, {
    userAgent: c.req.header("user-agent"),
    ip: clientIp(c),
  });
  return c.json({ ok: true });
});

authRoutes.post("/login", async (c) => {
  await beginAttempt(c);
  const body = await parseBody(c, loginSchema);
  let owner = await getOwner(c.env);
  if (!owner.exists) {
    const initial = initialPassword(c);
    if (!initial) {
      throw new ApiError(403, "SETUP_DISABLED", "初期パスワードが未設定です。管理者がCloudflareのSecretを確認してください。");
    }
    const ok = timingSafeEqual(await sha256Hex(body.password), await sha256Hex(initial));
    if (!ok) throw new ApiError(401, "INVALID_PASSWORD", "パスワードが違います。");
    try {
      await createOwner(c.env, body.password);
    } catch (error) {
      // A concurrent first login may have won the singleton INSERT. Never overwrite it.
      if (!(await getOwner(c.env)).exists) throw error;
    }
    owner = await getOwner(c.env);
  }
  const ok = await verifyPassword(body.password, owner.passwordHash ?? "", owner.salt ?? "", owner.iterations ?? 100_000);
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    throw new ApiError(401, "INVALID_PASSWORD", "パスワードが違います。");
  }
  await recordLoginAttempt(c, true);
  await createSession(c, {
    userAgent: c.req.header("user-agent"),
    ip: clientIp(c),
  }, owner.passwordHash);
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  await clearSession(c);
  return c.json({ ok: true });
});

authRoutes.post("/password", requireAuth(), async (c) => {
  const body = await parseBody(c, changePasswordSchema);
  const owner = await getOwner(c.env);
  if (!owner.exists) {
    throw new ApiError(409, "SETUP_REQUIRED", "初期設定が完了していません。");
  }
  const ok = await verifyPassword(
    body.currentPassword,
    owner.passwordHash ?? "",
    owner.salt ?? "",
    owner.iterations ?? 100_000,
  );
  if (!ok) {
    throw new ApiError(401, "INVALID_PASSWORD", "現在のパスワードが違います。");
  }
  await updateOwnerPassword(c.env, body.newPassword);
  const session = c.get("session");
  await deleteOtherSessions(c, session.id);
  return c.json({ ok: true });
});

// Dashboard-controlled, one-use recovery. INITIAL_OWNER_PASSWORD never resets an owner.
authRoutes.post("/recover", async (c) => {
  await beginAttempt(c);
  const body = await parseBody(c, recoverySchema);
  const secret = c.env.OWNER_RECOVERY_TOKEN;
  if (!secret || secret.length < 32 || secret.length > 200 ||
      !timingSafeEqual(await sha256Hex(body.token), await sha256Hex(secret))) {
    throw new ApiError(401, "INVALID_RECOVERY", "復旧キーを確認してください。");
  }
  if (!(await getOwner(c.env)).exists) throw new ApiError(409, "SETUP_REQUIRED", "所有者が未登録です。");
  const tokenHash = await sha256Hex(secret);
  const stored = await hashPassword(body.newPassword);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO used_recovery_tokens (token_hash, used_at) VALUES (?, ?)").bind(tokenHash, Date.now()),
      c.env.DB.prepare("UPDATE owner SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE id = 1")
        .bind(stored.hash, stored.salt, stored.iterations, Date.now()),
      c.env.DB.prepare("DELETE FROM sessions"),
    ]);
  } catch (error) {
    if (await c.env.DB.prepare("SELECT token_hash FROM used_recovery_tokens WHERE token_hash = ?").bind(tokenHash).first()) {
      throw new ApiError(409, "RECOVERY_USED", "この復旧キーは使用済みです。Cloudflareで新しいキーを設定してください。");
    }
    throw error;
  }
  await recordLoginAttempt(c, true);
  return c.json({ ok: true });
});
