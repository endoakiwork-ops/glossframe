import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { runJsonModel } from '../src/worker/ai';
import type { Env } from '../src/worker/env';

function environment(responses: string[]) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const cache = new Map<string, string>();
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { args = values; return statement; },
      first: async () => sql.includes('ai_cache') && cache.has(String(args[0])) ? { value: cache.get(String(args[0])) } : null,
      run: async () => { writes.push({ sql, args }); if (sql.includes('INSERT INTO ai_cache')) cache.set(String(args[0]), String(args[2])); return {}; },
    };
    return statement;
  };
  const run = vi.fn(async () => ({ response: responses.shift() ?? '{"answer":"ok"}', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  return { env: { DB: { prepare }, AI: { run }, DEFAULT_MODEL: 'model-a', FALLBACK_MODEL: 'model-a' } as unknown as Env, writes, run };
}
const options = { kind: 'test', system: 'Return JSON.', user: 'hello', schema: z.object({ answer: z.string() }) };

describe('AI cache and usage', () => {
  it('reuses validated answers but isolates a changed model', async () => {
    const { env, run } = environment([]);
    expect((await runJsonModel(env, options)).cached).toBe(false);
    expect((await runJsonModel(env, options)).cached).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    env.DEFAULT_MODEL = 'model-b';
    expect((await runJsonModel(env, options)).cached).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('counts invalid AI responses as usage before retrying', async () => {
    const { env, writes, run } = environment(['{"wrong":true}', '{"answer":"ok"}']);
    expect((await runJsonModel(env, options)).value.answer).toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(writes.filter(write => write.sql.includes('INSERT INTO ai_usage'))).toHaveLength(2);
  });
});
