import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { base58 } from '@scure/base';
import { parseAmount, formatAmount } from '../money.js';
import { buildSolSweepMessage, createSolSweepAdapter, type SolSweepOptions, type SolSweepSigner } from '../custody/sol-sweep.js';
import { SweepStop, type SignedSweep, type SweepIntent, type SweepReason } from '../custody/types.js';

// Public RFC 8032 test vector 1 is the fixture source; the destination is only test vector 2's PUBLIC key.
// Golden wire/signature were generated separately with OpenSSL, not with the adapter or its serializer.
const SOURCE = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z', DEST = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5';
const WIRE = 'AUOa0eOOkfKdm4WEbnG8EmCx1VRYKJe/N68n0Rvk3DUAVasIGtcnCMGt+0+R1qUtE64XR0xHF2Phj3jMTHjEdgUBAAED11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo9QBfD6EOJWpK3CqdNG368nJgszy7ElozAzVXxKvRmDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioBAgIAAQwCAAAAx028AAAAAAA=';
const TXID = '2MPuN1zDeSpPm8xhjSypsbkSXiKB4cmy39u93iouanZofL5vUTDJ64DAmzA1drtER6gWPmBrPqexicUYws3rxfdW';
const SYSTEM = '11111111111111111111111111111111', MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const URL = 'https://solana.fixture.invalid/rpc';
const hash = (n: number) => base58.encode(Buffer.alloc(32, n));
const keyForTest = (seed: Buffer) => createPrivateKey({ format: 'der', type: 'pkcs8',
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]) });
const fixtureSource = keyForTest(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
const fixturePayer = keyForTest(Buffer.alloc(32, 7));
const payer = createPublicKey(fixturePayer).export({ format: 'der', type: 'spki' }).subarray(-32);
const previousEnv = process.env.NODE_ENV;
let realFetchCalls = 0;
before(() => { process.env.NODE_ENV = 'test'; mock.method(globalThis, 'fetch', () => { realFetchCalls++; throw new Error('Live fetch forbidden'); }); });
after(() => { mock.restoreAll(); if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv; assert.equal(realFetchCalls, 0); });

function incoming(amount: bigint, v0: boolean) {
  const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(amount, 4);
  const keys = v0 ? [payer, Buffer.alloc(32), Buffer.alloc(32, 8)] : [payer, Buffer.from(base58.decode(SOURCE)), Buffer.alloc(32)];
  const body = v0 ? Buffer.concat([Buffer.from([128, 1, 0, 2, 3]), ...keys, Buffer.alloc(32, 20),
    Buffer.from([1, 2, 3, 0, 3, 1, 1, 99, 1]), Buffer.alloc(32, 9), Buffer.from([1, 7, 0])]) :
    Buffer.concat([Buffer.from([1, 0, 1, 3]), ...keys, Buffer.alloc(32, 20), Buffer.from([1, 2, 2, 0, 1, data.length]), data]);
  const sig = sign(null, body, fixturePayer), encoded = Buffer.concat([Buffer.from([1]), sig, body]).toString('base64');
  return { txid: base58.encode(sig), tx: { slot: 100, transaction: [encoded, 'base64'], version: v0 ? 0 : 'legacy',
    meta: { err: null, preBalances: v0 ? [amount + 5000n, 1, 1, 0] : [amount + 5000n, 0, 1],
      postBalances: v0 ? [0, 1, 1, amount] : [0, amount, 1], fee: 5000,
      innerInstructions: v0 ? [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0, 3], data: base58.encode(data) }] }] : [],
      loadedAddresses: { writable: v0 ? [SOURCE] : [], readonly: [] } } } };
}
const success = (at: number) => ({ slot: at, err: null, confirmations: null, confirmationStatus: 'finalized' });
const account = (n: bigint) => ({ owner: SYSTEM, executable: false, space: 0, data: ['', 'base64'], lamports: n });
const context = (value: unknown, slot = 250) => ({ context: { slot }, value });
const isStop = (code: SweepReason) => (e: unknown) => e instanceof SweepStop && e.code === code;

