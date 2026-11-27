import type { Pool, PoolClient } from 'pg';
import { base58 } from '@scure/base';
import { keccak256 } from 'ethers';
import { validSolOwner } from '../chains/receive.js';
import { SweepStop, sweepReasons, type SignedSweep, type SweepAdapter, type SweepChain,
  type SweepIntent, type SweepReason } from './types.js';

const feeCeiling: Record<SweepChain, bigint> = {
  ETH: 10_000_000_000_000_000n, BSC: 600_000_000_000_000n, POL: 60_000_000_000_000_000n, SOL: 50_000n,
};
// Even many valid small token deposits cannot spend an unlimited gas reserve.
// Reserve a whole per-job ceiling before signing; count actual gross subsidies once finalized.
const dailySponsorCeilings = 10n;
const terms = `deposit_id,journal_id,address_id,chain_id,asset_id,source,sponsor,key_id,deriv_index,amount,
  deposit_txid,deposit_index,deposit_block,deposit_block_hash,required_conf`;
type JobStatus = 'queued' | 'sponsor_signed' | 'sponsor_pending' | 'sponsored' | 'sweep_signed' |
  'sweep_pending' | 'completed' | 'review' | 'dust';
type Job = {
  id: string; deposit_id: string; journal_id: string; address_id: string; chain_id: SweepChain; asset_id: string;
  source: string; destination: string; sponsor: string | null; key_id: string; deriv_index: string;
  amount: string; deposit_txid: string; deposit_index: number; deposit_block: string; deposit_block_hash: string;
  required_conf: number; finality_conf: number; status: JobStatus; stale: boolean;
};
type Step = {
  phase: SignedSweep['phase']; chain_id: SweepChain; txid: string; raw: Buffer; signer: string; amount: string;
  fee: string; nonce: string | null; last_valid_block_height: string | null; block_number: string | null;
  block_hash: string | null; finalized_at: Date | null; attempts: number; stale: boolean;
};
function signed(row: Step): SignedSweep {
  return Object.freeze({ phase: row.phase, txid: row.txid, raw: row.chain_id === 'SOL' ? row.raw.toString('base64') : '0x' + row.raw.toString('hex'),
    from: row.signer, amount: BigInt(row.amount), fee: BigInt(row.fee), nonce: row.nonce,
    lastValidBlockHeight: row.last_valid_block_height === null ? null : Number(row.last_valid_block_height) });
}
function requireThat(value: unknown, reason: SweepReason): asserts value { if (!value) throw new SweepStop(reason); }
async function rpc<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; } catch (err) {
    throw err instanceof SweepStop && sweepReasons.includes(err.code) ? err : new SweepStop('unavailable');
  }
}
function checkedBytes(i: SweepIntent, s: SignedSweep, sponsor: SignedSweep | null): Buffer {
  const token = i.assetId.startsWith('USDT.'), cap = feeCeiling[i.chainId];
  requireThat(s.phase === (token && !sponsor ? 'sponsor' : 'sweep') && s.from === (s.phase === 'sponsor' ? i.sponsor : i.source), 'invalid_intent');
  requireThat(typeof s.amount === 'bigint' && s.amount > 0n && typeof s.fee === 'bigint' && s.fee > 0n && s.fee <= cap, 'fee_limit');
  if (s.phase === 'sponsor') requireThat(s.amount + s.fee <= cap, 'fee_limit');
  else if (token) requireThat(s.amount === i.amount && sponsor && s.fee <= sponsor.amount, 'invalid_intent');
  else requireThat(i.chainId === 'SOL' ? s.amount + s.fee <= i.amount : s.amount + s.fee === i.amount, 'invalid_intent');
  requireThat(typeof s.raw === 'string' && s.raw.length <= 8194, 'invalid_intent');
  if (i.chainId === 'SOL') {
    const raw = Buffer.from(s.raw, 'base64');
    requireThat(s.nonce === null && Number.isSafeInteger(s.lastValidBlockHeight) && s.lastValidBlockHeight! > 0 &&
      raw.length > 65 && raw.length <= 1232 && raw[0] === 1 && raw.toString('base64') === s.raw &&
      base58.encode(raw.subarray(1, 65)) === s.txid, 'invalid_intent');
    return raw;
  }
  requireThat(s.lastValidBlockHeight === null && typeof s.nonce === 'string' && /^(0|[1-9]\d{0,19})$/.test(s.nonce) &&
    /^0x(?:[0-9a-f]{2})+$/.test(s.raw) && keccak256(s.raw) === s.txid, 'invalid_intent');
  return Buffer.from(s.raw.slice(2), 'hex');
}

