import { getAddress, getBytes, id, Interface, keccak256, Signature, toQuantity, Transaction, ZeroAddress, ZeroHash } from 'ethers';
import { SweepStop, type SignedSweep, type SweepAdapter, type SweepIntent, type SweepObservation, type SweepReason } from './types.js';

const GWEI = 10n ** 9n;
const networks = {
  ETH: { id: 1n, native: 'ETH', asset: 'USDT.ERC20', token: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, maxGasPrice: 100n * GWEI, maxFee: 10n ** 16n },
  BSC: { id: 56n, native: 'BNB', asset: 'USDT.BEP20', token: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, maxGasPrice: 5n * GWEI, maxFee: 6n * 10n ** 14n },
  POL: { id: 137n, native: 'POL', asset: 'USDT.POL', token: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6, maxGasPrice: 500n * GWEI, maxFee: 6n * 10n ** 16n },
} as const;
type EvmChain = keyof typeof networks;
type Network = typeof networks[EvmChain];
type Fields = Record<string, unknown>;
type Call = { from: string; to: string; data: string; value: string };
type Route = { net: Network; token: boolean; source: string; destination: string; sponsor: string; maxGasPrice: bigint; maxFee: bigint };
type Block = { number: number; hash: string; timestamp: number; transactions: unknown[] };
const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)']);
const transferTopic = id('Transfer(address,address,uint256)');
const minGas = 21_000n;
const nativeGasCap = 100_000n;
const tokenGasCap = 120_000n;
const uintMax = (1n << 256n) - 1n;
const receiptError = 'invalid_receipt';

export type EvmSweepFields = { phase: SignedSweep['phase']; nonce: number; gasPrice: bigint; gasLimit: bigint; amount: bigint };
export interface EvmSweepSigner {
  evmAddress(index: number): string;
  readonly feeAddress: string;
  signEvmSweep(intent: SweepIntent, fields: EvmSweepFields): Promise<string>;
}
export interface EvmSweepOptions {
  fetch?: typeof fetch;
  rpcTimeoutMs?: number;
  /** A worker may tighten either per-transaction bound, never exceed the chain's hard limits. */
  feePolicy?: Partial<Record<EvmChain, { maxGasPrice?: bigint; maxFee?: bigint }>>;
  /** Independent committed queue read, not the transaction that just prepared the step. Without it the adapter cannot send. */
  readCommittedStep?: (jobId: string, phase: SignedSweep['phase']) => Promise<SignedSweep | null>;
}