function fixture(amount = parseAmount('0.012345679', 9), v0 = false) {
  const deposit = incoming(amount, v0);
  const i: SweepIntent = { jobId: 'sol-job', depositId: '103', chainId: 'SOL', assetId: 'SOL', keyId: 'fixture-key-id', derivIndex: 9,
    source: SOURCE, destination: DEST, sponsor: null, amount, depositTxid: deposit.txid, depositBlock: 100, depositBlockHash: hash(11),
    depositIndex: v0 ? 1 : 0, requiredConf: 3 };
  const f = { source: account(amount) as ReturnType<typeof account> | null, destination: null as ReturnType<typeof account> | null,
    fee: 5000n as bigint | null, rent: 890_880n, height: 501, valid: true, head: 250, genesis: MAINNET,
    inStatus: success(100) as any, inTx: deposit.tx as any, inHash: hash(11), inSigs: [i.depositTxid],
    status: null as any, tx: null as any, outSigs: [TXID], signed: 0, stored: null as SignedSweep | null,
    sent: [] as string[], calls: [] as { method: string; params: any[] }[], override: {} as Record<string, (p: any[]) => unknown> };
  const signer: SolSweepSigner = { solAddress: n => n === 9 ? SOURCE : DEST, async signSolSweep(intent, fields) {
    assert.equal(intent.keyId, i.keyId); assert.equal(intent.derivIndex, 9); f.signed++;
    return sign(null, buildSolSweepMessage(intent, fields), fixtureSource);
  } };
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, URL); assert.equal(options?.redirect, 'error'); assert.equal(options.method, 'POST');
    const { id, method, params: p } = JSON.parse(String(options.body)); f.calls.push({ method, params: p });
    let result: unknown;
    if (f.override[method]) result = f.override[method]!(p);
    else switch (method) {
      case 'getGenesisHash': result = f.genesis; break;
      case 'getSignatureStatuses': assert.deepEqual(p[1], { searchTransactionHistory: true });
        result = context([p[0][0] === i.depositTxid ? f.inStatus : f.status]); break;
      case 'getTransaction': assert.deepEqual(p[1], { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 1 });
        result = p[0] === i.depositTxid ? f.inTx : f.tx; break;
      case 'getBlock': assert.equal(p[1].commitment, 'finalized'); assert.equal(p[1].transactionDetails, 'signatures');
        result = p[0] === 100 ? { blockhash: f.inHash, signatures: f.inSigs } : { blockhash: hash(13), signatures: f.outSigs }; break;
      case 'getSlot': assert.deepEqual(p, [{ commitment: 'finalized' }]); result = f.head; break;
      case 'getMultipleAccounts': assert.deepEqual(p[0], [SOURCE, DEST]); assert.equal(p[1].commitment, 'finalized');
        result = context([f.source, f.destination], 200); break;
      case 'getMinimumBalanceForRentExemption': assert.deepEqual(p, [0, { commitment: 'finalized' }]); result = f.rent; break;
      case 'getLatestBlockhash': assert.equal(p[0].commitment, 'finalized'); result = context({ blockhash: hash(42), lastValidBlockHeight: 650 }, 202); break;
      case 'getFeeForMessage': assert.equal(p[1].commitment, 'finalized'); result = context(f.fee); break;
      case 'getBlockHeight': assert.equal(p[0].commitment, 'finalized'); result = f.height; break;
      case 'isBlockhashValid': assert.equal(p[0], hash(42)); assert.equal(p[1].commitment, 'finalized'); result = context(f.valid); break;
      case 'sendTransaction': assert.deepEqual(p, [f.stored!.raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized',
        maxRetries: 0, minContextSlot: 200 }]); f.sent.push(f.stored!.raw); result = f.stored!.txid; break;
      default: throw new Error('Unknown test RPC method');
    }
    // Encode Rust u64s as actual JSON numbers, including the integer just beyond 2^53.
    const json = JSON.stringify({ jsonrpc: '2.0', id, result }, (_, v) => typeof v === 'bigint' ? `BIGINT:${v}` : v)
      .replace(/"BIGINT:(\d+)"/g, '$1');
    return new Response(json);
  };
  const adapter = (o?: SolSweepOptions, signing = signer) => createSolSweepAdapter(URL, signing, { fetch: transport,
    readCommittedStep: async (job, phase) => job === i.jobId && phase === 'sweep' && f.stored ? { ...f.stored } : null, ...o });
  function finalize(s: SignedSweep) {
    f.status = success(222); f.outSigs = [s.txid];
    f.tx = { slot: 222, version: 'legacy', transaction: [s.raw, 'base64'], meta: { err: null, fee: s.fee,
      preBalances: [s.amount + s.fee + 5_000_000n, 13_000_001, 1], postBalances: [5_000_000, 13_000_001n + s.amount, 1] } };
  }
  return { i, f, signer, adapter, finalize };
}