/** One call advances at most one durable boundary. No externally supplied deposit, amount, destination or transaction. */
export class SweepEngine {
  constructor(private readonly pool: Pool, private readonly retryMs = 15_000) {}

  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (error) { await c.query('rollback').catch(() => {}); throw error; }
    finally { c.release(); }
  }

  async enqueue(chain: SweepChain): Promise<number> {
    return this.transaction(async c => {
      const network = (await c.query<{ destination: string }>(`select destination from custody_sweep_networks
        where chain_id=$1 and sweeps_enabled for share`, [chain])).rows[0];
      if (!network) return 0;
      const r = await c.query(`insert into custody_sweep_jobs(${terms},destination,finality_conf)
        select ${terms},$2,greatest(v.required_conf,v.network_conf) from custody_sweep_credits v where chain_id=$1 and key_ready and route_enabled and amount>=minimum
        and not exists(select 1 from custody_sweep_jobs j where j.deposit_id=v.deposit_id)
        order by deposit_id limit 64 on conflict do nothing`, [chain, network.destination]);
      return r.rowCount ?? 0;
    });
  }

  /** Separate pool read, never sees the caller's uncommitted signature. Used by the actual broadcast adapters. */
  async readCommittedStep(jobId: string, phase: SignedSweep['phase']): Promise<SignedSweep | null> {
    const r = (await this.pool.query<Step>('select * from custody_sweep_steps where job_id=$1 and phase=$2', [jobId, phase])).rows[0];
    return r ? signed(r) : null;
  }

  async advance(chain: SweepChain, adapter: SweepAdapter): Promise<SweepReason | null> {
    return this.transaction(async c => {
      const net = (await c.query<{ destination: string | null; sweeps_enabled: boolean }>(
        'select destination,sweeps_enabled from custody_sweep_networks where chain_id=$1 for share', [chain])).rows[0];
      if (!net) return null;
      // Review intentionally fences every later job from the same source. SKIP LOCKED
      // applies only to the job, not to its place in this per-source ordering.
      const j = (await c.query<Job>(`select j.*,j.created_at<clock_timestamp()-interval '24 hours' as stale from custody_sweep_jobs j where j.chain_id=$1
        and j.status not in ('completed','review','dust') and j.next_check_at<=clock_timestamp()
        and ($2 or exists(select 1 from custody_sweep_steps s where s.job_id=j.id and s.finalized_at is null))
        and (j.status<>'queued' or j.asset_id not in ('USDT.ERC20','USDT.BEP20','USDT.POL') or not exists(select 1 from custody_sweep_steps s
          where s.chain_id=j.chain_id and s.phase='sponsor' and s.finalized_at is null))
        and (j.status<>'queued' or not exists(select 1 from custody_sweep_jobs x where x.chain_id=j.chain_id and x.source=j.source and x.id<>j.id
          and x.status not in ('completed','dust') and (x.status<>'queued' or x.id<j.id)))
        order by (j.status not in ('sponsor_signed','sweep_signed','sponsored','sponsor_pending')),j.next_check_at,j.id
        limit 1 for update of j skip locked`, [chain, net.sweeps_enabled])).rows[0];
      if (!j) return null;
      const lock = async (role: string, key: string) => (await c.query<{ ok: boolean }>(
        'select pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) as ok', ['custody:' + role + ':' + chain, key])).rows[0]!.ok;
      if (!await lock('source', j.source)) return null;
      const state = async (status: JobStatus, reason: SweepReason | null = null, delay = this.retryMs) => {
        await c.query(`update custody_sweep_jobs set status=$2,last_error=$3,updated_at=clock_timestamp(),
          completed_at=case when $2='completed' then clock_timestamp() end,
          next_check_at=clock_timestamp()+$4::int*interval '1 millisecond' where id=$1`, [j.id, status, reason, delay]);
        return reason;
      };
      const rows = (await c.query<Step>(`select *,created_at<clock_timestamp()-interval '24 hours' as stale
        from custody_sweep_steps where job_id=$1 order by phase`, [j.id])).rows;
      const funding = rows.find(s => s.phase === 'sponsor'), payment = rows.find(s => s.phase === 'sweep');
      const current = payment ?? (!funding?.finalized_at ? funding : undefined);
      try {
        // Hold the credited observation and assignment stable through this decision.
        await c.query(`select d.id from deposits d join deposit_addresses a on a.id=$2 join assets t on t.id=d.asset_id
          where d.id=$1 for share of d,a,t`, [j.deposit_id, j.address_id]);
        const same = terms.split(',').map(k => `v.${k.trim()} is not distinct from j.${k.trim()}`).join(' and ');
        const credit = (await c.query<{ key_ready: boolean; route_enabled: boolean; minimum: string; network_conf: number }>(`select v.key_ready,v.route_enabled,v.minimum,v.network_conf
          from custody_sweep_credits v join custody_sweep_jobs j on ${same} where j.id=$1`, [j.id])).rows[0];
        requireThat(credit, 'unowned');
        requireThat(net.destination === j.destination && j.destination !== j.source && j.sponsor !== j.destination &&
          (chain !== 'SOL' || validSolOwner(j.destination)), 'invalid_intent');
        const i: SweepIntent = Object.freeze({ jobId: j.id, depositId: j.deposit_id, chainId: j.chain_id, source: j.source,
          destination: j.destination, sponsor: j.sponsor, assetId: j.asset_id, keyId: j.key_id, derivIndex: Number(j.deriv_index),
          amount: BigInt(j.amount), depositTxid: j.deposit_txid, depositIndex: j.deposit_index, depositBlock: Number(j.deposit_block),
          depositBlockHash: j.deposit_block_hash, requiredConf: Math.max(j.finality_conf, credit.network_conf) });
        requireThat(Number.isSafeInteger(i.depositBlock) && Number.isSafeInteger(i.derivIndex), 'invalid_intent');
        const enabled = net.sweeps_enabled && credit.route_enabled && credit.key_ready;
        if (!current && !enabled) return state(j.status);
        if (!current && !funding && i.assetId.startsWith('USDT.')) {
          if (!await lock('sponsor', i.sponsor!) || (await c.query(`select 1 from custody_sweep_steps
            where chain_id=$1 and phase='sponsor' and finalized_at is null`, [chain])).rowCount) return state(j.status);
          const spend = (await c.query<{ gross: string }>(`select coalesce(sum(amount+fee),0) as gross from custody_sweep_steps
            where chain_id=$1 and phase='sponsor' and finalized_at>clock_timestamp()-interval '24 hours'`, [chain])).rows[0]!.gross;
          if (BigInt(spend) + feeCeiling[chain] > feeCeiling[chain] * dailySponsorCeilings) return state(j.status, 'fee_limit', 60_000);
        }
        await rpc(adapter.verifyDeposit(i));
        let sponsor: SignedSweep | null = null;
        if (funding?.finalized_at) {
          sponsor = signed(funding);
          const obs = await rpc(adapter.inspect(i, sponsor));
          if (obs.state === 'review') return state('review', obs.reason);
          requireThat(obs.state === 'final' && obs.blockHash === funding.block_hash && obs.blockNumber === Number(funding.block_number), 'orphaned');
        }
        if (!current) {
          requireThat(i.amount >= BigInt(credit.minimum), 'dust');
          const s = Object.freeze({ ...await rpc(adapter.prepare(i, sponsor)) });
          const bytes = checkedBytes(i, s, sponsor);
          if (s.nonce !== null) {
            // Dedicated managed keys have no other legitimate outbound workflow.
            // A skipped nonce is foreign activity, not permission to spend a later deposit.
            const next = (await c.query<{ nonce: string }>(`select (coalesce(max(nonce),-1)+1)::text as nonce from custody_sweep_steps
              where chain_id=$1 and signer=$2 and finalized_at is not null`, [chain, s.from])).rows[0]!.nonce;
            requireThat(s.nonce === next, 'nonce_conflict');
          }
          const inserted = await c.query(`insert into custody_sweep_steps(job_id,chain_id,phase,txid,raw,signer,amount,fee,nonce,last_valid_block_height)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
          [j.id, chain, s.phase, s.txid, bytes, s.from, s.amount.toString(), s.fee.toString(), s.nonce, s.lastValidBlockHeight]);
          requireThat(inserted.rowCount === 1, 'nonce_conflict');
          // Crucially, return and COMMIT. Never broadcast or call prepare again in this transaction.
          return state(s.phase === 'sponsor' ? 'sponsor_signed' : 'sweep_signed', null, 0);
        }
        const s = signed(current);
        checkedBytes(i, s, sponsor);
        const obs = await rpc(adapter.inspect(i, s));
        if (obs.state === 'review') return state('review', obs.reason);
        if (current.block_hash !== null) requireThat((obs.state === 'included' || obs.state === 'final') &&
          obs.blockHash === current.block_hash && obs.blockNumber === Number(current.block_number), 'orphaned');
        if (obs.state === 'included' || obs.state === 'final') {
          requireThat(typeof obs.blockHash === 'string' && obs.blockHash.length > 0 && obs.blockHash.length <= 128 &&
            Number.isSafeInteger(obs.blockNumber) && obs.blockNumber >= 0, 'invalid_receipt');
          await c.query(`update custody_sweep_steps set block_number=$3,block_hash=$4,
            finalized_at=case when $5 then clock_timestamp() end where job_id=$1 and phase=$2`,
          [j.id, s.phase, obs.blockNumber, obs.blockHash, obs.state === 'final']);
          if (obs.state === 'final') return state(s.phase === 'sponsor' ? 'sponsored' : 'completed', null, 0);
          if (current.stale) return state('review', 'not_final');
        } else if (obs.state === 'unseen' && enabled) {
          requireThat(i.amount >= BigInt(credit.minimum), 'dust');
          requireThat(current.attempts < 12 && !current.stale, 'ambiguous');
          // If a crash rolls this transaction back after acceptance, the signed row
          // already exists. The next replica checks the receipt before an exact replay.
          await c.query('update custody_sweep_steps set attempts=attempts+1 where job_id=$1 and phase=$2', [j.id, s.phase]);
          await rpc(adapter.broadcast(i, s));
        } else if (obs.state === 'pending' && current.stale) return state('review', 'ambiguous');
        return state(s.phase === 'sponsor' ? 'sponsor_pending' : 'sweep_pending');
      } catch (err) {
        if (!(err instanceof SweepStop)) throw err; // Database failure rolls back, never implies a failed on-chain send.
        const retry = ['fee_limit','not_final','unavailable'].includes(err.code) ||
          (err.code === 'insufficient_funds' && j.asset_id.startsWith('USDT.') && !funding?.finalized_at);
        if (retry && !(current ?? funding)?.stale && !(j.stale && err.code === 'not_final')) return state(j.status, err.code);
        return state(err.code === 'dust' && !rows.length ? 'dust' : 'review', err.code);
      }
    });
  }
}
