// Conservative publication guard. Prints paths/rule names, never matched values.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const staged=process.argv.includes('--staged');
const files=[...new Set(execFileSync('git',['ls-files','-z',...(staged?[]:['--cached','--others','--exclude-standard'])],{encoding:'utf8'}).split('\0').filter(Boolean))];
const problems=[];
// Provisioned IDs identify resources, but grant no access. Only recipient copies may publish them.
let remote = '';
try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch {}
const recipientCopy = process.env.GITHUB_REPOSITORY
 ? process.env.GITHUB_REPOSITORY.toLowerCase() !== 'edoaki/glossframe'
 : /github\.com[:/][^/]+\/[^/]+/.test(remote) && !/github\.com[:/]edoaki\/glossframe(?:\.git)?$/.test(remote);

const forbidden=/(^|\/)(\.private|\.local-work|\.wrangler|node_modules|dist|mock|テスト用データセット|playwright-report|test-results)(\/|$)|(^|\/)(wrangler(?:\.local)?\.jsonc|実装メモ\.md|\.dev\.vars(?:\..*)?|\.env(?:\..*)?)$|\.(?:sqlite3?|db|pem|key|log)$/;
const allowedExamples=new Set(['.dev.vars.example','.env.example']);
const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['cloud-provider-key',/\bAKIA[A-Z0-9]{16}\b/],
 ['personal-path',/\/(?:Users|home)\/[a-zA-Z0-9._-]+\//],
 ['deployment-url',/https:\/\/[a-z0-9.-]+\.(?:workers|pages)\.dev\b/],
 ['embedded-credential',/https?:\/\/[^\s/"']+:[^\s/"']+@/],
];
for(const file of files){
 if(!staged&&!fs.existsSync(file))continue;
 if(forbidden.test(file)&&!allowedExamples.has(file))problems.push([file,'private-path']);
 if(file.startsWith('public/models/'))problems.push([file,'model-binary']);
 if(/\.(png|jpe?g|webp|gif|pdf|zip|tar|gz)$/i.test(file)&&!/^public\/icons\/(apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.png$/.test(file))problems.push([file,'unreviewed-binary']);
 const bytes=staged?execFileSync('git',['show',':'+file],{maxBuffer:10*1024*1024}):fs.readFileSync(file);
 if(bytes.includes(0))continue;
 const text=bytes.toString('utf8');
 for(const [name,pattern] of rules)if(pattern.test(text))problems.push([file,name]);
 if(file === 'wrangler.toml') {
  if(/^\s*account_id\s*=/m.test(text))problems.push([file,'account-id']);
  if(/^\s*(?:INITIAL_OWNER_PASSWORD|OWNER_RECOVERY_TOKEN|CF_ANALYTICS_TOKEN)\s*=/m.test(text))problems.push([file,'secret-in-config']);
  if(!recipientCopy) {
   for(const match of text.matchAll(/^\s*(?:database_id|id)\s*=\s*["']([^"']+)["']/gm)) {
    if(!['00000000-0000-0000-0000-000000000000','00000000000000000000000000000000'].includes(match[1]))problems.push([file,'resource-id']);
   }
  }
 }
 if(/wrangler.*example\.jsonc$/.test(file)){
  const config=JSON.parse(text);
  for(const d of config.d1_databases??[])if(!['00000000-0000-0000-0000-000000000000','local-db'].includes(d.database_id))problems.push([file,'resource-id']);
  for(const k of config.kv_namespaces??[])if(!['00000000000000000000000000000000','local-images'].includes(k.id))problems.push([file,'resource-id']);
  if(config.account_id)problems.push([file,'account-id']);
 }
}
if(problems.length){for(const [path,rule] of problems)console.error(rule+': '+path);process.exit(1);}
console.log('Publication guard passed ('+files.length+' files). Also review history, author identity and third-party rights.');