test('SOL legacy fixture: one strict Ed25519 signature over exact native transfer; prepare cannot broadcast', async () => {
  const { f, i, adapter } = fixture(), s = await adapter().prepare(i, null);
  assert.deepEqual(s, { raw: WIRE, txid: TXID, from: SOURCE, amount: 12_340_679n, fee: 5000n, nonce: null, lastValidBlockHeight: 650, phase: 'sweep' });
  const b = Buffer.from(s.raw, 'base64'); assert.equal(b.length, 215); assert.equal(b[0], 1);
  assert.equal(verify(null, b.subarray(65), createPublicKey(fixtureSource), b.subarray(1, 65)), true);
  assert.deepEqual([...b.subarray(65, 69)], [1, 0, 1, 3]); assert.equal(base58.encode(b.subarray(69, 101)), SOURCE);
  assert.equal(base58.encode(b.subarray(101, 133)), DEST); assert.equal(base58.encode(b.subarray(133, 165)), SYSTEM);
  assert.deepEqual([...b.subarray(197, 207)], [1, 2, 2, 0, 1, 12, 2, 0, 0, 0]);
  assert.equal(formatAmount(b.readBigUInt64LE(207), 9), '0.012340679');
  const fees = f.calls.filter(c => c.method === 'getFeeForMessage'); assert.equal(fees.length, 2);
  assert.equal(fees[1]!.params[0], b.subarray(65).toString('base64'));
  assert.equal(f.signed, 1); assert.equal(f.sent.length, 0); assert.equal(f.stored, null);
});

test('SOL v1 incoming evidence verifies tail signatures, header/config layout and stable instruction index above legacy size', async () => {
  function v1() {
    const state = fixture(), amount = state.i.amount, data = Buffer.alloc(12), config = Buffer.alloc(4);
    data.writeUInt32LE(2); data.writeBigUInt64LE(amount, 4); config.writeUInt32LE(200_000);
    const memo = Buffer.alloc(1400, 97), first = Buffer.from([3, 0, 0, 0]), second = Buffer.from([2, 2, 12, 0]); first.writeUInt16LE(memo.length, 2);
    const body = Buffer.concat([Buffer.from([129, 1, 0, 2, 4, 0, 0, 0]), Buffer.alloc(32, 20), Buffer.from([2, 4]),
      payer, Buffer.from(base58.decode(SOURCE)), Buffer.alloc(32), Buffer.alloc(32, 8), config, first, second, memo, Buffer.from([0, 1]), data]);
    const signature = sign(null, body, fixturePayer), raw = Buffer.concat([body, signature]);
    state.i.depositTxid = base58.encode(signature); state.i.depositIndex = 1; state.f.inSigs = [state.i.depositTxid];
    state.f.inTx = { slot: 100, version: 1, transaction: [raw.toString('base64'), 'base64'], meta: {
      err: null, innerInstructions: [], preBalances: [amount + 5000n, 0, 1, 1], postBalances: [0, amount, 1, 1], fee: 5000,
    } };
    return { ...state, raw, body };
  }
  const good = v1(); assert.ok(good.raw.length > 1232); await good.adapter().verifyDeposit(good.i);
  const signed = await good.adapter().prepare(good.i, null); assert.equal(Buffer.from(signed.raw, 'base64')[0], 1);
  assert.equal(good.f.sent.length, 0);
  for (const corrupt of [
    (s: ReturnType<typeof v1>) => { s.raw[s.raw.length - 1] = s.raw[s.raw.length - 1]! ^ 1; },
    (s: ReturnType<typeof v1>) => { s.raw[1] = 2; },
    (s: ReturnType<typeof v1>) => { s.raw[4] = 1; },
    (s: ReturnType<typeof v1>) => { s.raw[40] = 65; },
    (s: ReturnType<typeof v1>) => { s.i.depositIndex = 0; },
    (s: ReturnType<typeof v1>) => { s.raw = s.raw.subarray(0, -1); },
    (s: ReturnType<typeof v1>) => { s.raw = Buffer.concat([s.raw, Buffer.alloc(1)]); },
  ]) {
    const state = v1(); corrupt(state); state.f.inTx.transaction[0] = state.raw.toString('base64');
    await assert.rejects(state.adapter().verifyDeposit(state.i), isStop('invalid_receipt'));
    assert.equal(state.f.signed, 0); assert.deepEqual(state.f.sent, []);
  }
  // Re-sign malformed layouts so rejection cannot be attributed only to a stale signature.
  for (const [offset, value] of [[2, 1], [4, 1], [40, 65], [41, 255], [good.body.length - 13, 63]]) {
    const state = v1(), body = Buffer.from(state.body); body[offset!] = value!;
    const signature = sign(null, body, fixturePayer); state.i.depositTxid = base58.encode(signature); state.f.inSigs = [state.i.depositTxid];
    state.f.inTx.transaction[0] = Buffer.concat([body, signature]).toString('base64');
    await assert.rejects(state.adapter().verifyDeposit(state.i), isStop('invalid_receipt'));
    assert.equal(state.f.signed, 0);
  }
});