function check(test: unknown, reason: SweepReason): asserts test { if (!test) throw new SweepStop(reason); }
function object(v: unknown, reason: SweepReason): Fields {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), reason);
  return v as Fields;
}
function uint(v: unknown): v is bigint { return typeof v === 'bigint' && v >= 0n && v <= uintMax; }
function quantity(v: unknown, reason: SweepReason = 'unavailable'): bigint {
  check(typeof v === 'string' && /^0x(?:0|[1-9a-f][a-f0-9]{0,63})$/i.test(v), reason);
  return BigInt(v);
}
function index(v: unknown, reason: SweepReason): number {
  const n = quantity(v, reason);
  check(n <= BigInt(Number.MAX_SAFE_INTEGER), reason);
  return Number(n);
}
function word(v: unknown, reason: SweepReason): string {
  check(typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v), reason);
  return v.toLowerCase();
}
function address(v: unknown, reason: SweepReason): string {
  check(typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v), reason);
  try { return getAddress(v).toLowerCase(); } catch { throw new SweepStop(reason); }
}
function equalAddr(v: unknown, expected: string, reason: SweepReason): void { check(address(v, reason) === expected, reason); }
function terms(i: SweepIntent, signer: EvmSweepSigner, options: EvmSweepOptions): Route {
  check(Object.hasOwn(networks, i.chainId) && i.chainId !== 'SOL', 'wrong_chain');
  const net = networks[i.chainId], token = i.assetId === net.asset;
  check((token || i.assetId === net.native) && uint(i.amount) && i.amount > 0n && typeof i.jobId === 'string' && i.jobId.length > 0, 'invalid_intent');
  if (token) check(i.amount >= 10n ** BigInt(net.decimals), 'dust');
  check(Number.isSafeInteger(i.derivIndex) && i.derivIndex >= 0 && i.derivIndex < 2 ** 31 &&
    Number.isSafeInteger(i.requiredConf) && i.requiredConf >= 1 && Number.isSafeInteger(i.depositBlock) && i.depositBlock > 0 &&
    (token ? Number.isSafeInteger(i.depositIndex) && i.depositIndex >= 0 : i.depositIndex === -1), 'invalid_intent');
  word(i.depositTxid, 'invalid_intent'); word(i.depositBlockHash, 'invalid_intent');
  const source = address(i.source, 'unowned'), destination = address(i.destination, 'invalid_intent');
  const sponsor = address(signer.feeAddress, 'unowned');
  equalAddr(signer.evmAddress(i.derivIndex), source, 'unowned');
  if (token || i.sponsor !== null) equalAddr(i.sponsor, sponsor, 'unowned');
  check(new Set([source, destination, sponsor, ZeroAddress, net.token]).size === 5, 'invalid_intent');
  const policy = options.feePolicy?.[i.chainId];
  const maxGasPrice = policy?.maxGasPrice ?? net.maxGasPrice, maxFee = policy?.maxFee ?? net.maxFee;
  check(uint(maxGasPrice) && maxGasPrice > 0n && maxGasPrice <= net.maxGasPrice && uint(maxFee) && maxFee > 0n && maxFee <= net.maxFee, 'fee_limit');
  return { net, token, source, destination, sponsor, maxGasPrice, maxFee };
}
function payment(r: Route, phase: SignedSweep['phase'], amount: bigint): Call {
  if (phase === 'sponsor') return { from: r.sponsor, to: r.source, data: '0x', value: toQuantity(amount) };
  return r.token ? { from: r.source, to: r.net.token, data: erc20.encodeFunctionData('transfer', [r.destination, amount]), value: '0x0' } :
    { from: r.source, to: r.destination, data: '0x', value: toQuantity(amount) };
}
function envelope(i: SweepIntent, r: Route, s: SignedSweep): Transaction {
  check((s.phase === 'sweep' || (s.phase === 'sponsor' && r.token)) &&
    uint(s.amount) && s.amount > 0n && uint(s.fee) && s.fee > 0n && s.lastValidBlockHeight === null &&
    typeof s.raw === 'string' && s.raw.length <= 2048 && /^0x(?:[\da-f]{2})+$/i.test(s.raw), 'invalid_intent');
  let t: Transaction;
  try {
    t = Transaction.from(s.raw);
    check(t.isSigned() && t.isLegacy() && t.chainId === r.net.id && t.serialized === s.raw.toLowerCase() &&
      t.hash === word(s.txid, 'invalid_intent') && t.hash === keccak256(s.raw) && t.nonce.toString() === s.nonce, 'invalid_intent');
    const expected = payment(r, s.phase, s.amount);
    equalAddr(t.from, expected.from, 'unowned'); equalAddr(s.from, expected.from, 'unowned'); equalAddr(t.to, expected.to, 'invalid_intent');
    check(t.data === expected.data && t.value === BigInt(expected.value), 'invalid_intent');
    const cap = s.phase === 'sponsor' ? minGas : r.token ? tokenGasCap : nativeGasCap;
    check(t.gasLimit >= minGas && t.gasLimit <= cap && t.gasPrice > 0n && t.gasPrice <= r.maxGasPrice &&
      s.fee === t.gasPrice * t.gasLimit && s.fee <= r.maxFee, 'fee_limit');
    if (s.phase === 'sponsor') check(s.amount + s.fee <= r.maxFee, 'fee_limit');
    else check(r.token ? s.amount === i.amount : s.amount + s.fee === i.amount, 'invalid_intent');
  } catch (e) { if (e instanceof SweepStop) throw e; throw new SweepStop('invalid_intent'); }
  return t;
}

