// Run the full suite against a disposable, local-only PostgreSQL instance.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
const dir = fileURLToPath(new URL('../../', import.meta.url));
const id = 'empireblox-test-' + randomBytes(5).toString('hex');
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8'});
try {
  docker('run','--rm','-d','--name',id,'-e','POSTGRES_PASSWORD=' + password,
    '-p','127.0.0.1::5432','postgres:16-alpine');
  const port = docker('port',id,'5432/tcp').trim().split(':').pop();
  const env = {...process.env, NODE_ENV:'test', DATABASE_URL:`postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
    TREASURY_MASTER_KEY: randomBytes(32).toString('base64'),PUBLIC_SITE_ORIGIN:'https://payments.test.invalid',ALLOW_ORIGIN:'',COOKIE_SECURE:'false'};
  for (let attempt=0; attempt<100; attempt++) {
    try { docker('exec',id,'pg_isready','-h','127.0.0.1','-U','postgres'); break; }
    catch { if (attempt===99) throw new Error('Test database did not start'); await wait(200); }
  }
  const run = (...args) => execFileSync(process.execPath,args,{cwd:dir,env,stdio:'inherit'});
  run('--import','tsx','src/migrate.ts');
  run('--import','tsx','src/migrate.ts');
  const tests = readdirSync(dir + '/src/test').filter(f => /\.(test|int|browser)\.(ts|mjs)$/.test(f));
  run('--import','tsx','--test','--test-concurrency=1',...tests.map(f => 'src/test/'+f));
} finally { docker('rm','-f',id); }
