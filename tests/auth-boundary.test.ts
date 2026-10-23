import { describe, it, expect, vi } from 'vitest';
import app from '../src/worker/index';
import type { Env } from '../src/worker/env';

function environment() {
  const ai = vi.fn(() => { throw new Error('AI must not run'); });
  const prepare = vi.fn(() => { throw new Error('DB must not be accessed'); });
  const get = vi.fn(() => { throw new Error('Images must not be accessed'); });
  const env = { DB: { prepare }, IMAGES: { get }, AI: { run: ai }, OWNER_SETUP_DISABLED: 'true' } as unknown as Env;
  return { env, ai, prepare, get };
}
describe('owner-only API boundary', () => {
  for (const [method, path] of [
    ['POST', '/api/translate'], ['POST', '/api/words/lookup'], ['POST', '/api/words/similar'],
    ['GET', '/api/words'], ['GET', '/api/translations'], ['GET', '/api/settings'],
    ['GET', '/api/backup'], ['GET', '/api/images/private.webp'], ['POST', '/api/images'],
  ]) {
    it(`rejects anonymous ${method} ${path} before using any bindings`, async () => {
      const { env, ai, prepare, get } = environment();
      const response = await app.request('https://app.example' + path, {
        method, headers: { origin: 'https://app.example', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }, env);
      expect(response.status).toBe(401);
      expect(ai).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    });
  }
  it('does not allow an anonymous visitor to claim ownership even when DB is empty', async () => {
    const { env, prepare } = environment();
    const response = await app.request('https://app.example/api/auth/setup', {
      method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'a-long-attacker-password' }),
    }, env);
    expect(response.status).toBe(403); expect(prepare).not.toHaveBeenCalled();
  });
  it('reports setupDisabled: true and setupRequired: false on /api/auth/status when setup is disabled and no owner exists', async () => {
    const prepare = vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(null),
    });
    const env = { DB: { prepare }, OWNER_SETUP_DISABLED: 'true' } as unknown as Env;
    const response = await app.request('https://app.example/api/auth/status', { method: 'GET' }, env);
    expect(response.status).toBe(200);
    const data = await response.json() as { setupRequired: boolean; setupDisabled?: boolean; authenticated: boolean };
    expect(data.setupRequired).toBe(false);
    expect(data.setupDisabled).toBe(true);
    expect(data.authenticated).toBe(false);
  });
  it('rejects cross-origin login requests', async () => {
    const { env, prepare } = environment();
    const response = await app.request('https://app.example/api/auth/login', {
      method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}',
    }, env);
    expect(response.status).toBe(403); expect(prepare).not.toHaveBeenCalled();
  });
});
