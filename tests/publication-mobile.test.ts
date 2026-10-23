/// <reference types="node" />
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function check(repository: string, config: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'gf-publication-')); dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  copyFileSync('scripts/check-public.mjs', join(cwd, 'check-public.mjs'));
  writeFileSync(join(cwd, 'wrangler.toml'), config);
  return spawnSync(process.execPath, ['check-public.mjs'], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: repository } });
}
it('rejects author resource IDs but accepts provisioned recipient IDs', () => {
  const config = '[[d1_databases]]\ndatabase_id = "11111111-1111-1111-1111-111111111111"\n';
  expect(check('edoaki/glossframe', config).status).toBe(1);
  expect(check('recipient/glossframe', config).status).toBe(0);
});
it('still rejects embedded secrets and account IDs in recipient configuration', () => {
  for (const name of ['INITIAL_OWNER_PASSWORD', 'OWNER_RECOVERY_TOKEN', 'CF_ANALYTICS_TOKEN', 'account_id']) {
    expect(check('recipient/glossframe', `${name} = "not-a-real-value"\n`).status).toBe(1);
  }
});
