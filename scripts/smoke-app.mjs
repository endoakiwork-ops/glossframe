import {chromium} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';

const root=path.resolve(import.meta.dirname,'..');
process.chdir(root);
const liveAi=process.argv.includes('--ai');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dir=path.join(root,'.local-work','smoke-'+stamp);
await fs.mkdir(dir,{recursive:true});
const config=JSON.parse(await fs.readFile('wrangler.local.example.jsonc','utf8'));
config.main='../../src/worker/index.ts';
config.assets.directory='../../dist/client';
config.d1_databases[0].migrations_dir='../../migrations';
config.name='glossframe-smoke';
if(!liveAi)delete config.ai;
const configPath=path.join(dir,'wrangler.json');
await fs.writeFile(configPath,JSON.stringify(config,null,2));
const bin=path.join(root,'node_modules/.bin/wrangler');
const common=['--config',configPath,'--persist-to',path.join(dir,'state')];
execFileSync(bin,['d1','migrations','apply','DB','--local',...common],{stdio:'pipe'});
const probe=createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const worker=spawn(bin,['dev','--ip','127.0.0.1','--port',String(port),...common],{stdio:['ignore','pipe','pipe']});
const log=await fs.open(path.join(dir,'worker.log'),'w',0o600);
worker.stdout.on('data',chunk=>log.write(chunk));
worker.stderr.on('data',chunk=>log.write(chunk));
const report={liveAi,checks:[],modelRequests:[],events:[]};
let browser;
const assert=(value,name)=>{if(!value)throw new Error(name);report.checks.push(name);};
try{
 let ready=false;
 for(let i=0;i<120;i++){
  try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert(ready,'isolated worker ready');
 assert((await fetch(origin+'/api/translations')).status===401,'anonymous history denied');
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.addInitScript(()=>{
  const original=window.fetch.bind(window);
  window.fetch=async (...args)=>{
   const response=await original(...args);
   if(typeof args[0]==='string'&&args[0].endsWith('/api/translate/regions')){
    response.clone().text().then(raw=>{window.__translation={raw,status:response.status};});
   }
   return response;
  };
 });
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let phase='first';
 page.on('response',res=>{
  if(res.url().includes('/models/ocr/')) report.modelRequests.push({phase,file:res.url().split('/').at(-1),fromServiceWorker:res.fromServiceWorker(),status:res.status()});
 });
 await page.goto(origin);
 const password=randomBytes(24).toString('base64url');
 await page.locator('#password').fill(password);
 await page.locator('#confirm').fill(password);
 await page.locator('button[type=submit]').click();
 await page.getByLabel('画像を選択',{exact:true}).waitFor({state:'attached',timeout:30000});
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await page.waitForFunction(async()=>{
  const c=await caches.open('paddle-v5-en-int8-v1');
  return (await c.keys()).filter(r=>!r.url.endsWith('manifest.json')).length>=5;
 },{},{timeout:120000});
 assert(true,'login and model cache ready');
 await page.screenshot({path:path.join(dir,'01-ready.png')});
 const image=await page.evaluate(()=>{
  const c=document.createElement('canvas');c.width=1000;c.height=600;
  const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);
  x.fillStyle='black';x.font='bold 52px sans-serif';
  x.fillText('Garden Guide',100,170);x.fillText('Our garden is quiet.',100,290);
  return c.toDataURL('image/png').split(',')[1];
 });
 const imagePath=path.join(dir,'authored-input.png');
 await fs.writeFile(imagePath,Buffer.from(image,'base64'));
 const started=Date.now();

 await page.getByLabel('画像を選択',{exact:true}).setInputFiles(imagePath);
 await page.locator('.tv-region').first().waitFor({state:'visible',timeout:120000});
 await page.screenshot({path:path.join(dir,'02-ocr.png')});
 await page.waitForFunction(()=>window.__translation,{}, {timeout:120000});
 const response=await page.evaluate(()=>window.__translation);
 const raw=response.raw;
 if(liveAi){
  const events=raw.trim().split('\n').map(line=>JSON.parse(line));
  report.events=events.map(e=>({type:e.type,count:e.regions?.length}));
  const result=events.find(e=>e.type==='complete')?.result;
  assert(Boolean(result?.id),'real AI translation completed');
  report.recognized=result.regions.map(r=>({source:r.originalSource,translation:r.translation}));
  assert(result.regions.length===2,'title and sentence stay in two regions');
  assert(result.regions.map(r=>r.originalSource).join(' ').includes('Our garden is quiet'),'real browser OCR reads authored text');
  await page.locator('.tv-progress').waitFor({state:'hidden',timeout:15000});
  assert(await page.locator('.tv-region').count()===2,'no duplicated UI boxes');
  await page.screenshot({path:path.join(dir,'03-final.png')});
  const saved=await page.evaluate(async id=>(await fetch('/api/translations/'+id)).json(),result.id);
  assert(saved.sourceText.includes('garden'),'translation saved to local DB');
  report.translation={sourceText:result.sourceText,translatedText:result.translatedText,cached:result.cached};
 }else{
  assert(raw.includes('"type":"error"')||response.status>=400,'unavailable AI reports failure');
  await page.getByRole('alert').waitFor({timeout:15000});
 }
 report.elapsedOcrAndAiMs=Date.now()-started;
 phase='reload';
 await page.goto(origin);
 await page.getByLabel('画像を選択',{exact:true}).waitFor({state:'attached'});
 await page.waitForTimeout(3000);
 assert(!report.modelRequests.some(r=>r.phase==='reload'&&!r.fromServiceWorker&&r.file!=='manifest.json'),'reload avoids network model downloads');
 const logout=await page.evaluate(async()=> (await fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status);
 assert(logout===200,'logout succeeds');
 await page.reload();
 await page.locator('#password').waitFor();
 assert((await page.evaluate(async()=> (await fetch('/api/translations')).status))===401,'logout protects history');
 await page.locator('#password').fill(password);
 await page.locator('button[type=submit]').click();
 await page.getByLabel('画像を選択',{exact:true}).waitFor({state:'attached'});
 assert(true,'password login works after logout');
 assert(errors.length===0,'no browser runtime errors');
 report.passed=true;
 console.log(JSON.stringify({passed:true,liveAi,checks:report.checks,elapsedOcrAndAiMs:report.elapsedOcrAndAiMs}));
}catch(e){
 report.passed=false;report.error=String(e);
 console.error('Smoke test failed:',String(e));process.exitCode=1;
}finally{
 await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
 if(browser)await browser.close();
 worker.kill('SIGTERM');
 await new Promise(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',resolve);setTimeout(resolve,5000);});
 await log.close();
 console.log('Private report:',path.relative(root,dir));
}
