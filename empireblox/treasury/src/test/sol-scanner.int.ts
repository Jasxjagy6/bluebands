import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { constants, publicEncrypt, randomBytes, randomUUID, createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { base58 } from '@scure/base';

const runner = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost', '[::1]'].includes(runner.hostname)) throw Error('Disposable local database required');
const admin = new pg.Pool({ connectionString: runner.href }), database = 'sol_scanner_' + randomBytes(8).toString('hex');
const isolated = new URL(runner); isolated.pathname = '/' + database; process.env.DATABASE_URL = isolated.href;
const { pool, query, tx } = await import('../db.js');
const { setSecret } = await import('../vault.js');
const { getOrCreateAddress, submitCustodyEnvelope } = await import('../derive.js');
const { provisionCustodyKeys, restoreCustodyPublic } = await import('../custody/keys.js');
const { NonEvmWatcher } = await import('../chains/non-evm.js');
const { SweepEngine } = await import('../custody/sweep-engine.js');
const temporary = await mkdtemp(join(tmpdir(), 'sol-scanner-fixture-'));
process.env.CUSTODY_KEY_DIR = join(temporary, 'worker');
const seed = Buffer.alloc(32, 61), uid = randomUUID(), other = randomUUID(), SYSTEM = '11111111111111111111111111111111';
const probe = base58.encode(Buffer.alloc(64, 201)), payer = base58.encode(Buffer.alloc(32, 27));
let head = 100, first = 90, firstReported: number | undefined, stale = false, owner = '', secondOwner = '', failSlot = -1;
let pageMode: 'normal' | 'null' | 'empty' | 'missing-err' | 'duplicate' = 'normal', missingMetadata = false, probeUnavailable = false;
const forks = new Map<number, number>(), calls: { method: string; params: any[] }[] = [];
const transactions = new Map<string, { value: any; active: boolean }>();
const hash = (n: number) => base58.encode(createHash('sha256').update(`sol:${n}:${forks.get(n) ?? 0}`).digest());
const watcher = new NonEvmWatcher('SOL');
const state = async () => (await query("select last_scanned,scan_ready_at from chains where id='SOL'")).rows[0];
const count = async () => Number((await query("select count(*) from deposits where chain_id='SOL'")).rows[0].count);
function add(at: number, destination = owner) {
  const signature = base58.encode(createHash('sha512').update(`fixture:${at}:${destination}`).digest());
  const transfer = { programId: SYSTEM, parsed: { type: 'transfer', info: { source: payer, destination, lamports: 1_000_000 + at } } };
  const cpi = at === 110;
  const value = { slot: at, version: 1, transaction: { signatures: [signature], message: {
    accountKeys: [{ pubkey: payer }, { pubkey: destination }, { pubkey: SYSTEM }],
    instructions: cpi ? [{ programId: payer }] : [transfer],
  } }, meta: { err: null, postTokenBalances: [], innerInstructions: cpi ? [{ index: 0, instructions: [transfer] }] : [] } };
  transactions.set(signature, { value, active: true }); return signature;
}
const history = (address: string) => [...transactions.values()].filter(entry => entry.active && entry.value.slot >= first &&
  entry.value.transaction.message.accountKeys.some((key: any) => key.pubkey === address)).map(entry => ({
  signature: entry.value.transaction.signatures[0], slot: entry.value.slot, err: null, confirmationStatus: 'finalized',
})).sort((a, b) => b.slot - a.slot);
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString()), { method, params: p } = request;
    calls.push({ method, params: p }); let result: unknown; const probeSlot = Math.max(101, head + 1);
    switch (method) {
      case 'getGenesisHash': result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; break;
      case 'getSlot': result = head; break;
      case 'getFirstAvailableBlock': result = firstReported ?? first; break;
      case 'minimumLedgerSlot': result = first; break;
      case 'getBlock': {
        assert.equal(p[1].transactionDetails, 'signatures'); assert.equal(p[1].maxSupportedTransactionVersion, 1);
        result = { blockhash: hash(p[0]), blockTime: Math.floor(Date.now() / 1000) - (stale ? 300 : 0),
          signatures: [...transactions.values()].filter(entry => entry.active && entry.value.slot === p[0])
            .map(entry => entry.value.transaction.signatures[0]).concat(p[0] === probeSlot ? [probe] : []) }; break;
      }
      case 'getSignaturesForAddress': {
        assert.equal(p[1].commitment, 'finalized'); assert.equal(p[1].minContextSlot, head);
        if (p[0] === SYSTEM) { result = [{ signature: probe, slot: probeSlot, err: null, confirmationStatus: 'finalized' }]; break; }
        const rows = history(p[0]), index = p[1].before ? rows.findIndex(row => row.signature === p[1].before) + 1 : 0;
        result = rows.slice(index, index + p[1].limit);
        if (pageMode === 'null') result = null;
        else if (pageMode === 'empty') result = [];
        else if (pageMode === 'missing-err') result = (result as any[]).map(({ err: _, ...row }) => row);
        else if (pageMode === 'duplicate' && (result as any[]).length) result = [(result as any[])[0], (result as any[])[0]];
        break;
      }
      case 'getTransaction': {
        assert.equal(p[1].encoding, 'jsonParsed'); assert.equal(p[1].maxSupportedTransactionVersion, 1);
        if (p[0] === probe) result = probeUnavailable ? null : { slot: probeSlot, version: 1, transaction: { signatures: [probe], message: { accountKeys: [], instructions: [] } },
          meta: { err: null, postTokenBalances: [], innerInstructions: [] } };
        else {
          const value = transactions.get(p[0])?.value;
          result = value?.slot === failSlot ? null : value ? structuredClone(value) : null;
          if (missingMetadata && result) (result as any).meta.innerInstructions = null;
        }
        break;
      }
      case 'getSignatureStatuses': result = { context: { slot: probeSlot }, value: [{ slot: probeSlot, err: null, confirmationStatus: 'finalized' }] }; break;
      default: throw Error('Unexpected test RPC; full-block scans and sends are forbidden');
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } catch { res.writeHead(500); res.end(); }
});

