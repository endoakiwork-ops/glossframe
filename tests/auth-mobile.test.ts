/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import app from '../src/worker/index';
import { createOwner, createSession, updateOwnerPassword } from '../src/worker/auth';
import { Hono } from 'hono';
import type { AppEnv, Env } from '../src/worker/env';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const initial = 'initial test password';
const token = 'one-use-test-recovery-key-1234567890';
function setup(secret: string | undefined = initial) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  function prepare(sql: string) {
    let values: SQLInputValue[] = [];
    return {
      bind(...args: SQLInputValue[]) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      execute() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
      async run() { return this.execute(); },
    };
  }
  const DB = { prepare, async batch(statements: Array<ReturnType<typeof prepare>>) {
    sqlite.exec('BEGIN');
    try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const env = { DB, INITIAL_OWNER_PASSWORD: secret, OWNER_SETUP_DISABLED: 'true', OWNER_RECOVERY_TOKEN: token } as Env;
  const request = (path: string, body: unknown, cookie?: string, ip = '192.0.2.1') => app.request(`https://app.example/api/auth/${path}`, {
    method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }, env);
  const count = (table: string) => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  return { sqlite, env, request, count };
}
describe('mobile bootstrap and recovery', () => {
  it('rejects missing, short and oversized secrets, arbitrary setup and wrong passwords', async () => {
    for (const secret of ['', 'short', 'x'.repeat(201)]) {
      const { request, count } = setup(secret);
      expect((await request('login', { password: initial })).status).toBe(403);
      expect(count('owner')).toBe(0);
    }
    const { env, request, count } = setup();
    env.OWNER_SETUP_DISABLED = 'false';
    expect((await request('setup', { password: 'attacker password' })).status).toBe(403);
    expect((await request('login', { password: 'attacker password' })).status).toBe(401);
    expect(count('owner')).toBe(0);
  });
  it('creates one hashed owner during concurrent first login and preserves it on redeployment', async () => {
    const { request, env, sqlite, count } = setup();
    const responses = await Promise.all(Array.from({ length: 4 }, () => request('login', { password: initial })));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200]);
    expect(count('owner')).toBe(1);
    expect(sqlite.prepare('SELECT password_hash FROM owner').get()!.password_hash).not.toBe(initial);
    env.INITIAL_OWNER_PASSWORD = 'replacement initial password';
    expect((await request('login', { password: env.INITIAL_OWNER_PASSWORD })).status).toBe(401);
    expect((await request('login', { password: initial })).status).toBe(200);
    await updateOwnerPassword(env, 'changed password');
    expect((await request('login', { password: initial })).status).toBe(401);
    expect((await request('login', { password: 'changed password' })).status).toBe(200);
    expect(count('owner')).toBe(1);
  });
  it('limits initial attempts including malformed bodies and allows retry after the window', async () => {
    const { request, sqlite, count } = setup();
    for (let n = 0; n < 10; n++) expect((await request('login', {})).status).toBe(400);
    const limited = await request('login', { password: initial });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(count('owner')).toBe(0);
    sqlite.exec('UPDATE auth_attempts SET created_at = 0');
    expect((await request('login', { password: initial })).status).toBe(200);
  });
  it('atomically limits concurrent initial guesses', async () => {
    const { request, count } = setup();
    const responses = await Promise.all(Array.from({ length: 15 }, () => request('login', { password: 'incorrect password' })));
    expect(responses.filter(r => r.status === 401)).toHaveLength(10);
    expect(responses.filter(r => r.status === 429)).toHaveLength(5);
    expect(count('auth_attempts')).toBe(10); expect(count('owner')).toBe(0);
  });
  it('consumes a recovery key once, revokes sessions, keeps learning data and rejects replay', async () => {
    const { request, sqlite, count, env } = setup();
    const login = await request('login', { password: initial });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    sqlite.exec("INSERT INTO words (id,term,normalized_term,meaning,source_lang,target_lang,created_at,updated_at) VALUES ('w','book','book','本','en','ja',0,0)");
    expect((await request('recover', { token: 'incorrect-recovery-key-123456789012', newPassword: 'new password' })).status).toBe(401);
    const results = await Promise.all([1, 2].map(() => request('recover', { token, newPassword: 'new password' })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(count('owner')).toBe(1); expect(count('sessions')).toBe(0); expect(count('words')).toBe(1);
    const status = await app.request('https://app.example/api/auth/status', { headers: { cookie } }, env);
    expect((await status.json() as { authenticated: boolean }).authenticated).toBe(false);
    expect((await request('login', { password: initial })).status).toBe(401);
    expect((await request('login', { password: 'new password' })).status).toBe(200);
    expect((await request('recover', { token, newPassword: 'replay password' })).status).toBe(409);
    expect((await request('login', { password: 'new password' })).status).toBe(200);
    env.OWNER_RECOVERY_TOKEN = 'another-unique-recovery-key-123456789';
    expect((await request('recover', { token: env.OWNER_RECOVERY_TOKEN, newPassword: 'second password' })).status).toBe(200);
  });
  it('rolls back token consumption and session deletion if recovery fails', async () => {
    const { request, sqlite, count } = setup();
    await request('login', { password: initial });
    sqlite.exec("CREATE TRIGGER fail_reset BEFORE UPDATE ON owner BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    expect((await request('recover', { token, newPassword: 'new password' })).status).toBe(500);
    expect(count('used_recovery_tokens')).toBe(0); expect(count('sessions')).toBe(1);
    sqlite.exec('DROP TRIGGER fail_reset');
    expect((await request('recover', { token, newPassword: 'new password' })).status).toBe(200);
  });
  it('does not issue sessions for a password verified before a concurrent reset', async () => {
    const { env, sqlite, count } = setup();
    await createOwner(env, initial);
    const oldHash = sqlite.prepare('SELECT password_hash FROM owner').get()!.password_hash as string;
    await updateOwnerPassword(env, 'changed password');
    const testApp = new Hono<AppEnv>();
    testApp.get('/', async c => { await createSession(c, {}, oldHash); return c.text('ok'); });
    testApp.onError((_error, c) => c.text('rejected', 401));
    expect((await testApp.request('https://app.example/', {}, env)).status).toBe(401);
    expect(count('sessions')).toBe(0);
  });
  it('does not create owners via recovery or accept cross-origin recovery', async () => {
    const { env, request, count } = setup();
    expect((await request('recover', { token, newPassword: 'new password' })).status).toBe(409);
    const response = await app.request('https://app.example/api/auth/recover', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify({ token, newPassword: 'new password' }) }, env);
    expect(response.status).toBe(403); expect(count('owner')).toBe(0);
  });
});