// Reconstruct the signed transaction from the RPC projection. A provider must not be able to change
// a deposit's value or a sponsor's recipient while merely repeating the expected transaction hash.
function projected(value: unknown, txid: string, net: Network, proof: { height: number; hash: string; pos: number; from: string; to: string; used: bigint; price: bigint } | null) {
  const v = object(value, receiptError);
  try {
    check(word(v.hash, receiptError) === txid, receiptError);
    if (proof) {
      check(word(v.blockHash, receiptError) === proof.hash && index(v.blockNumber, receiptError) === proof.height && index(v.transactionIndex, receiptError) === proof.pos, receiptError);
      equalAddr(v.from, proof.from, receiptError); equalAddr(v.to, proof.to, receiptError);
    } else check(v.blockHash === null && v.blockNumber === null && v.transactionIndex === null, 'ambiguous');
    const sig = (s: Fields) => {
      check(typeof s.r === 'string' && /^0x[\da-f]{1,64}$/i.test(s.r) && typeof s.s === 'string' && /^0x[\da-f]{1,64}$/i.test(s.s), receiptError);
      const yParity = s.yParity == null ? undefined : index(s.yParity, receiptError);
      check(yParity === undefined || yParity === 0 || yParity === 1, receiptError);
      return Signature.from({ r: s.r, s: s.s, v: quantity(s.v ?? s.yParity, receiptError), yParity });
    };
    const type = index(v.type, receiptError), signature = sig(v);
    check(type <= 4 && (type === 0 ? signature.legacyChainId === net.id : signature.networkV === null) &&
      (v.chainId != null ? quantity(v.chainId, receiptError) === net.id : type === 0), receiptError);
    check(typeof v.input === 'string' && /^0x(?:[\da-f]{2})*$/i.test(v.input), receiptError);
    const t = Transaction.from({ type, chainId: net.id, signature, nonce: index(v.nonce, receiptError), to: address(v.to, receiptError),
      value: quantity(v.value, receiptError), data: v.input, gasLimit: quantity(v.gas, receiptError) });
    if (type <= 1) t.gasPrice = quantity(v.gasPrice, receiptError);
    if (type > 0) { check(Array.isArray(v.accessList), receiptError); t.accessList = v.accessList; }
    if (type >= 2) { t.maxFeePerGas = quantity(v.maxFeePerGas, receiptError); t.maxPriorityFeePerGas = quantity(v.maxPriorityFeePerGas, receiptError); }
    if (type === 3) {
      check(Array.isArray(v.blobVersionedHashes), receiptError);
      t.blobVersionedHashes = v.blobVersionedHashes.map(h => word(h, receiptError)); t.maxFeePerBlobGas = quantity(v.maxFeePerBlobGas, receiptError);
    }
    if (type === 4) {
      check(Array.isArray(v.authorizationList), receiptError);
      t.authorizationList = v.authorizationList.map(entry => {
        const a = object(entry, receiptError);
        return { address: address(a.address, receiptError), nonce: quantity(a.nonce, receiptError), chainId: quantity(a.chainId, receiptError), signature: sig(a) };
      });
    }
    check(t.hash === txid && address(t.from, receiptError) === address(v.from, receiptError), receiptError);
    if (proof) check(proof.used <= t.gasLimit && (type <= 1 ? proof.price === t.gasPrice : proof.price <= t.maxFeePerGas!), receiptError);
    return t;
  } catch (e) { if (e instanceof SweepStop) throw e; throw new SweepStop(receiptError); }
}