before(async () => {
  await admin.query('create database ' + database + ' template template0');
  const directory = new URL('../../sql/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await query(await readFile(new URL(file, directory), 'utf8'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await query("update chains set enabled=true,required_conf=1 where id='SOL'");
  await setSecret('rpc:SOL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, 'fixture');
  await provisionCustodyKeys();
  const key = (await query('select key_id,spki from custody_public_key')).rows[0];
  const sealed = publicEncrypt({ key: createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256', oaepLabel: Buffer.from(key.key_id) }, seed);
  await tx(client => submitCustodyEnvelope(client, key.key_id, sealed.toString('base64')));
  const signer = await provisionCustodyKeys(); assert.ok(signer); signer.destroy();
  for (const id of [uid, other]) await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'fixture')", [id, id + '@test.invalid', 's' + id.replaceAll('-', '').slice(0, 15)]);
});
after(async () => {
  seed.fill(0); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
  try { await admin.query('drop database if exists ' + database); } finally { await admin.end(); await rm(temporary, { recursive: true, force: true }); }
});

test('SOL zero-owner capability probe accepts normal finalized head advancement and releases the actual permanent HD address', async () => {
  probeUnavailable = true; await assert.rejects(watcher.tick(), /transaction unavailable/);
  assert.equal((await state()).last_scanned, '0'); assert.equal((await state()).scan_ready_at, null);
  await assert.rejects(getOrCreateAddress(uid, 'SOL'), /unavailable/); probeUnavailable = false;
  await watcher.tick(); assert.equal((await state()).last_scanned, '100'); assert.ok((await state()).scan_ready_at);
  owner = (await getOrCreateAddress(uid, 'SOL')).address;
  const row = (await query("select deriv_index from deposit_addresses where user_id=$1 and chain_id='SOL'", [uid])).rows[0];
  assert.equal(owner, restoreCustodyPublic(seed, Number(row.deriv_index)).solAddress);
  assert.equal((await getOrCreateAddress(uid, 'SOL')).address, owner);
  await query("update chains set scan_ready_at=null where id='SOL'"); probeUnavailable = true;
  await assert.rejects(watcher.tick(), /transaction unavailable/); assert.equal((await state()).last_scanned, '100');
  assert.equal((await state()).scan_ready_at, null); probeUnavailable = false;
  await watcher.tick(); assert.equal((await state()).last_scanned, '100'); assert.ok((await state()).scan_ready_at);
});

test('SOL paginates newer-than-pinned history, commits completed pages, and never advances across a late missing transaction', async () => {
  for (let at = 101; at <= 115; at++) add(at);
  head = 112; await watcher.tick();
  assert.equal(await count(), 7); assert.equal((await state()).last_scanned, '100');
  const before = (await query('select before_signature,target_slot from sol_address_scans where query_address=$1', [owner])).rows[0];
  assert.equal(before.target_slot, '112'); assert.ok(before.before_signature);
  pageMode = 'empty'; await assert.rejects(watcher.tick(), /Discontinuous/); assert.equal((await state()).last_scanned, '100');
  pageMode = 'normal';
  failSlot = 105; await assert.rejects(new NonEvmWatcher('SOL').tick(), /transaction unavailable/);
  assert.equal(await count(), 7); assert.equal((await state()).last_scanned, '100');
  assert.deepEqual((await query('select before_signature,target_slot from sol_address_scans where query_address=$1', [owner])).rows[0], before);
  assert.equal((await state()).scan_ready_at, null);
  failSlot = -1; await new NonEvmWatcher('SOL').tick(); assert.equal(await count(), 12); assert.equal((await state()).last_scanned, '112');
  assert.equal((await query("select log_index from deposits where chain_id='SOL' and block_number=110")).rows[0].log_index, 1);
  const expected = Array.from({ length: 12 }, (_, i) => BigInt(1_000_101 + i)).reduce((a, b) => a + b, 0n);
  assert.equal((await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + uid])).rows[0].amount, expected.toString());
  await tx(async client => {
    await client.query("update custody_sweep_networks set destination=$1 where chain_id='SOL'", [restoreCustodyPublic(seed, 999).solAddress]);
    await client.query("update custody_sweep_networks set sweeps_enabled=true where chain_id='SOL'");
  });
  const engine = new SweepEngine(pool); assert.equal(await engine.enqueue('SOL'), 12); assert.equal(await engine.enqueue('SOL'), 0);
});

test('SOL malformed, missing, duplicated and incomplete indexed metadata cannot credit or advance; retries credit once', async () => {
  head = 115;
  for (const mode of ['null', 'empty', 'missing-err', 'duplicate'] as const) {
    pageMode = mode; await assert.rejects(watcher.tick()); assert.equal(await count(), 12); assert.equal((await state()).last_scanned, '112');
  }
  pageMode = 'normal'; missingMetadata = true; await assert.rejects(watcher.tick(), /metadata/); assert.equal(await count(), 12);
  missingMetadata = false; await watcher.tick(); assert.equal(await count(), 15); assert.equal((await state()).last_scanned, '115');
  await Promise.all([watcher.tick(), new NonEvmWatcher('SOL').tick()]); assert.equal(await count(), 15);
  assert.equal((await query("select count(distinct journal_id) as n from deposits where chain_id='SOL' and status='credited'")).rows[0].n, '15');
});

test('SOL retention and stale heads fail closed; fully processed pruned history and skipped slots remain safe', async () => {
  head = 116; first = 116; firstReported = 0;
  await assert.rejects(watcher.tick(), /history/); assert.equal((await state()).last_scanned, '115'); assert.equal((await state()).scan_ready_at, null);
  first = 90; firstReported = undefined; head = 120; await watcher.tick(); assert.equal((await state()).last_scanned, '120');
  first = 118; head = 121; await watcher.tick(); assert.equal((await state()).last_scanned, '121');
  assert.equal((await query('select anchor_signature from sol_address_scans where query_address=$1', [owner])).rows[0].anchor_signature, null);
  stale = true; await assert.rejects(watcher.tick(), /stale/); assert.equal((await state()).scan_ready_at, null);
  stale = false; head = 122; await watcher.tick(); assert.equal((await state()).last_scanned, '122');
  assert.equal(calls.some(call => ['getBlocks', 'sendTransaction'].includes(call.method)), false);
  assert.ok(calls.filter(call => call.method === 'getSignaturesForAddress').every(call => [owner, SYSTEM].includes(call.params[0])));
});

test('SOL uncredited finalized reorg rewinds durable coverage and orphans observations without touching earlier credits', async () => {
  await query("update chains set required_conf=50 where id='SOL'"); head = 123; const signature = add(123); await watcher.tick();
  assert.equal((await query('select status from deposits where txid=$1', [signature])).rows[0].status, 'pending');
  forks.set(123, 1); transactions.get(signature)!.active = false; head = 124; await watcher.tick();
  assert.equal((await state()).last_scanned, '122'); assert.equal((await state()).scan_ready_at, null);
  assert.equal((await query('select status from deposits where txid=$1', [signature])).rows[0].status, 'orphaned');
  await watcher.tick(); assert.equal((await state()).last_scanned, '124');
  assert.equal((await query("select count(*) from deposits where status='credited'")).rows[0].count, '15');
});

test('SOL newly assigned HD users have unique permanent mappings and scan from covered floor, never from zero', async () => {
  await query("update chains set last_scanned=0 where id='SOL'");
  await assert.rejects(watcher.tick(), /receive history/); assert.equal((await state()).last_scanned, '0');
  await query("update chains set last_scanned=124 where id='SOL'"); await watcher.tick();
  secondOwner = (await getOrCreateAddress(other, 'SOL')).address; assert.notEqual(secondOwner, owner);
  assert.equal((await getOrCreateAddress(uid, 'SOL')).address, owner); assert.equal((await getOrCreateAddress(other, 'SOL')).address, secondOwner);
  await query("update chains set required_conf=1 where id='SOL'"); head = 125; add(125, secondOwner);
  await watcher.tick(); await watcher.tick(); assert.equal((await state()).last_scanned, '125');
  assert.equal((await query("select count(*) from deposits where user_id=$1 and status='credited'", [other])).rows[0].count, '1');
  assert.equal((await query('select min(last_scanned)::text as slot from sol_address_scans')).rows[0].slot, '125');
});

test('SOL credited reorg halts for reconciliation and never rewrites assignments or credited balances', async () => {
  const signature = history(secondOwner)[0]!.signature;
  const balance = (await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + other])).rows[0].amount;
  forks.set(125, 1); transactions.get(signature)!.active = false; head = 126;
  await assert.rejects(watcher.tick(), /Credited Solana reorganization/); assert.equal((await state()).last_scanned, '125');
  assert.equal((await state()).scan_ready_at, null);
  assert.equal((await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + other])).rows[0].amount, balance);
  assert.equal((await query("select address from deposit_addresses where user_id=$1 and chain_id='SOL'", [other])).rows[0].address, secondOwner);
});

