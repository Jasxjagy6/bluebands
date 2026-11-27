import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { pool } from '../db.js';
import { createAlchemyFetch, getRpcConfig } from '../chains/rpc.js';
import { provisionCustodyKeys } from './keys.js';
import { createEvmSweepAdapter } from './evm-sweep.js';
import { createSolSweepAdapter } from './sol-sweep.js';
import { SweepEngine } from './sweep-engine.js';
import { SweepStop, sweepChains, type SweepChain, type SweepReason } from './types.js';

// No server, routes, migration, issuance or ledger access on this entrypoint.
async function run(): Promise<void> {
  if (process.env.NODE_ENV === 'test') throw new Error('Use the isolated sweep adapter fixture');
  const stop = new AbortController();
  const halt = () => stop.abort();
  process.once('SIGTERM', halt); process.once('SIGINT', halt);
  const engine = new SweepEngine(pool);
  const options = { readCommittedStep: engine.readCommittedStep.bind(engine) };
  const health = (chain: SweepChain, status: string, error: SweepReason | null = null) => pool.query(`update custody_worker_health
    set status=$2,last_error=$3,checked_at=clock_timestamp() where chain_id=$1`, [chain, status, error]);
  try {
    while (!stop.signal.aborted) {
      let signer: Awaited<ReturnType<typeof provisionCustodyKeys>> = null;
      try {
        // Provision/refresh the public watch-only metadata even when ALL sweeps are paused.
        signer = await provisionCustodyKeys();
        const key = signer;
        const outcomes = await Promise.allSettled(sweepChains.map(async chain => {
          try {
            if (!key) { await health(chain, 'awaiting_key'); return; }
            const net = (await pool.query(`select sweeps_enabled,exists(select 1 from custody_sweep_steps s
              join custody_sweep_jobs j on j.id=s.job_id where s.chain_id=n.chain_id and s.finalized_at is null
              and j.status not in ('review','dust','completed')) as reconciling from custody_sweep_networks n where n.chain_id=$1`, [chain])).rows[0];
            if (!net?.sweeps_enabled && !net?.reconciling) { await health(chain, 'paused'); return; }
            const endpoint = await getRpcConfig(chain);
            if (!endpoint) { await health(chain, 'awaiting_rpc'); return; }
            const adapterOptions={...options,...(endpoint.provider==='legacy'?{}:{fetch:createAlchemyFetch(endpoint)})};
            const adapter = chain === 'SOL' ? createSolSweepAdapter(endpoint.url, key, adapterOptions) : createEvmSweepAdapter(endpoint.url, key, adapterOptions);
            const check = adapter.verifyDeposit.bind(adapter);
            adapter.verifyDeposit = async intent => {
              if (intent.chainId !== chain || intent.keyId !== key.keyId || (chain === 'SOL'
                ? key.solAddress(intent.derivIndex) !== intent.source
                : key.evmAddress(intent.derivIndex).toLowerCase() !== intent.source || key.feeAddress.toLowerCase() !== intent.sponsor))
                throw new SweepStop('unowned');
              return check(intent);
            };
            await engine.enqueue(chain);
            const reason = await engine.advance(chain, adapter);
            await health(chain, reason ? 'degraded' : net.sweeps_enabled ? 'ready' : 'paused', reason);
          } catch { await health(chain, 'degraded', 'unavailable'); }
        }));
        if (outcomes.some(r => r.status === 'rejected')) console.error('[custody] status storage unavailable');
      } catch {
        await Promise.allSettled(sweepChains.map(chain => health(chain, 'degraded', 'unavailable')));
        console.error('[custody] provisioning unavailable');
      } finally { signer?.destroy(); }
      if (!stop.signal.aborted) await wait(5_000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    process.off('SIGTERM', halt); process.off('SIGINT', halt);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch(() => { console.error('[custody] worker stopped'); process.exitCode = 1; });
}