/** Worker-only adapter. prepare never submits; only the queue may call broadcast, after committing this exact signed step. */
export function createEvmSweepAdapter(rpcUrl: string, signer: EvmSweepSigner, options: EvmSweepOptions = {}): SweepAdapter {
  const timeout = options.rpcTimeoutMs ?? 8_000;
  const { readCommittedStep, fetch: transport } = options;
  check(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 30_000, 'invalid_intent');
  let requestId = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    check(transport || process.env.NODE_ENV !== 'test', 'unavailable');
    const request = ++requestId, abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new SweepStop('unavailable')); }, timeout);
      }), (async () => {
        const res = await (transport ?? fetch)(rpcUrl, { method: 'POST', redirect: 'error', signal: abort.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) });
        check(res.ok && !res.redirected, 'unavailable');
        const body = object(await res.json(), 'unavailable');
        check(!abort.signal.aborted && body.jsonrpc === '2.0' && body.id === request && Object.hasOwn(body, 'result') && !Object.hasOwn(body, 'error'), 'unavailable');
        return body.result;
      })()]);
    } catch { throw new SweepStop('unavailable'); } // RPC errors can echo credentials and signed bytes.
    finally { clearTimeout(timer); }
  }
  async function network(r: Route) { check(quantity(await rpc('eth_chainId', [])) === r.net.id, 'wrong_chain'); }
  async function block(tag: number | 'latest'): Promise<Block> {
    const b = object(await rpc('eth_getBlockByNumber', [tag === 'latest' ? tag : toQuantity(tag), false]), 'unavailable');
    const number = index(b.number, 'unavailable'), hash = word(b.hash, 'unavailable'), timestamp = index(b.timestamp, 'unavailable');
    check((tag === 'latest' || number === tag) && hash !== ZeroHash && Array.isArray(b.transactions), 'unavailable');
    if (tag === 'latest') {
      const age = Math.floor(Date.now() / 1000) - timestamp;
      check(age >= -30 && age <= 180, 'unavailable');
    }
    return { number, hash, timestamp, transactions: b.transactions };
  }
  async function receipt(txid: string) {
    const raw = await rpc('eth_getTransactionReceipt', [txid]);
    if (raw === null) return null;
    const v = object(raw, receiptError);
    check(word(v.transactionHash, receiptError) === txid && v.contractAddress === null && Array.isArray(v.logs), receiptError);
    const from = address(v.from, receiptError), to = address(v.to, receiptError), height = index(v.blockNumber, receiptError);
    const hash = word(v.blockHash, receiptError), pos = index(v.transactionIndex, receiptError);
    const canonical = await block(height);
    check(canonical.hash === hash, 'orphaned');
    check(word(canonical.transactions[pos], receiptError) === txid, receiptError);
    check(quantity(v.status, receiptError) === 1n, receiptError);
    const used = quantity(v.gasUsed, receiptError), price = quantity(v.effectiveGasPrice, receiptError);
    check(used >= minGas && price > 0n, receiptError);
    const logs = new Map<number, { contract: string; topics: string[]; data: string }>();
    for (const entry of v.logs) {
      const l = object(entry, receiptError), logIndex = index(l.logIndex, receiptError);
      check(!logs.has(logIndex) && l.removed === false && word(l.transactionHash, receiptError) === txid &&
        word(l.blockHash, receiptError) === hash && index(l.blockNumber, receiptError) === height && index(l.transactionIndex, receiptError) === pos &&
        Array.isArray(l.topics) && l.topics.length <= 4 && typeof l.data === 'string' && /^0x(?:[\da-f]{2})*$/i.test(l.data), receiptError);
      logs.set(logIndex, { contract: address(l.address, receiptError), topics: l.topics.map(t => word(t, receiptError)), data: l.data.toLowerCase() });
    }
    return { from, to, height, hash, pos, used, price, logs };
  }
  function transfer(log: { contract: string; topics: string[]; data: string } | undefined, r: Route, from: string | null, to: string, amount: bigint) {
    check(log && log.contract === r.net.token && log.topics.length === 3 && log.topics[0] === transferTopic, receiptError);
    const src = log.topics[1]!, dst = log.topics[2]!;
    check(/^0x0{24}/.test(src) && /^0x0{24}/.test(dst) && (from === null || src.slice(-40) === from.slice(2)) &&
      dst.slice(-40) === to.slice(2) && BigInt(word(log.data, receiptError)) === amount, receiptError);
    return '0x' + src.slice(-40);
  }
  async function decimals(r: Route, tag: unknown) {
    const value = await rpc('eth_call', [{ to: r.net.token, data: erc20.encodeFunctionData('decimals') }, tag]);
    check(BigInt(word(value, receiptError)) === BigInt(r.net.decimals), 'invalid_intent');
  }
  async function verifyDeposit(i: SweepIntent) {
    const r = terms(i, signer, options);
    await network(r);
    const txid = i.depositTxid.toLowerCase(), hash = i.depositBlockHash.toLowerCase();
    const proof = await receipt(txid);
    if (!proof) { check((await block(i.depositBlock)).hash === hash, 'orphaned'); throw new SweepStop('ambiguous'); }
    check(proof.height === i.depositBlock && proof.hash === hash, 'orphaned');
    const tx = projected(await rpc('eth_getTransactionByHash', [txid]), txid, r.net, proof);
    if (r.token) {
      const sender = transfer(proof.logs.get(i.depositIndex), r, null, r.source, i.amount);
      check(sender !== r.source, 'invalid_intent'); // A self-transfer does not increase inventory.
      await decimals(r, { blockHash: hash, requireCanonical: true });
    } else {
      check(tx.value === i.amount && proof.to === r.source, receiptError);
      check(proof.from !== r.source && proof.from !== r.sponsor && proof.from !== r.destination, 'invalid_intent');
    }
    const head = await block('latest');
    check(head.number - i.depositBlock + 1 >= i.requiredConf, 'not_final');
    check((await block(i.depositBlock)).hash === hash, 'orphaned');
  }
  async function nonces(who: string) {
    const [latest, pending] = await Promise.all(['latest', 'pending'].map(tag => rpc('eth_getTransactionCount', [who, tag])));
    return { latest: index(latest, 'unavailable'), pending: index(pending, 'unavailable') };
  }
  async function freeNonce(who: string) {
    const n = await nonces(who);
    check(n.latest === n.pending, 'nonce_conflict');
    return n.latest;
  }
  async function inspect(i: SweepIntent, s: SignedSweep): Promise<SweepObservation> {
    try {
      const r = terms(i, signer, options), t = envelope(i, r, s), txid = t.hash!;
      await network(r);
      const proof = await receipt(txid);
      const raw = await rpc('eth_getTransactionByHash', [txid]);
      if (!proof) {
        if (raw !== null) {
          projected(raw, txid, r.net, null);
          const n = await nonces(address(t.from, 'unowned'));
          check(n.latest === t.nonce && n.pending >= t.nonce, 'nonce_conflict');
          return { state: 'pending' };
        }
        const n = await nonces(address(t.from, 'unowned'));
        check(n.latest === t.nonce && n.pending === t.nonce, 'nonce_conflict');
        return { state: 'unseen' };
      }
      projected(raw, txid, r.net, proof);
      equalAddr(t.from, proof.from, receiptError); equalAddr(t.to, proof.to, receiptError);
      check(proof.price === t.gasPrice && proof.used <= t.gasLimit, receiptError);
      if (s.phase === 'sweep' && r.token) {
        const events = [...proof.logs.values()].filter(l => l.contract === r.net.token && l.topics[0] === transferTopic);
        check(events.length === 1, 'ambiguous');
        transfer(events[0], r, r.source, r.destination, i.amount);
      }
      const head = await block('latest');
      check(head.number >= proof.height, 'ambiguous');
      check((await block(proof.height)).hash === proof.hash, 'orphaned');
      return { state: head.number - proof.height + 1 >= i.requiredConf ? 'final' : 'included', blockNumber: proof.height, blockHash: proof.hash };
    } catch (e) {
      if (e instanceof SweepStop && e.code !== 'unavailable') return { state: 'review', reason: e.code };
      throw e;
    }
  }
  async function inventory(i: SweepIntent, r: Route, who: string, needed: bigint) {
    // Hash-pinned EIP-1898 reads avoid mixing forks; the live read also catches funds spent since the confirmed snapshot.
    const head = await block('latest'), confirmed = head.number - i.requiredConf + 1;
    check(confirmed >= i.depositBlock, 'not_final');
    const safe = confirmed === head.number ? head : await block(confirmed);
    for (const hash of new Set([safe.hash, head.hash])) {
      const tag = { blockHash: hash, requireCanonical: true };
      const balance = quantity(await rpc('eth_getBalance', [who, tag]));
      check(balance >= needed, 'insufficient_funds');
      check(await rpc('eth_getCode', [r.source, tag]) === '0x', 'unowned'); // Never subsidize an EIP-7702-delegated receive address.
      if (who === r.sponsor) check(await rpc('eth_getCode', [who, tag]) === '0x', 'unowned');
      if (r.token) {
        await decimals(r, tag);
        const data = erc20.encodeFunctionData('balanceOf', [r.source]);
        check(BigInt(word(await rpc('eth_call', [{ to: r.net.token, data }, tag]), receiptError)) >= i.amount, 'insufficient_funds');
      }
    }
  }
  async function gas(call: Call, cap: bigint) {
    // No gasPrice in simulation: an unfunded token holder must be able to estimate the exact transfer *before* the sponsor sends anything.
    const estimate = quantity(await rpc('eth_estimateGas', [call]));
    const intrinsic = minGas + BigInt(getBytes(call.data).reduce((n, byte) => n + (byte === 0 ? 4 : 16), 0));
    check(estimate >= intrinsic && estimate <= cap, 'fee_limit');
    return estimate;
  }
  function margin(estimate: bigint, cap: bigint) {
    const padded = estimate === minGas ? estimate : (estimate * 12n + 9n) / 10n;
    check(padded <= cap, 'fee_limit');
    return padded;
  }
  async function tokenGas(r: Route, i: SweepIntent) {
    const call = payment(r, 'sweep', i.amount);
    const result = await rpc('eth_call', [call, 'latest']);
    // Ethereum USDT's legacy transfer has no return value. A false or malformed return never qualifies.
    check((r.net.id === 1n && result === '0x') || BigInt(word(result, receiptError)) === 1n, receiptError);
    return gas(call, tokenGasCap);
  }
  async function prepare(i: SweepIntent, confirmedSponsor: SignedSweep | null): Promise<SignedSweep> {
    const r = terms(i, signer, options);
    await verifyDeposit(i);
    const price = quantity(await rpc('eth_gasPrice', []));
    check(price > 0n && price <= r.maxGasPrice, 'fee_limit');
    // A legacy EIP-155 envelope makes gasPrice a hard upper bound on all three networks. Never bump or replace it.
    const sourceNonce = await freeNonce(r.source);
    let phase: SignedSweep['phase'] = 'sweep', amount = i.amount, limit: bigint, nonce = sourceNonce;
    if (!r.token) {
      check(confirmedSponsor === null, 'invalid_intent');
      await inventory(i, r, r.source, i.amount);
      check(i.amount > price * minGas, 'dust');
      limit = margin(await gas(payment(r, phase, i.amount - price * minGas), nativeGasCap), nativeGasCap);
      check(limit * price <= r.maxFee, 'fee_limit');
      amount -= limit * price;
      check(amount > 0n, 'dust');
      check(await gas(payment(r, phase, amount), nativeGasCap) <= limit, 'fee_limit');
    } else {
      const estimate = await tokenGas(r, i);
      limit = margin(estimate, tokenGasCap);
      if (confirmedSponsor === null) {
        // Existing native balance is not evidence that it belongs to this job. Fund only its bounded token fee.
        phase = 'sponsor'; amount = limit * price;
        limit = await gas(payment(r, phase, amount), minGas);
        check(amount + limit * price <= r.maxFee, 'fee_limit');
        nonce = await freeNonce(r.sponsor);
        await inventory(i, r, r.sponsor, amount + limit * price);
      } else {
        check(confirmedSponsor.phase === 'sponsor', 'invalid_intent');
        const observed = await inspect(i, confirmedSponsor);
        check(observed.state === 'final', observed.state === 'review' ? observed.reason : 'not_final');
        // Price can move while the subsidy confirms. Trim headroom, not the required gas, and never fund twice.
        const affordable = confirmedSponsor.amount / price;
        if (limit > affordable) limit = affordable;
        check(limit >= estimate && limit * price <= r.maxFee, 'fee_limit');
        await inventory(i, r, r.source, limit * price);
      }
    }
    const call = payment(r, phase, amount);
    await network(r);
    const raw = await signer.signEvmSweep(i, { phase, amount, nonce, gasPrice: price, gasLimit: limit });
    check(typeof raw === 'string' && raw.length <= 2048 && /^0x(?:[\da-f]{2})+$/i.test(raw), 'invalid_intent');
    const s: SignedSweep = { phase, amount, fee: limit * price, nonce: String(nonce), raw, txid: keccak256(raw), from: call.from, lastValidBlockHeight: null };
    const signed = envelope(i, r, s);
    check(signed.gasPrice === price && signed.gasLimit === limit, 'invalid_intent');
    return s;
  }
  async function broadcast(i: SweepIntent, s: SignedSweep): Promise<void> {
    const r = terms(i, signer, options), t = envelope(i, r, s);
    async function committed(phase: SignedSweep['phase']) {
      check(readCommittedStep, 'unavailable');
      let row: SignedSweep | null;
      try { row = await readCommittedStep(i.jobId, phase); } catch { throw new SweepStop('unavailable'); }
      check(row, 'unavailable');
      const copy = Object.freeze({ ...row });
      check(copy.phase === phase, 'invalid_intent');
      envelope(i, r, copy);
      return copy;
    }
    const stored = await committed(s.phase);
    // Both envelopes must match their metadata and resolve to the same exact wire transaction.
    check(stored.raw === s.raw, 'invalid_intent');
    const observed = await inspect(i, s);
    if (observed.state === 'review') throw new SweepStop(observed.reason);
    if (observed.state !== 'unseen') return; // Includes the response-lost-after-acceptance case.
    await verifyDeposit(i);
    if (r.token && s.phase === 'sweep') {
      const sponsor = await committed('sponsor'), funded = await inspect(i, sponsor);
      check(funded.state === 'final', funded.state === 'review' ? funded.reason : 'not_final');
      check(s.fee <= sponsor.amount, 'fee_limit');
    }
    const call = payment(r, s.phase, s.amount);
    await inventory(i, r, call.from, t.value + s.fee);
    if (s.phase === 'sponsor') {
      await freeNonce(r.source);
      const price = quantity(await rpc('eth_gasPrice', []));
      const estimate = await tokenGas(r, i);
      check(price > 0n && price <= r.maxGasPrice && estimate * price <= s.amount && margin(estimate, tokenGasCap) * t.gasPrice! === s.amount, 'fee_limit');
    } else if (r.token) check(await tokenGas(r, i) <= t.gasLimit, 'fee_limit');
    check(await gas(call, t.gasLimit) <= t.gasLimit, 'fee_limit');
    check(await freeNonce(call.from) === t.nonce, 'nonce_conflict');
    check((await block(i.depositBlock)).hash === i.depositBlockHash.toLowerCase(), 'orphaned');
    await network(r);
    check(word(await rpc('eth_sendRawTransaction', [stored.raw]), 'ambiguous') === t.hash, 'ambiguous');
  }
  // Do not retain mutable intent/step objects across awaits. All fields in these two contracts are primitives.
  const pin = <T extends object>(record: T): Readonly<T> => Object.freeze({ ...record });
  return { verifyDeposit: i => verifyDeposit(pin(i)), prepare: (i, s) => prepare(pin(i), s && pin(s)),
    inspect: (i, s) => inspect(pin(i), pin(s)), broadcast: (i, s) => broadcast(pin(i), pin(s)) };
}