test('SOL preserves every raw RPC lamport above Number.MAX_SAFE_INTEGER and rejects excess precision', async () => {
  const n = parseAmount('9007199.254740993', 9), { i, f, adapter } = fixture(n); assert.equal(n, 9_007_199_254_740_993n);
  const s = await adapter().prepare(i, null); assert.equal(s.amount, n - 5000n);
  assert.equal(Buffer.from(s.raw, 'base64').readBigUInt64LE(207), n - 5000n);
  assert.throws(() => parseAmount('0.0000000001', 9)); assert.throws(() => parseAmount('1e-9', 9));
  for (const malformed of ['18446744073709551616', '9007199254740993.000000001', '-1', '1e10']) {
    f.override.getMultipleAccounts = () => context([{ ...account(0n), lamports: malformed }, null], 200);
    await assert.rejects(adapter().prepare(i, null), isStop('invalid_receipt'));
  }
  assert.equal(f.signed, 1);
});

test('SOL proves v0 lookup keys, signed wire and the precise flattened native CPI deposit index', async () => {
  const { f, i, adapter } = fixture(1_000_001n, true), a = adapter(); await a.verifyDeposit(i);
  await assert.rejects(a.verifyDeposit({ ...i, depositIndex: 0 }), isStop('invalid_receipt'));
  await assert.rejects(a.verifyDeposit({ ...i, depositIndex: 2 }), isStop('invalid_receipt'));
  const meta = f.inTx.meta;
  meta.loadedAddresses.writable = [DEST]; await assert.rejects(a.verifyDeposit(i), isStop('invalid_receipt')); meta.loadedAddresses.writable = [SOURCE];
  meta.postBalances[3] = i.amount - 1n; await assert.rejects(a.verifyDeposit(i), isStop('invalid_receipt')); meta.postBalances[3] = i.amount;
  meta.innerInstructions[0].instructions[0].programIdIndex = 2; await assert.rejects(a.verifyDeposit(i), isStop('invalid_receipt'));
  meta.innerInstructions = null; await assert.rejects(a.verifyDeposit(i), isStop('invalid_receipt')); assert.equal(f.signed, 0);
});

