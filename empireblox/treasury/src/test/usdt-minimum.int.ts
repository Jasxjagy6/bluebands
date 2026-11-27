import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { id, toBeHex, zeroPadValue } from 'ethers';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw Error('Disposable local database required');
const admin = new pg.Pool({ connectionString: url.href });
const database = 'usdt_minimum_' + randomBytes(8).toString('hex');
const isolated = new URL(url); isolated.pathname = '/' + database;
process.env.DATABASE_URL = isolated.href;
const { pool, query } = await import('../db.js');
const { setSecret } = await import('../vault.js');
const { EvmWatcher } = await import('../chains/evm.js');
const { buildServer } = await import('../api/server.js');
const app = await buildServer();
const routes = [
  { chain: 'ETH', asset: 'USDT.ERC20', network: 1 },
  { chain: 'BSC', asset: 'USDT.BEP20', network: 56 },
  { chain: 'POL', asset: 'USDT.POL', network: 137 },
];
const owner = '0x' + '24'.repeat(20), sender = '0x' + '35'.repeat(20), uid = randomUUID();
const hashes = (chain: string, height: number) => id(chain + ':block:' + height);
let head=120;
const transfers = new Map<string, { token: string; amounts: bigint[] }>();
const paymentHash = (chain: string, index: number) => id(chain + ':minimum:' + index);
function rpc(chain: string, method: string, params: any[]) {
  if (method === 'eth_chainId') return toBeHex(routes.find(r => r.chain === chain)!.network);
  if (method === 'eth_blockNumber') return toBeHex(head);
  if (method === 'eth_getBlockByNumber') {
    const height = Number(params[0]);
    return { number: toBeHex(height), hash: hashes(chain, height), parentHash: hashes(chain, height - 1),
      timestamp: toBeHex(Math.floor(Date.now() / 1000)), nonce: '0x0000000000000000', difficulty: '0x0',
      gasLimit: '0x100000', gasUsed: '0x0', miner: sender, extraData: '0x', transactions: [], baseFeePerGas: '0x1' };
  }
  if (method === 'eth_getLogs') {
    const filter = params[0];
    if (Number(filter.fromBlock) > 101 || Number(filter.toBlock) < 101) return [];
    const { token, amounts } = transfers.get(chain)!;
    assert.ok(filter.topics[2].includes(zeroPadValue(owner, 32)));
    return amounts.map((amount, index) => ({ address: token, blockHash: hashes(chain, 101), blockNumber: toBeHex(101),
      transactionHash: paymentHash(chain, index), logIndex: toBeHex(index), transactionIndex: toBeHex(index), removed: false,
      topics: [id('Transfer(address,address,uint256)'), zeroPadValue(sender, 32), zeroPadValue(owner, 32)], data: toBeHex(amount, 32) }));
  }
  throw Error('Unexpected fixture RPC ' + method);
}
const server = createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts).toString()), chain = req.url!.slice(1);
  const answer = (b: any) => ({ jsonrpc: '2.0', id: b.id, result: rpc(chain, b.method, b.params) });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
});
before(async () => {
  await admin.query('create database ' + database + ' template template0');
  const sql = new URL('../../sql/', import.meta.url);
  for (const file of (await readdir(sql)).filter(f => f.endsWith('.sql')).sort())
    await query(await readFile(new URL(file, sql), 'utf8'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await query("insert into users(id,username,email,pass_hash) values($1,'minimum',$2,'fixture')", [uid, uid + '@test.invalid']);
  for (const { chain, asset } of routes) {
    const a = (await query('select token_address,decimals from assets where id=$1', [asset])).rows[0];
    const minimum = 10n ** BigInt(a.decimals - 1);
    transfers.set(chain, { token: a.token_address, amounts: [minimum - 1n, minimum, minimum + 1n] });
    await query('update chains set enabled=true,last_scanned=100 where id=$1', [chain]);
    await query('insert into scanned_blocks(chain_id,height,hash) values($1,100,$2)', [chain, hashes(chain, 100)]);
    await query('insert into deposit_addresses(chain_id,user_id,address,deriv_index) values($1,$2,$3,100)', [chain, uid, owner]);
    await setSecret('rpc:' + chain, 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/' + chain, 'fixture');
  }
});
after(async () => {
  await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
  try { await admin.query('drop database if exists ' + database); } finally { await admin.end(); }
});

test('the public wallet catalog reports exactly 0.1 USDT for each direct token route', async () => {
  const reply = await app.inject({ method: 'GET', url: '/api/assets' });
  assert.equal(reply.statusCode, 200);
  for (const { asset } of routes) {
    const a = reply.json().directRoutes.find((r: any) => r.id === asset);
    assert.equal(a.min_deposit, (10n ** BigInt(a.decimals - 1)).toString());
  }
  const legacy = (await query("select decimals,min_deposit::text from assets where symbol='USDT' and kind='token'")).rows;
  assert.ok(legacy.every(a => a.min_deposit === (10n ** BigInt(a.decimals - 1)).toString()));
});

test('all routes use five confirmations and a pending Polygon deposit credits exactly at five', async () => {
  assert.ok((await query('select required_conf from chains')).rows.every(r=>r.required_conf===5));
  const watcher=new EvmWatcher('POL');head=104;
  try {
    await watcher.tick();
    const pending=(await query("select status,confirmations,required_conf from deposits where chain_id='POL' order by log_index")).rows;
    assert.equal(pending.length,2);
    assert.ok(pending.every(r=>r.status==='pending'&&r.confirmations===4&&r.required_conf===5));
    head=105;await Promise.all([watcher.tick(),new EvmWatcher('POL').tick()]);
    const credited=(await query("select status,confirmations,required_conf from deposits where chain_id='POL'")).rows;
    assert.ok(credited.every(r=>r.status==='credited'&&r.confirmations===5&&r.required_conf===5));
  }finally{head=120;}
});

for (const { chain, asset } of routes) test(chain + ' credits 0.1 USDT inclusively, rejects one unit below and preserves exact ledger precision', async () => {
  const watcher = new EvmWatcher(chain), amounts = transfers.get(chain)!.amounts;
  await Promise.all([watcher.tick(), new EvmWatcher(chain).tick()]); await watcher.tick();
  const rows = (await query('select txid,amount::text,status from deposits where chain_id=$1 order by log_index', [chain])).rows;
  assert.deepEqual(rows, amounts.slice(1).map((amount, index) => ({ txid: paymentHash(chain, index + 1), amount: amount.toString(), status: 'credited' })));
  const decimals = (await query('select decimals from assets where id=$1', [asset])).rows[0].decimals;
  const expected = (amounts[1]! + amounts[2]!) * 10n ** BigInt(18 - decimals);
  const credited = (await query(`select sum(e.delta)::text as amount,count(*)::integer as credits from ledger_entries e
    join journals j on j.id=e.journal_id join deposits d on j.id=d.journal_id
    where d.chain_id=$1 and e.account=$2 and e.asset_id='USDT'`, [chain, 'u:' + uid])).rows[0];
  assert.deepEqual(credited, { amount: expected.toString(), credits: 2 });
});
