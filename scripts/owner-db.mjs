import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Avoid putting password hashes in process arguments or Wrangler console output.
export function ownerQuery(sql, remote) {
  const dir=mkdtempSync(path.join(tmpdir(),'glossframe-owner-'));
  const file=path.join(dir,'query.sql');
  try {
    writeFileSync(file,sql,{mode:0o600});
    const args=['wrangler','d1','execute','DB','--config',remote?'wrangler.jsonc':'wrangler.local.jsonc'];
    args.push(remote?'--remote':'--local');
    if(!remote)args.push('--persist-to','.wrangler/local-app');
    args.push('--file',file,'--json');
    const output=execFileSync('npx',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    return JSON.parse(output);
  } catch {
    throw new Error('所有者DBの操作に失敗しました。設定・接続・マイグレーションを確認してください。');
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
}
