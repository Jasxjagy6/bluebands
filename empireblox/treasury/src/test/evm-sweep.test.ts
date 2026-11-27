import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { HDNodeWallet, id, keccak256, toBeHex, toQuantity as q, Transaction, ZeroAddress } from 'ethers';
import { createEvmSweepAdapter, type EvmSweepOptions, type EvmSweepSigner } from '../custody/evm-sweep.js';
import { SweepStop, type SignedSweep, type SweepIntent, type SweepReason } from '../custody/types.js';

// No provider, socket, DB, environment credentials or real chain data. Even a send to the fake RPC
// must match bytes already placed into the fixture's simulated durable queue.
const nets = {
  ETH: [1, 'ETH', 'USDT.ERC20', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6],
  BSC: [56, 'BNB', 'USDT.BEP20', '0x55d398326f99059ff775485246999027b3197955', 18],
  POL: [137, 'POL', 'USDT.POL', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 6],
} as const;
type Chain = keyof typeof nets;
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const unit = 10n ** 9n;
const blockHash = (height: number) => id(`mock-canonical-block:${height}`);
const pad = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const calldata = (to: string, amount: bigint) => '0xa9059cbb' + pad(to).slice(2) + toBeHex(amount, 32).slice(2);
const root = HDNodeWallet.fromSeed(randomBytes(32));
const at = (index: number) => root.deriveChild(0).deriveChild(index);
const receiver = at(7), external = root.deriveChild(1), treasury = root.deriveChild(2), reserve = root.deriveChild(3);
type RpcObject = Record<string, any>; // Intentionally includes nonconforming provider fixtures.
type Log = { address: string; topics: string[]; data: string };
const event = (contract: string, from: string, to: string, amount: bigint): Log => ({ address: contract,
  topics: [transferTopic, pad(from), pad(to)], data: toBeHex(amount, 32) });

