import { ApiError } from "./errors";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env, SessionRecord } from "./env";
import { sha256Hex } from "../shared/text";

export const SESSION_COOKIE = "gf_session";
const DEFAULT_SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64(data).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function derivePassword(
  password: string,
  salt: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: base64ToBytes(salt) as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
  iterations: number;
}> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToBase64(saltBytes);
  const hash = await derivePassword(password, salt, PBKDF2_ITERATIONS);
  return { hash, salt, iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  const derived = await derivePassword(password, salt, iterations);
  return timingSafeEqual(derived, hash);
}

interface OwnerRow {
  password_hash: string;
  salt: string;
  iterations: number;
}

export interface OwnerInfo {
  exists: boolean;
  passwordHash?: string;
  salt?: string;
  iterations?: number;
}

export async function getOwner(env: Env): Promise<OwnerInfo> {
  const row = await env.DB.prepare(
    "SELECT password_hash, salt, iterations FROM owner WHERE id = 1",
  ).first<OwnerRow>();
  if (!row) return { exists: false };
  return {
    exists: true,
    passwordHash: row.password_hash,
    salt: row.salt,
    iterations: row.iterations,
  };
}

export async function createOwner(env: Env, password: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(password);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO owner (id, password_hash, salt, iterations, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
  )
    .bind(hash, salt, iterations, now, now)
    .run();
}

export async function updateOwnerPassword(env: Env, password: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(password);
  await env.DB.prepare(
    "UPDATE owner SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE id = 1",
  )
    .bind(hash, salt, iterations, Date.now())
    .run();
}

function sessionDays(env: Env): number {
  const value = Number(env.SESSION_DAYS ?? DEFAULT_SESSION_DAYS);
  return Number.isFinite(value) && value >= 1 && value <= 365 ? value : DEFAULT_SESSION_DAYS;
}

export async function createSession(
  c: Context<AppEnv>,
  meta: { userAgent?: string; ip?: string },
  expectedPasswordHash?: string,
): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const days = sessionDays(c.env);
  const expiresAt = now + days * 24 * 60 * 60 * 1000;
  const result = await c.env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip_hash)
     SELECT ?, ?, ?, ?, ?, ?, ? FROM owner WHERE id = 1 AND (? IS NULL OR password_hash = ?)`,
  )
    .bind(
      crypto.randomUUID(),
      tokenHash,
      now,
      expiresAt,
      now,
      (meta.userAgent ?? "").slice(0, 300),
      meta.ip ? await sha256Hex(meta.ip) : null,
      expectedPasswordHash ?? null,
      expectedPasswordHash ?? null,
    )
    .run();

  if (!result.meta.changes) {
    throw new ApiError(401, "PASSWORD_CHANGED", "パスワードが変更されました。もう一度ログインしてください。");
  }
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: days * 24 * 60 * 60,
  });
}

interface SessionRow {
  id: string;
  expires_at: number;
  created_at: number;
  last_seen_at: number;
}

export async function readSession(c: Context<AppEnv>): Promise<SessionRecord | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT id, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return null;
  }
  // Slide the session on activity, at most once per hour.
  if (now - row.last_seen_at > 60 * 60 * 1000) {
    const newExpiry = now + sessionDays(c.env) * 86400000;
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .bind(now, newExpiry, row.id)
      .run();
  }
  return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await readSession(c);
    if (!session) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "ログインが必要です。" } },
        401,
      );
    }
    c.set("session", session);
    await next();
  };
}

export async function clearSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function deleteOtherSessions(c: Context<AppEnv>, keepId: string): Promise<void> {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id != ?").bind(keepId).run();
}

export function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}

export async function checkLoginRateLimit(c: Context<AppEnv>): Promise<{
  allowed: boolean;
  retryAfter: number;
}> {
  const ip = clientIp(c);
  const ipHash = await sha256Hex(ip);
  const since = Date.now() - LOGIN_WINDOW_MS;
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM auth_attempts WHERE ip_hash = ? AND created_at > ?",
  )
    .bind(ipHash, since)
    .first<{ c: number; oldest: number | null }>();
  const count = Number(row?.c ?? 0);
  if (count >= LOGIN_MAX_ATTEMPTS) {
    const oldest = Number(row?.oldest ?? Date.now());
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - Date.now()) / 1000)) };
  }
  return { allowed: true, retryAfter: 0 };
}

export async function recordLoginAttempt(c: Context<AppEnv>, success: boolean): Promise<boolean> {
  const ipHash = await sha256Hex(clientIp(c));
  const now = Date.now();
  if (success) {
    await c.env.DB.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).run();
    return true;
  }
  const result = await c.env.DB.prepare(
    `INSERT INTO auth_attempts (id, ip_hash, created_at, success)
     SELECT ?, ?, ?, 0 WHERE
     (SELECT COUNT(*) FROM auth_attempts WHERE ip_hash = ? AND created_at > ?) < ?`,
  )
    .bind(crypto.randomUUID(), ipHash, now, ipHash, now - LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS)
    .run();
  return Number(result.meta.changes) > 0;
}