test('SOL twenty older review holds cannot starve eligible credit; releasing a hold credits it once', async () => {
  // Restore the preceding synthetic fork before exercising the independent credit queue case.
  forks.delete(125);
  for (const entry of transactions.values()) if (entry.value.slot === 125) entry.active = true;
  head = 125; await watcher.tick();
  const engine = new SweepEngine(pool); await engine.enqueue('SOL'); assert.equal(await engine.enqueue('SOL'), 0);
  const balanceBefore = BigInt((await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + uid])).rows[0].amount);
  const heldIds: string[] = [];
  for (let index = 0; index < 20; index++) {
    const at = 126 + index, signature = add(at), status = index % 2 ? 'confirmed' : 'pending';
    const inserted = await query(`insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,
      required_conf,status,confirmations,confirmed_at,review_hold) values('SOL','SOL',$1,$2,$3,0,$4,$5,$6,1,$7,$8,
      case when $7='confirmed' then now() end,true) returning id`, [uid, owner, signature, String(1_000_000 + at), at, hash(at), status, index % 2]);
    heldIds.push(inserted.rows[0].id);
  }
  const heldRows = async (ids = heldIds) => (await query('select * from deposits where id=any($1::bigint[]) order by id', [ids])).rows;
  const heldBefore = await heldRows(), signature = add(146), amount = 1_000_146n;
  head = 150;
  for (let attempt = 0; attempt < 6 && (await state()).last_scanned !== '150'; attempt++) await watcher.tick();
  assert.equal((await state()).last_scanned, '150'); assert.ok((await state()).scan_ready_at);
  const eligible = (await query('select * from deposits where txid=$1', [signature])).rows[0];
  assert.equal(eligible.status, 'credited'); assert.ok(eligible.journal_id);
  assert.deepEqual(await heldRows(), heldBefore);
  assert.equal((await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + uid])).rows[0].amount, String(balanceBefore + amount));
  assert.equal(await engine.enqueue('SOL'), 1);
  assert.equal((await query('select count(*) from custody_sweep_jobs where deposit_id=$1 and source=$2 and amount=$3', [eligible.id, owner, amount.toString()])).rows[0].count, '1');
  assert.equal((await query('select count(*) from custody_sweep_jobs where deposit_id=any($1::bigint[])', [heldIds])).rows[0].count, '0');
  assert.equal((await query("select count(*) from journals where kind='deposit' and ref=any($1::text[])", [heldIds.map(id => 'deposit:' + id)])).rows[0].count, '0');
  await watcher.tick(); assert.equal(await engine.enqueue('SOL'), 0); assert.deepEqual(await heldRows(), heldBefore);
  assert.equal((await query("select count(*) from journals where kind='deposit' and ref=$1", ['deposit:' + eligible.id])).rows[0].count, '1');

  const released = heldBefore[0]; await query('update deposits set review_hold=false where id=$1', [released.id]);
  await watcher.tick(); assert.equal(await engine.enqueue('SOL'), 1);
  const credited = (await query('select * from deposits where id=$1', [released.id])).rows[0];
  assert.equal(credited.status, 'credited'); assert.ok(credited.journal_id); assert.equal(credited.review_hold, false);
  assert.equal(credited.amount, released.amount); assert.equal(credited.address, released.address); assert.equal(credited.txid, released.txid);
  assert.deepEqual(await heldRows(heldIds.slice(1)), heldBefore.slice(1));
  await watcher.tick(); assert.equal(await engine.enqueue('SOL'), 0);
  assert.equal((await query("select count(*) from journals where kind='deposit' and ref=$1", ['deposit:' + released.id])).rows[0].count, '1');
  assert.equal((await query('select count(*) from custody_sweep_jobs where deposit_id=$1', [released.id])).rows[0].count, '1');
  assert.equal((await query("select amount from balances where account=$1 and asset_id='SOL'", ['u:' + uid])).rows[0].amount, String(balanceBefore + amount + BigInt(released.amount)));
  assert.deepEqual(await heldRows(heldIds.slice(1)), heldBefore.slice(1));
});