function projection(t: Transaction): RpcObject {
  const sig = t.signature!;
  return { hash: t.hash, from: t.from, to: t.to, type: q(t.type!), chainId: q(t.chainId), nonce: q(t.nonce),
    gas: q(t.gasLimit), input: t.data, value: q(t.value), r: sig.r, s: sig.s, v: q(sig.networkV ?? sig.yParity),
    ...(t.type === 0 ? { gasPrice: q(t.gasPrice!) } : { accessList: t.accessList, gasPrice: q(unit),
      maxFeePerGas: q(t.maxFeePerGas!), maxPriorityFeePerGas: q(t.maxPriorityFeePerGas!) }),
    blockNumber: null, blockHash: null, transactionIndex: null };
}
async function fixture(chain: Chain = 'ETH', token = false, amount = 12_345_678_901_234_567_891n) {
  const [chainId, native, asset, contract, decimals] = nets[chain];
  const src = receiver.address.toLowerCase(), dest = treasury.address.toLowerCase(), fee = reserve.address.toLowerCase();
  const state = { price: unit, gasNative: 21_000n, gasToken: 54_321n, chainId, height: 112, age: 0,
    tokenBalance: amount + 923n, balance: amount + 10n ** 18n, reserve: 10n ** 18n, decimals: Number(decimals), tokenReturn: chain === 'ETH' ? '0x' : toBeHex(1, 32),
    srcNonce: 7, srcPending: 7, feeNonce: 2, feePending: 2, signCalls: 0,
    change: (method: string, params: any[], result: any): any => result };
  const durable = new Set<string>(), sent: string[] = [], calls: { method: string; params: any[] }[] = [];
  const steps = new Map<SignedSweep['phase'], SignedSweep>();
  function persist(s: SignedSweep) { durable.add(s.raw); steps.set(s.phase, structuredClone(s)); }
  const txs = new Map<string, RpcObject>(), receipts = new Map<string, RpcObject>(), blocks = new Map<number, string[]>();
  function mine(raw: string, height: number, events: Log[] = [], logIndex = 0) {
    const t = Transaction.from(raw), hash = t.hash!, list = blocks.get(height) ?? [], pos = list.length;
    blocks.set(height, [...list, hash]);
    const position = { transactionIndex: q(pos), blockNumber: q(height), blockHash: blockHash(height) };
    txs.set(hash, { ...projection(t), ...position });
    const receipt = { ...position, transactionHash: hash, from: t.from, to: t.to, contractAddress: null,
      status: '0x1', gasUsed: q(t.data === '0x' ? 21_000n : 50_000n), effectiveGasPrice: q(t.gasPrice ?? unit),
      logs: events.map((l, n) => ({ ...l, ...position, removed: false, logIndex: q(logIndex + n), transactionHash: hash })) };
    receipts.set(hash, receipt);
    if (t.from!.toLowerCase() === src) state.srcPending = state.srcNonce = t.nonce + 1;
    if (t.from!.toLowerCase() === fee) { state.feePending = state.feeNonce = t.nonce + 1; state.balance += t.value; }
    return receipt;
  }
  const depositRaw = await external.signTransaction({ type: 2, chainId, nonce: 4, maxFeePerGas: 2n * unit, maxPriorityFeePerGas: unit,
    gasLimit: 120_000n, to: token ? contract : src, data: token ? calldata(src, amount) : '0x', value: token ? 0n : amount });
  const deposit = mine(depositRaw, 100, token ? [event(contract, external.address, src, amount)] : [], 9);
  const intent: SweepIntent = { jobId: 'offline-job', depositId: 'offline-credit', keyId: id('throwaway-root').slice(2), chainId: chain, assetId: token ? asset : native,
    source: src, destination: dest, sponsor: token ? fee : null, derivIndex: 7, requiredConf: 3, amount,
    depositBlock: 100, depositBlockHash: blockHash(100), depositTxid: keccak256(depositRaw), depositIndex: token ? 9 : -1 };
  const signer: EvmSweepSigner = { evmAddress: n => at(n).address, feeAddress: reserve.address,
    async signEvmSweep(i, f) {
      state.signCalls++;
      const funding = f.phase === 'sponsor', erc = !funding && i.assetId === asset;
      return (funding ? reserve : at(i.derivIndex)).signTransaction({ type: 0, chainId, nonce: f.nonce, gasPrice: f.gasPrice, gasLimit: f.gasLimit,
        to: funding ? i.source : erc ? contract : i.destination, value: erc ? 0n : f.amount, data: erc ? calldata(i.destination, f.amount) : '0x' });
    } };
  const mock: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/'); assert.equal(init!.redirect, 'error'); assert.ok(init!.signal);
    const { method, params, id: rpcId } = JSON.parse(String(init!.body));
    calls.push({ method, params });
    let result: any;
    switch (method) {
      case 'eth_chainId': result = q(state.chainId); break;
      case 'eth_getBlockByNumber': {
        const h = params[0] === 'latest' ? state.height : Number(BigInt(params[0]));
        result = { number: q(h), hash: blockHash(h), timestamp: q(Math.floor(Date.now() / 1000) - state.age), transactions: blocks.get(h) ?? [] }; break;
      }
      case 'eth_getTransactionByHash': result = txs.get(params[0]) ?? null; break;
      case 'eth_getTransactionReceipt': result = receipts.get(params[0]) ?? null; break;
      case 'eth_getTransactionCount': {
        assert.ok([src, fee].includes(params[0])); assert.ok(['latest', 'pending'].includes(params[1]));
        result = q(params[0] === src ? params[1] === 'pending' ? state.srcPending : state.srcNonce : params[1] === 'pending' ? state.feePending : state.feeNonce); break;
      }
      case 'eth_getBalance': assert.equal(params[1].requireCanonical, true); result = q(params[0] === src ? state.balance : state.reserve); break;
      case 'eth_getCode': assert.equal(params[1].requireCanonical, true); result = '0x'; break;
      case 'eth_gasPrice': result = q(state.price); break;
      case 'eth_call': {
        assert.equal(params[0].to, contract);
        if (params[0].data === '0x313ce567') { assert.equal(params[1].requireCanonical, true); result = toBeHex(state.decimals, 32); }
        else if (params[0].data === '0x70a08231' + pad(src).slice(2)) { assert.equal(params[1].requireCanonical, true); result = toBeHex(state.tokenBalance, 32); }
        else { assert.equal(params[0].data, calldata(dest, amount)); assert.equal(params[0].from, src); result = state.tokenReturn; }
        break;
      }
      case 'eth_estimateGas': {
        const c = params[0]; assert.equal(c.gasPrice, undefined);
        if (c.to === contract) { assert.equal(c.from, src); assert.equal(c.data, calldata(dest, amount)); assert.equal(c.value, '0x0'); result = q(state.gasToken); }
        else { assert.equal(c.data, '0x'); result = q(c.from === fee ? 21_000n : state.gasNative); }
        break;
      }
      case 'eth_sendRawTransaction': {
        assert.ok(durable.has(params[0]), 'broadcast before durable queue persistence');
        const t = Transaction.from(params[0]); sent.push(params[0]); txs.set(t.hash!, projection(t));
        if (t.from!.toLowerCase() === src) state.srcPending = t.nonce + 1; else state.feePending = t.nonce + 1;
        result = t.hash; break;
      }
      default: throw Error('Unexpected method: ' + method);
    }
    return Response.json({ id: rpcId, jsonrpc: '2.0', result: state.change(method, params, structuredClone(result)) });
  };
  const adapter = (options: EvmSweepOptions = {}, signing = signer) => createEvmSweepAdapter('https://fixture.invalid/', signing, { fetch: mock,
    readCommittedStep: async (jobId, phase) => jobId === intent.jobId ? steps.get(phase) ?? null : null, ...options });
  return { ...adapter(), adapter, signer, intent, state, contract, steps, persist, sent, calls, mine, txs, receipts, blocks, deposit, depositRaw };
}
const stop = (code: SweepReason) => (e: unknown) => e instanceof SweepStop && e.code === code && e.message === code;

