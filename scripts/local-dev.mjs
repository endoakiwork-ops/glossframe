import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
function launch(bin, args) {
  const child = spawn(path.join(root, 'node_modules/.bin', bin), args, { stdio: 'inherit', env: process.env });
  children.add(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', () => children.delete(child));
  return child;
}
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = launch(bin, args);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${bin} exited: ${code}`)));
  });
}
async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`ポート ${port} が使用中です。既存の開発サーバーを終了してください。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
try {
  await assertFree(5173);
  await assertFree(8787);
  let config = 'wrangler.local.jsonc';
  if (process.argv.includes('--offline')) {
    const local = JSON.parse(await readFile(config, 'utf8'));
    delete local.ai;
    local.main = '../src/worker/index.ts';
    local.assets.directory = '../dist/client';
    local.d1_databases[0].migrations_dir = '../migrations';
    await mkdir('.local-work', { recursive: true });
    config = '.local-work/wrangler.offline.json';
    await writeFile(config, JSON.stringify(local, null, 2));
  }
  await run('wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', '.wrangler/local-app']);
  await run('vite', ['build']);
  if (stopping) process.exit();
  const worker = launch('wrangler', ['dev', '--config', config, '--ip', '127.0.0.1', '--port', '8787', '--persist-to', '.wrangler/local-app', '--var', 'OWNER_SETUP_DISABLED:false']);
  worker.on('exit', code => { if (!stopping) stop(code || 1); });
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for Wrangler to initialize bindings. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('APIサーバーを起動できませんでした。上のWranglerエラーを確認してください。');
  const vite = launch('vite', ['--host', '127.0.0.1', '--port', '5173', '--strictPort']);
  vite.on('exit', code => { if (!stopping) stop(code || 1); });
  console.log('\nGlossFrame: http://127.0.0.1:5173\n保存先: このPCの .wrangler/local-app（本番DBとは別）\n終了: Ctrl+C\n');
} catch (error) {
  console.error(error.message);
  stop(1);
}
