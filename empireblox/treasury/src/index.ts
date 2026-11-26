import { config } from './config.js';
import { buildServer } from './api/server.js';
import { startWatchers, superviseWatchers } from './watcher.js';
import { selfTest } from './vault.js';
import { ensureBootstrapAdmin } from './bootstrap.js';

async function main() {
  // Fail fast if the master key can't decrypt — a misconfigured KEK must
  // never silently start the service with an unreadable vault.
  if (!selfTest()) {
    console.error('FATAL: vault self-test failed. Is TREASURY_MASTER_KEY correct?');
    process.exit(1);
  }

  await ensureBootstrapAdmin().catch((e) => console.error('[bootstrap]', (e as Error).message));

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[treasury] API on :${config.port}  ·  admin panel at /admin`);

  await startWatchers();
  superviseWatchers();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