for (const chain of ['ETH', 'BSC', 'POL'] as const) {
  test(`${chain} native: signs only the credited budget, persists before sending, waits for canonical finality`, async () => {
    const f = await fixture(chain), i = f.intent;
    f.state.gasNative = chain === 'POL' ? 41_789n : 21_000n;
    await f.verifyDeposit(i);
    const s = await f.prepare(i, null), t = Transaction.from(s.raw);
    assert.equal(s.phase, 'sweep'); assert.equal(s.nonce, '7'); assert.equal(s.lastValidBlockHeight, null);
    assert.equal(t.type, 0); assert.equal(t.chainId, BigInt(nets[chain][0])); assert.equal(t.from, receiver.address);
    assert.equal(t.to, treasury.address); assert.equal(t.data, '0x'); assert.equal(t.value, s.amount);
    assert.equal(t.gasPrice! * t.gasLimit, s.fee); assert.equal(t.value + s.fee, i.amount); assert.ok(i.amount > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(s.txid, keccak256(s.raw)); assert.equal(f.sent.length, 0);
    assert.deepEqual(await f.inspect(i, s), { state: 'unseen' });
    const persisted = structuredClone(s); f.persist(persisted);
    await f.broadcast(i, persisted); await f.broadcast(i, persisted);
    assert.deepEqual(f.sent, [s.raw]); assert.equal(f.state.signCalls, 1);
    assert.deepEqual(await f.inspect(i, s), { state: 'pending' });
    f.mine(s.raw, 112); assert.deepEqual(await f.inspect(i, s), { state: 'included', blockHash: blockHash(112), blockNumber: 112, networkFee: 21_000n * unit });
    f.state.height = 114; assert.deepEqual(await f.inspect(i, s), { state: 'final', blockHash: blockHash(112), blockNumber: 112, networkFee: 21_000n * unit });
    await f.broadcast(i, s); assert.deepEqual(f.sent, [s.raw]);
  });
  test(`${chain} canonical USDT: exact ABI units, a single finalized subsidy, recovered payer and matching Transfer`, async () => {
    const f = await fixture(chain, true), i = f.intent;
    // Extra native may belong to another credited job; a token sweep cannot take it for gas.
    const subsidy = await f.prepare(i, null), funding = Transaction.from(subsidy.raw);
    const padded = (f.state.gasToken * 12n + 9n) / 10n;
    assert.equal(subsidy.phase, 'sponsor'); assert.equal(subsidy.nonce, '2'); assert.equal(subsidy.amount, padded * unit);
    assert.equal(funding.from, reserve.address); assert.equal(funding.to, receiver.address);
    assert.equal(funding.value, subsidy.amount); assert.equal(funding.gasLimit, 21_000n); assert.equal(funding.data, '0x');
    assert.equal(f.sent.length, 0); await assert.rejects(f.prepare(i, subsidy), stop('not_final'));
    f.persist(subsidy); await f.broadcast(i, subsidy);
    f.mine(subsidy.raw, 112); await assert.rejects(f.prepare(i, subsidy), stop('not_final'));
    f.state.height = 114;
    const signed = await f.prepare(i, subsidy), t = Transaction.from(signed.raw);
    assert.equal(signed.phase, 'sweep'); assert.equal(signed.amount, i.amount); assert.equal(signed.nonce, '7');
    assert.equal(t.from, receiver.address); assert.equal(t.to!.toLowerCase(), nets[chain][3]); assert.equal(t.value, 0n);
    assert.equal(t.data, calldata(treasury.address, i.amount)); assert.equal(t.data.length, 138); assert.equal(signed.fee, subsidy.amount);
    f.persist(signed); await f.broadcast(i, signed);
    f.mine(signed.raw, 115, [event(f.contract, i.source, i.destination, i.amount)], 16); f.state.height = 117;
    assert.deepEqual(await f.inspect(i, signed), { state: 'final', blockHash: blockHash(115), blockNumber: 115, networkFee: 50_000n * unit });
    assert.deepEqual(f.sent, [subsidy.raw, signed.raw]);
    assert.ok(f.calls.some(c => c.method === 'eth_call' && c.params[0].data === '0x313ce567' && c.params[1].blockHash === i.depositBlockHash));
  });
}

test('rejects wrong networks/assets, zero or coincident roles, malformed identities and mismatched derived address', async () => {
  const f = await fixture('BSC', true), i = f.intent;
  for (const bad of [{ assetId: 'USDT' }, { assetId: 'USDT.ERC20' }, { destination: ZeroAddress }, { destination: i.source },
    { destination: i.sponsor! }, { destination: f.contract }, { destination: 'pay.eth' }, { requiredConf: 0 }, { depositIndex: -1 }, { amount: 0n }]) {
    await assert.rejects(f.prepare({ ...i, ...bad }, null), stop('invalid_intent'));
  }
  for (const bad of [{ source: treasury.address }, { derivIndex: 8 }, { sponsor: i.source }, { sponsor: null }]) {
    await assert.rejects(f.prepare({ ...i, ...bad }, null), stop('unowned'));
  }
  await assert.rejects(f.prepare({ ...i, chainId: 'SOL' }, null), stop('wrong_chain'));
  f.state.chainId = 1; await assert.rejects(f.prepare(i, null), stop('wrong_chain')); f.state.chainId = 56;
  f.state.decimals = 6; await assert.rejects(f.verifyDeposit(i), stop('invalid_intent'));
  assert.equal(f.state.signCalls, 0); assert.equal(f.sent.length, 0);
});

test('signs the exact 0.1 USDT collection amount on every EVM route',async()=>{
  for(const chain of ['ETH','BSC','POL'] as const){
    const amount=10n**BigInt(nets[chain][4]-1),f=await fixture(chain,true,amount);
    const step=await f.prepare(f.intent,null);
    assert.equal(step.phase,'sponsor');f.persist(step);
    f.mine(step.raw,110);f.state.height=115;
    const sweep=await f.prepare(f.intent,step);
    assert.equal(sweep.amount,amount);
    assert.equal(Transaction.from(sweep.raw).data,calldata(f.intent.destination,amount));
    assert.equal(f.sent.length,0);
  }
});

test('applies the 0.1 USDT dust floor, fresh fee estimate, gas price and aggregate sponsorship ceilings', async () => {
  for (const chain of ['ETH', 'BSC', 'POL'] as const) {
    const small = await fixture(chain, true, 10n ** BigInt(nets[chain][4] - 1) - 1n);
    await assert.rejects(small.prepare(small.intent, null), stop('dust'));
  }
  const f = await fixture('ETH', true), i = f.intent;
  const options = (maxFee: bigint) => f.adapter({ feePolicy: { ETH: { maxFee, maxGasPrice: unit } } });
  const budget = 21_000n * unit + (f.state.gasToken * 12n + 9n) / 10n * unit;
  await assert.rejects(options(budget - 1n).prepare(i, null), stop('fee_limit'));
  const s = await options(budget).prepare(i, null); assert.equal(s.fee + s.amount, budget);
  f.state.price = unit + 1n; await assert.rejects(options(budget).prepare(i, null), stop('fee_limit'));
  f.state.price = unit; f.state.gasToken = 120_001n; await assert.rejects(f.prepare(i, null), stop('fee_limit'));
  f.state.gasToken = 0n; await assert.rejects(f.prepare(i, null), stop('fee_limit'));
  await assert.rejects(options(10n ** 18n).prepare(i, null), stop('fee_limit'));
  const dust = await fixture('ETH', false, 21_000n * unit); await assert.rejects(dust.prepare(dust.intent, null), stop('dust'));
  assert.equal(f.state.signCalls, 1); assert.equal(f.sent.length, 0);
});

test('checks confirmed AND current inventory; no sponsorship for a delegated source, reverting token or insufficient reserve', async () => {
  const n = await fixture(), token = await fixture('POL', true);
  for (const h of [110, 112]) {
    n.state.change = (m, p, v) => m === 'eth_getBalance' && p[1].blockHash === blockHash(h) ? q(n.intent.amount - 1n) : v;
    await assert.rejects(n.prepare(n.intent, null), stop('insufficient_funds'));
    token.state.change = (m, p, v) => m === 'eth_call' && p[0].data.startsWith('0x70a08231') && p[1].blockHash === blockHash(h) ? toBeHex(token.intent.amount - 1n, 32) : v;
    await assert.rejects(token.prepare(token.intent, null), stop('insufficient_funds'));
  }
  token.state.change = (m, p, v) => m === 'eth_getCode' && p[0] === token.intent.source ? '0xef0100' + '11'.repeat(20) : v;
  await assert.rejects(token.prepare(token.intent, null), stop('unowned'));
  token.state.change = (_m, _p, v) => v; token.state.reserve = 1n;
  await assert.rejects(token.prepare(token.intent, null), stop('insufficient_funds'));
  for (const bad of ['0x', toBeHex(0n, 32), '0x01', toBeHex(2n, 32)]) {
    token.state.tokenReturn = bad; await assert.rejects(token.prepare(token.intent, null), stop('invalid_receipt'));
  }
  assert.equal(n.state.signCalls + token.state.signCalls, 0);
});

test('verifies original credited event/transaction, canonical hash and confirmation count rather than trusting a balance', async () => {
  const n = await fixture(), f = await fixture('ETH', true), i = n.intent;
  n.state.height = 101; await assert.rejects(n.verifyDeposit(i), stop('not_final')); n.state.height = 112;
  n.state.age = 300; await assert.rejects(n.verifyDeposit(i), stop('unavailable')); n.state.age = 0;
  await assert.rejects(n.verifyDeposit({ ...i, depositBlockHash: id('former fork') }), stop('orphaned'));
  // Both the credited amount and matching provider projection are fabricated. The actual signed hash still binds the real value.
  n.txs.get(i.depositTxid)!.value = q(i.amount + 1n); await assert.rejects(n.verifyDeposit({ ...i, amount: i.amount + 1n }), stop('invalid_receipt'));
  const original = f.deposit.logs[0]!;
  for (const mutation of [{ address: treasury.address }, { removed: true }, { topics: [transferTopic, pad(external.address), pad(treasury.address)] },
    { data: toBeHex(f.intent.amount - 1n, 32) }, { transactionHash: id('other') }, { logIndex: '0x8' }]) {
    f.receipts.get(f.intent.depositTxid)!.logs = [{ ...original, ...mutation }];
    await assert.rejects(f.prepare(f.intent, null), stop('invalid_receipt'));
  }
  f.receipts.delete(f.intent.depositTxid); await assert.rejects(f.verifyDeposit(f.intent), stop('ambiguous'));
  assert.equal(n.state.signCalls + f.state.signCalls, 0);
});

test('fee changes can use existing headroom, never a second subsidy or unrelated native funds', async () => {
  const f = await fixture('ETH', true), i = f.intent;
  f.state.balance = 0n;
  const s = await f.prepare(i, null); f.state.price += 1n;
  f.persist(s); await f.broadcast(i, s); f.mine(s.raw, 110);
  const token = await f.prepare(i, s);
  assert.ok(token.fee <= s.amount); assert.ok(Transaction.from(token.raw).gasLimit >= f.state.gasToken);
  f.state.price *= 2n; f.state.balance = 10n ** 19n;
  await assert.rejects(f.prepare(i, s), stop('fee_limit')); assert.deepEqual(f.sent, [s.raw]);
  f.state.price = unit; f.state.balance = 0n; await assert.rejects(f.prepare(i, s), stop('insufficient_funds'));
});

test('cannot reinterpret a subsidy as player credit or prove it with altered receiver/value/payer', async () => {
  const f = await fixture('ETH', true), i = f.intent, s = await f.prepare(i, null); f.mine(s.raw, 110);
  const fakeCredit = { ...i, assetId: 'ETH', depositTxid: s.txid, depositIndex: -1, depositBlock: 110, depositBlockHash: blockHash(110), amount: s.amount };
  await assert.rejects(f.verifyDeposit(fakeCredit), stop('invalid_intent'));
  const tx = f.txs.get(s.txid)!, receipt = f.receipts.get(s.txid)!;
  for (const mutation of [{ value: q(s.amount + 1n) }, { to: treasury.address }, { from: external.address }, { r: id('bad signature') }]) {
    f.txs.set(s.txid, { ...tx, ...mutation }); assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'invalid_receipt' });
  }
  f.txs.set(s.txid, tx); f.receipts.set(s.txid, { ...receipt, to: treasury.address });
  await assert.rejects(f.prepare(i, s), stop('invalid_receipt'));
});