test('SOL rejects wrong genesis on every path, non-native assets, wrong index/owners and sponsor phases', async () => {
  const { i, f, adapter } = fixture(), a = adapter(), s = await a.prepare(i, null); f.stored = s;
  for (const [changes, code] of [
    [{ chainId: 'ETH' }, 'wrong_chain'], [{ assetId: 'USDT.SPL' }, 'invalid_intent'], [{ derivIndex: 8 }, 'unowned'],
    [{ sponsor: DEST }, 'invalid_intent'], [{ source: SYSTEM }, 'unowned'], [{ destination: SYSTEM }, 'invalid_intent'],
    [{ destination: SOURCE }, 'invalid_intent'], [{ destination: ` ${DEST}` }, 'invalid_intent'], [{ destination: hash(255) }, 'invalid_intent'],
  ] as const) await assert.rejects(a.prepare({ ...i, ...changes }, null), isStop(code));
  await assert.rejects(a.prepare(i, s), isStop('invalid_intent'));
  f.genesis = 'wrong-network'; await assert.rejects(a.verifyDeposit(i), isStop('wrong_chain')); await assert.rejects(a.prepare(i, null), isStop('wrong_chain'));
  assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'wrong_chain' }); await assert.rejects(a.broadcast(i, s), isStop('wrong_chain'));
  assert.equal(f.signed, 1); assert.deepEqual(f.sent, []);
});

test('SOL verifies original deposit signature, full amount, canonical block, success and finality', async () => {
  const { i, f, adapter } = fixture(), a = adapter();
  await assert.rejects(a.prepare({ ...i, amount: i.amount + 1n }, null), isStop('invalid_receipt'));
  const original = f.inTx.transaction[0], b = Buffer.from(original, 'base64'); b[b.length - 8] = b[b.length - 8]! ^ 1;
  f.inTx.transaction[0] = b.toString('base64'); await assert.rejects(a.prepare(i, null), isStop('invalid_receipt')); f.inTx.transaction[0] = original;
  f.inHash = hash(14); await assert.rejects(a.prepare(i, null), isStop('orphaned')); f.inHash = i.depositBlockHash;
  f.inSigs = []; await assert.rejects(a.prepare(i, null), isStop('ambiguous')); f.inSigs = [i.depositTxid];
  f.inTx.meta.err = { InstructionError: [0, 'x'] }; await assert.rejects(a.prepare(i, null), isStop('invalid_receipt')); f.inTx.meta.err = null;
  f.head = 101; await assert.rejects(a.prepare(i, null), isStop('not_final')); f.head = 250;
  f.inTx = null; await assert.rejects(a.prepare(i, null), isStop('ambiguous'));
  f.inStatus = { ...success(100), confirmationStatus: 'confirmed', confirmations: 55 }; await assert.rejects(a.prepare(i, null), isStop('not_final'));
  assert.equal(f.signed, 0);
});

test('SOL requires a funded plain system source and no nonce, data, executable or program-owned destination', async () => {
  const { f, i, adapter } = fixture(), a = adapter();
  f.source = null; await assert.rejects(a.prepare(i, null), isStop('insufficient_funds'));
  f.source = account(i.amount - 1n); await assert.rejects(a.prepare(i, null), isStop('insufficient_funds'));
  for (const bad of [{ owner: DEST }, { space: 80 }, { data: ['AA==', 'base64'] }, { executable: true }]) {
    f.source = { ...account(i.amount), ...bad }; await assert.rejects(a.prepare(i, null), isStop('unowned'));
    f.source = account(i.amount); f.destination = { ...account(i.amount), ...bad }; await assert.rejects(a.prepare(i, null), isStop('unowned')); f.destination = null;
  }
  assert.equal(f.signed, 0);
});

test('SOL accounts can drain fully or keep exactly rent; another deposit never pays the fee', async () => {
  const { f, i, adapter } = fixture(), a = adapter(); f.source = account(i.amount + 1n);
  const s = await a.prepare(i, null); assert.equal(f.source.lamports - s.amount - s.fee, f.rent);
  f.source = account(i.amount + f.rent + 1n); const s2 = await a.prepare(i, null); assert.equal(s2.amount + s2.fee, i.amount);
  const d = fixture(1_000_000n); d.f.rent = 1_000_000n; d.f.source = account(3_000_000n);
  await assert.rejects(d.adapter().prepare(d.i, null), isStop('dust')); // cold account cannot be created below rent
  d.f.destination = account(d.f.rent); assert.equal((await d.adapter().prepare(d.i, null)).amount, 995_000n);
  d.f.source = account(d.i.amount); await assert.rejects(d.adapter().prepare(d.i, null), isStop('dust')); // fee payer would drop below rent before execution
  const small = fixture(999_999n); await assert.rejects(small.adapter().prepare(small.i, null), isStop('dust'));
});

