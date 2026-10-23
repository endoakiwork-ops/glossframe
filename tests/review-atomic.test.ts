/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { recordReview } from '../src/worker/review';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of ['0001_init.sql', '0002_learning_tracks.sql']) sqlite.exec(readFileSync(new NodeURL(`../migrations/${file}`, import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO words (id,term,normalized_term,meaning,source_lang,target_lang,created_at,updated_at) VALUES ('w','break','break','休憩','en','ja',0,0)");
  function prepare(sql: string) {
    let values: SQLInputValue[] = [];
    return {
      bind(...args: SQLInputValue[]) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
    };
  }
  const db = { prepare, async batch(statements: Array<ReturnType<typeof prepare>>) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const row = () => sqlite.prepare("SELECT * FROM words WHERE id='w'").get()!;
  const base = {wordId:'w',mode:'recall' as const,rating:'known' as const,assisted:false,retry:false,targetCount:3,intervalDays:7,now:Date.parse('2026-10-22T14:59:00Z')};
  return {db, sqlite, row, base};
}
describe('atomic review storage', () => {
  it('deduplicates a replay, limits each track daily, and preserves both tracks', async () => {
    const {db, row, base, sqlite} = setup();
    expect(await recordReview(db,{...base,requestId:'a'})).toEqual({applied:true,gained:true});
    expect(await recordReview(db,{...base,requestId:'a'})).toEqual({applied:false,gained:true});
    await recordReview(db,{...base,requestId:'b'});
    await recordReview(db,{...base,mode:'card',requestId:'c'});
    expect(row().known_count).toBe(1); expect(row().recall_count).toBe(1);
    expect(sqlite.prepare('SELECT SUM(gained) AS n FROM review_events').get()?.n).toBe(2);
  });
  it('uses the Japan midnight boundary and retains attained rank after failure', async () => {
    const {db,row,base}=setup();
    await recordReview(db,{...base,requestId:'a'});
    await recordReview(db,{...base,requestId:'b',now:Date.parse('2026-10-22T15:01:00Z')});
    await recordReview(db,{...base,requestId:'c',now:Date.parse('2026-10-23T15:01:00Z')});
    expect(row().recall_count).toBe(3); expect(row().mastered).toBe(1); expect(row().known_count).toBe(0);
    await recordReview(db,{...base,requestId:'d',rating:'unknown',now:Date.parse('2026-10-24T15:01:00Z')});
    expect(row().recall_count).toBe(3); expect(row().mastered).toBe(1);
  });
  it('keeps a missed word due after a successful retry', async () => {
    const {db,row,base}=setup();
    await recordReview(db,{...base,requestId:'miss',rating:'unknown'});
    const due = row().next_review_at;
    await recordReview(db,{...base,requestId:'retry',retry:true,now:base.now+1000});
    expect(row().next_review_at).toBe(due);
    expect(row().recall_count).toBe(0);
  });
});