test('a token receipt must have exactly one matching, nonremoved canonical Transfer from the signed source', async () => {
  const f = await fixture('BSC', true), i = f.intent, funding = await f.prepare(i, null); f.mine(funding.raw, 109);
  const s = await f.prepare(i, funding), e = event(f.contract, i.source, i.destination, i.amount);
  const receipt = f.mine(s.raw, 110, [e], 11), l = receipt.logs[0]!;
  for (const [logs, reason] of [
    [[], 'ambiguous'], [[{ ...l, address: external.address }], 'ambiguous'], [[l, { ...l, logIndex: '0xc' }], 'ambiguous'],
    [[l, l], 'invalid_receipt'], [[{ ...l, removed: true }], 'invalid_receipt'], [[{ ...l, transactionHash: i.depositTxid }], 'invalid_receipt'],
    [[{ ...l, blockHash: id('stale log') }], 'invalid_receipt'], [[{ ...l, data: toBeHex(i.amount + 1n, 32) }], 'invalid_receipt'],
    [[{ ...l, topics: [transferTopic, pad(external.address), pad(i.destination)] }], 'invalid_receipt'],
    [[{ ...l, topics: [transferTopic, pad(i.source), pad(external.address)] }], 'invalid_receipt'],
    [[{ ...l, topics: [transferTopic, '0x01' + pad(i.source).slice(4), pad(i.destination)] }], 'invalid_receipt'],
  ] as const) {
    f.receipts.set(s.txid, { ...receipt, logs }); assert.deepEqual(await f.inspect(i, s), { state: 'review', reason });
  }
  for (const mutation of [{ status: '0x0' }, { status: null }, { status: '0x2' }, { from: external.address }, { transactionIndex: '0x1' },
    { transactionHash: id('other') }, { gasUsed: q(150_000) }, { effectiveGasPrice: q(f.state.price + 1n) }]) {
    f.receipts.set(s.txid, { ...receipt, ...mutation }); assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'invalid_receipt' });
  }
  f.receipts.set(s.txid, { ...receipt, blockHash: id('reorg') }); assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'orphaned' });
  f.receipts.set(s.txid, receipt); f.state.height = 108; assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'ambiguous' });
  f.state.height = 112; f.receipts.delete(s.txid); assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'ambiguous' });
});