test('SOL bounds RPC fees and configuration, requotes exact message, rejects expired hash and mismatched signer', async () => {
  const { f, i, signer, adapter } = fixture();
  assert.throws(() => adapter({ maxFeeLamports: 50_001n }), isStop('fee_limit')); assert.throws(() => adapter({ maxFeeLamports: 0n }), isStop('fee_limit'));
  assert.throws(() => adapter({ minSweepLamports: 1_000_000_001n }), isStop('invalid_intent')); assert.throws(() => adapter({ rpcTimeoutMs: Infinity }), isStop('invalid_intent'));
  await assert.rejects(adapter({ maxFeeLamports: 4999n }).prepare(i, null), isStop('fee_limit'));
  f.fee = 50_001n; await assert.rejects(adapter().prepare(i, null), isStop('fee_limit')); f.fee = null; await assert.rejects(adapter().prepare(i, null), isStop('not_final'));
  let quotes = 0; f.override.getFeeForMessage = () => context(++quotes === 1 ? 5000 : 5001);
  await assert.rejects(adapter().prepare(i, null), isStop('fee_limit')); assert.equal(quotes, 2); delete f.override.getFeeForMessage;
  f.fee = 5000n; f.valid = false; await assert.rejects(adapter().prepare(i, null), isStop('not_final')); f.valid = true;
  f.rent = 10_000_001n; await assert.rejects(adapter().prepare(i, null), isStop('fee_limit')); f.rent = 890_880n;
  await assert.rejects(adapter({ minSweepLamports: i.amount }).prepare(i, null), isStop('dust'));
  await assert.rejects(adapter({}, { ...signer, signSolSweep: async () => Buffer.alloc(64) }).prepare(i, null), isStop('unowned'));
  assert.equal(f.signed, 0); assert.deepEqual(f.sent, []);
});

test('SOL send requires exact committed step; a lost acknowledgement can only replay identical bytes', async () => {
  const { f, i, adapter } = fixture(), a = adapter(), s = await a.prepare(i, null);
  await assert.rejects(a.broadcast(i, s), isStop('unavailable')); f.stored = s;
  await assert.rejects(adapter({ readCommittedStep: undefined }).broadcast(i, s), isStop('unavailable'));
  for (const patch of [{ raw: s.raw + '\n' }, { txid: i.depositTxid }, { amount: s.amount - 1n }, { fee: s.fee + 1n }, { lastValidBlockHeight: 900 }, { nonce: '0' }]) {
    await assert.rejects(a.broadcast(i, { ...s, ...patch }), isStop('invalid_intent'));
  }
  const altered = Buffer.from(s.raw, 'base64'); altered[65 + 36] = altered[65 + 36]! ^ 1;
  f.stored = { ...s, raw: altered.toString('base64') }; await assert.rejects(a.broadcast(i, f.stored), isStop('invalid_intent')); f.stored = s;
  assert.deepEqual(f.sent, []);
  f.override.sendTransaction = p => { f.sent.push(p[0]); throw new Error('Lost mock reply'); };
  await assert.rejects(a.broadcast(i, s), isStop('unavailable')); delete f.override.sendTransaction;
  await a.broadcast(i, s); assert.deepEqual(f.sent, [WIRE, WIRE]); assert.equal(f.signed, 1);
  f.override.sendTransaction = () => i.depositTxid; await assert.rejects(a.broadcast(i, s), isStop('ambiguous'));
});