test('checks signing output and every persisted envelope before broadcast; never signs a replacement', async () => {
  const f = await fixture(), i = f.intent, s = await f.prepare(i, null);
  const impostor = { ...f.signer, signEvmSweep: async () => external.signTransaction({ type: 0, chainId: 1, nonce: 7, gasLimit: 21_000, gasPrice: unit, value: s.amount, to: i.destination }) };
  await assert.rejects(f.adapter({}, impostor).prepare(i, null), stop('unowned'));
  for (const bad of [{ txid: id('other') }, { amount: s.amount + 1n }, { nonce: '07' }, { phase: 'sponsor' as const }, { raw: s.raw + '00' }]) {
    await assert.rejects(f.broadcast(i, { ...s, ...bad }), stop('invalid_intent'));
  }
  const alternate = await receiver.signTransaction({ type: 0, chainId: 1, nonce: 7, gasLimit: 21_000, gasPrice: unit, value: s.amount, to: external.address });
  await assert.rejects(f.broadcast(i, { ...s, raw: alternate, txid: keccak256(alternate) }), stop('invalid_intent'));
  f.persist(s);
  f.state.srcPending++; await assert.rejects(f.prepare(i, null), stop('nonce_conflict'));
  assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'nonce_conflict' });
  await assert.rejects(f.broadcast(i, s), stop('nonce_conflict')); f.state.srcNonce++;
  assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'nonce_conflict' });
  assert.equal(f.state.signCalls, 1); assert.deepEqual(f.sent, []);
});

test('response lost after submission: reconcile the already-known hash without sending or signing again', async () => {
  const f = await fixture(), i = f.intent, s = await f.prepare(i, null);
  f.persist(s); f.state.change = (m, _p, v) => { if (m === 'eth_sendRawTransaction') throw Error('RPC echoed unsafe data'); return v; };
  await assert.rejects(f.broadcast(i, s), stop('unavailable'));
  assert.deepEqual(f.sent, [s.raw]); assert.deepEqual(await f.inspect(i, s), { state: 'pending' });
  await f.broadcast(i, s); assert.equal(f.state.signCalls, 1); assert.deepEqual(f.sent, [s.raw]);
  f.state.srcNonce++;
  assert.deepEqual(await f.inspect(i, s), { state: 'review', reason: 'nonce_conflict' });
});

test('fails closed on stale data during broadcast, malformed/wrong-hash RPC responses and timeouts', async () => {
  const f = await fixture(), i = f.intent, s = await f.prepare(i, null); f.persist(s);
  f.state.balance = i.amount - 1n; await assert.rejects(f.broadcast(i, s), stop('insufficient_funds'));
  f.state.balance = i.amount; f.state.gasNative = 30_000n; await assert.rejects(f.broadcast(i, s), stop('fee_limit'));
  f.state.gasNative = 21_000n; f.state.chainId = 56; await assert.rejects(f.broadcast(i, s), stop('wrong_chain')); f.state.chainId = 1;
  assert.deepEqual(f.sent, []);
  f.state.change = (m, _p, v) => m === 'eth_sendRawTransaction' ? id('unexpected hash') : v;
  await assert.rejects(f.broadcast(i, s), stop('ambiguous'));
  for (const body of [{ id: 99, jsonrpc: '2.0', result: '0x1' }, { id: 1, jsonrpc: '2.0', error: { message: 'secret URL' }, result: '0x1' }]) {
    await assert.rejects(f.adapter({ fetch: async () => Response.json(body) }).verifyDeposit(i), stop('unavailable'));
  }
  let signal: AbortSignal | null | undefined;
  // A broken transport that ignores cancellation still cannot hold the worker lock indefinitely.
  const never: typeof fetch = async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); };
  await assert.rejects(f.adapter({ fetch: never, rpcTimeoutMs: 15 }).verifyDeposit(i), stop('unavailable')); assert.equal(signal?.aborted, true);
});