test('SOL broadcast rechecks spendability, signed fee and a recent blockhash; it does not re-sign', async () => {
  const { f, i, adapter } = fixture(), a = adapter(), s = await a.prepare(i, null); f.stored = s;
  f.source = account(i.amount + 1n); await assert.rejects(a.broadcast(i, s), isStop('dust'));
  f.source = account(i.amount - 1n); await assert.rejects(a.broadcast(i, s), isStop('insufficient_funds'));
  f.source = account(i.amount); f.fee = s.fee + 1n; await assert.rejects(a.broadcast(i, s), isStop('fee_limit'));
  f.fee = s.fee; f.valid = false; await assert.rejects(a.broadcast(i, s), isStop('expired'));
  assert.deepEqual(f.sent, []); assert.equal(f.signed, 1);
});

test('SOL requires both matching finalized observations and the actual sender/recipient balance deltas', async () => {
  const { f, i, adapter, finalize } = fixture(), a = adapter(), s = await a.prepare(i, null); f.stored = s;
  finalize(s); f.head = 222; assert.deepEqual(await a.inspect(i, s), { state: 'included', blockNumber: 222, blockHash: hash(13), networkFee: s.fee });
  f.head = 224; assert.deepEqual(await a.inspect(i, s), { state: 'final', blockNumber: 222, blockHash: hash(13), networkFee: s.fee });
  for (const corrupt of [() => { f.tx.transaction[0] = f.inTx.transaction[0]; }, () => { f.tx.meta.err = {}; }, () => { f.status.err = {}; },
    () => { f.tx.meta.fee = s.fee + 1n; }, () => { f.tx.meta.postBalances[1]++; }, () => { f.tx.meta.postBalances[0]--; },
    () => { f.tx.slot = 221; }, () => { f.tx.version = 0; }, () => { f.tx.meta = null; }]) {
    finalize(s); corrupt(); assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'invalid_receipt' });
  }
  finalize(s); f.outSigs = [i.depositTxid]; assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'ambiguous' });
  finalize(s); f.height = 651; f.valid = false; await a.broadcast(i, s); assert.deepEqual(await a.inspect(i, s), { state: 'final', blockNumber: 222, blockHash: hash(13), networkFee: s.fee });
  assert.equal(f.signed, 1); assert.deepEqual(f.sent, []);
});

test('SOL pending, expired or inconsistent history is not a failed transfer or permission for a replacement', async () => {
  const { i, f, adapter, finalize } = fixture(), a = adapter(), s = await a.prepare(i, null); f.stored = s;
  assert.deepEqual(await a.inspect(i, s), { state: 'unseen' });
  f.status = { ...success(222), confirmationStatus: 'confirmed', confirmations: 15 };
  assert.deepEqual(await a.inspect(i, s), { state: 'pending' }); await a.broadcast(i, s);
  f.height = 651; assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'ambiguous' });
  f.status = null; assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'expired' }); await assert.rejects(a.broadcast(i, s), isStop('expired'));
  await assert.rejects(adapter().prepare(i, null), isStop('ambiguous')); // a restarted adapter still consults the committed row
  finalize(s); f.status = null; assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'ambiguous' });
  finalize(s); f.tx = null; assert.deepEqual(await a.inspect(i, s), { state: 'review', reason: 'ambiguous' });
  assert.equal(f.signed, 1); assert.deepEqual(f.sent, []);
});

test('SOL treats stalled transport, oversized data, mismatched JSON-RPC ids, and provider diagnostics as unavailable', async () => {
  const { i, f, adapter } = fixture();
  for (const transport of [() => new Promise<Response>(() => {}), () => new Response(Buffer.alloc(4_194_305)),
    () => new Response(JSON.stringify({ id: 'someone-else', jsonrpc: '2.0', result: MAINNET })),
    () => new Response('private provider diagnostic', { status: 503 })]) {
    await assert.rejects(adapter({ fetch: async () => transport(), rpcTimeoutMs: 25 }).prepare(i, null), isStop('unavailable'));
  }
  assert.equal(f.signed, 0); assert.deepEqual(f.sent, []);
});

test('SOL tests and the default test environment never contact a live service', async () => {
  const { i, signer, f } = fixture();
  await assert.rejects(createSolSweepAdapter(URL, signer).verifyDeposit(i), isStop('unavailable'));
  assert.equal(realFetchCalls, 0); assert.equal(f.calls.length, 0);
});