test('broadcast requires same-job committed bytes; caller mutations across awaits cannot change the packet', async () => {
  const f = await fixture(), i = f.intent, s = await f.prepare(i, null), original = s.raw;
  await assert.rejects(f.broadcast(i, s), stop('unavailable'));
  f.persist(s); await assert.rejects(f.adapter({ readCommittedStep: undefined }).broadcast(i, s), stop('unavailable'));
  await assert.rejects(f.broadcast({ ...i, jobId: 'different job' }, s), stop('unavailable'));
  f.steps.set('sweep', { ...s, amount: s.amount + 1n }); await assert.rejects(f.broadcast(i, s), stop('invalid_intent'));
  // An equally valid sweep for the same intent, but a different signed fee, is NOT a replacement for the committed one.
  f.state.price += 1n; const other = await f.prepare(i, null); f.persist(other);
  await assert.rejects(f.broadcast(i, s), stop('invalid_intent')); assert.deepEqual(f.sent, []);
  f.persist(s);
  const dispatch = f.broadcast(i, s);
  s.raw = other.raw; i.destination = external.address;
  await dispatch; assert.deepEqual(f.sent, [original]);
});

test('token broadcast cannot use unrelated native balance after a missing, immature or orphaned subsidy', async () => {
  const f = await fixture('ETH', true), i = f.intent, fund = await f.prepare(i, null);
  const receipt = f.mine(fund.raw, 110); const token = await f.prepare(i, fund); f.persist(token);
  await assert.rejects(f.broadcast(i, token), stop('unavailable')); // This job has no committed funding record yet.
  f.persist(fund); f.state.height = 111;
  await assert.rejects(f.broadcast(i, token), stop('not_final'));
  f.state.height = 112; f.receipts.set(fund.txid, { ...receipt, blockHash: id('orphaned subsidy') });
  await assert.rejects(f.broadcast(i, token), stop('orphaned')); assert.deepEqual(f.sent, []);
});
