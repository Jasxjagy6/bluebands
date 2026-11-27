import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { SweepStop, type SignedSweep, type SweepAdapter, type SweepIntent, type SweepObservation, type SweepReason } from './types.js';
import { createSolRpc, SOL_MAX_VERSION } from '../chains/sol-rpc.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM = '11111111111111111111111111111111';
const U64 = (1n << 64n) - 1n;
const MAX_FEE = 50_000n, MIN_DEPOSIT = 1_000_000n, MAX_RENT = 10_000_000n;
const finalized = { commitment: 'finalized' } as const;
const invalid = 'invalid_receipt';

export type SolSweepFields = { blockhash: string; amount: bigint; fee: bigint };
export interface SolSweepSigner {
  solAddress(index: number): string;
  signSolSweep(intent: SweepIntent, fields: SolSweepFields): Promise<Uint8Array>;
}
export interface SolSweepOptions {
  fetch?: typeof fetch;
  rpcTimeoutMs?: number;
  maxFeeLamports?: bigint;
  minSweepLamports?: bigint;
  /** Independent committed read. An existing step cannot be re-signed; a new, uncommitted step cannot be sent. */
  readCommittedStep?: (jobId: string, phase: SignedSweep['phase']) => Promise<SignedSweep | null>;
}

function check(value: unknown, reason: SweepReason): asserts value { if (!value) throw new SweepStop(reason); }
function obj(v: unknown, reason: SweepReason = invalid): Record<string, unknown> {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), reason);
  return v as Record<string, unknown>;
}
function list(v: unknown): unknown[] { check(Array.isArray(v), invalid); return v; }
function units(v: unknown): bigint {
  check(typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v), invalid);
  const n = BigInt(v);
  check(n <= U64, invalid); return n;
}
function slot(v: unknown): number {
  const n = units(v); check(n <= BigInt(Number.MAX_SAFE_INTEGER), invalid); return Number(n);
}
function bytes58(v: unknown, n: number, reason: SweepReason): Buffer {
  check(typeof v === 'string' && v.length >= n && v.length <= Math.ceil(n * 1.37), reason);
  try {
    const b = base58.decode(v); check(b.length === n && base58.encode(b) === v, reason); return Buffer.from(b);
  } catch { throw new SweepStop(reason); }
}
function owner(address: string, reason: SweepReason): Buffer {
  const b = bytes58(address, 32, reason);
  try {
    const p = ed25519.Point.fromBytes(b, false);
    check(!p.isSmallOrder() && p.isTorsionFree(), reason);
  } catch { throw new SweepStop(reason); }
  return b;
}
function terms(i: SweepIntent) {
  check(i.chainId === 'SOL', 'wrong_chain');
  check(i.assetId === 'SOL' && i.sponsor === null && typeof i.amount === 'bigint' && i.amount > 0n && i.amount <= U64 &&
    typeof i.jobId === 'string' && i.jobId.length > 0 && typeof i.depositId === 'string' && i.depositId.length > 0 &&
    typeof i.keyId === 'string' && i.keyId.length > 0 &&
    Number.isSafeInteger(i.derivIndex) && i.derivIndex >= 0 && i.derivIndex < 2 ** 31 &&
    Number.isSafeInteger(i.depositIndex) && i.depositIndex >= 0 && Number.isSafeInteger(i.depositBlock) && i.depositBlock > 0 &&
    Number.isSafeInteger(i.requiredConf) && i.requiredConf > 0 && i.source !== i.destination, 'invalid_intent');
  bytes58(i.depositTxid, 64, 'invalid_intent'); bytes58(i.depositBlockHash, 32, 'invalid_intent');
  check(i.amount >= MIN_DEPOSIT, 'dust');
  return [owner(i.source, 'unowned'), owner(i.destination, 'invalid_intent')] as const;
}
function transfer(source: Buffer, destination: Buffer, hash: Buffer, lamports: bigint): Buffer {
  // All five shortvec lengths (accounts, instructions, instruction accounts/data, and wire signatures) fit one byte.
  const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(lamports, 4);
  return Buffer.concat([Buffer.from([1, 0, 1, 3]), source, destination, Buffer.alloc(32), hash, Buffer.from([1, 2, 2, 0, 1, 12]), data]);
}

/** Shared with the isolated index signer. There is no arbitrary message, program or instruction input. */
export function buildSolSweepMessage(i: SweepIntent, f: SolSweepFields): Buffer {
  const [source, destination] = terms(i);
  check(typeof f.fee === 'bigint' && f.fee > 0n && f.fee <= MAX_FEE, 'fee_limit');
  check(typeof f.amount === 'bigint' && f.amount > 0n && f.amount + f.fee <= i.amount &&
    i.amount - f.fee - f.amount <= MAX_RENT, 'invalid_intent');
  return transfer(source, destination, bytes58(f.blockhash, 32, 'invalid_intent'), f.amount);
}

function wireBytes(encoded: unknown): Buffer {
  check(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 5464, invalid);
  const b = Buffer.from(encoded, 'base64');
  check(b.length <= (b[0] === 129 ? 4096 : 1232) && b.toString('base64') === encoded, invalid); return b;
}
function envelope(i: SweepIntent, s: SignedSweep) {
  check(s.phase === 'sweep' && s.nonce === null && s.from === i.source && Number.isSafeInteger(s.lastValidBlockHeight) &&
    s.lastValidBlockHeight! > 0, 'invalid_intent');
  const raw = wireBytes(s.raw);
  check(raw.length === 215 && raw[0] === 1, 'invalid_intent');
  const signature = raw.subarray(1, 65), message = raw.subarray(65), blockhash = base58.encode(message.subarray(100, 132));
  check(base58.encode(signature) === s.txid && message.equals(buildSolSweepMessage(i, { blockhash, amount: s.amount, fee: s.fee })) &&
    ed25519.verify(signature, message, message.subarray(4, 36), { zip215: false }), 'invalid_intent');
  return { message, blockhash };
}

// Incoming v1 follows Solana Foundation SIMD-0385; outgoing sweeps stay fixed legacy messages.
// Instruction numbering must match the watcher's outer instruction then its recorded inner instructions.
function creditedTransfer(i: SweepIntent, encoded: unknown, meta: Record<string, unknown>) {
  const raw = wireBytes(encoded), v1 = raw[0] === 129; let pos = 0, end = raw.length;
  function take(n: number) { check(n >= 0 && pos + n <= end, invalid); const b = raw.subarray(pos, pos + n); pos += n; return b; }
  function byte() { return take(1)[0]!; }
  function shortvec() {
    let n = 0;
    for (let shift = 0; shift <= 14; shift += 7) {
      const b = byte(); check(shift !== 14 || b <= 3, invalid);
      n += (b & 127) << shift;
      if (b < 128) { check(shift === 0 || b !== 0, invalid); return n; }
    }
    throw new SweepStop(invalid);
  }
  const count = v1 ? (byte(), byte()) : shortvec(); check(count > 0 && count <= 12, invalid);
  let signatures: Buffer, message: Buffer;
  if (v1) { end -= 64 * count; check(end > pos, invalid); signatures = raw.subarray(end); message = raw.subarray(0, end); }
  else { signatures = take(64 * count); message = raw.subarray(pos); }
  check(base58.encode(signatures.subarray(0, 64)) === i.depositTxid, invalid);
  let v0 = false;
  if (!v1) { const first = byte(); v0 = first === 128; check((v0 ? byte() : first) === count, invalid); }
  const readonlySigners = byte(), readonlyOthers = byte();
  let instructionCount = 0, mask = 0;
  if (v1) {
    mask = take(4).readUInt32LE(); check((mask & ~31) === 0 && ((mask & 3) === 0 || (mask & 3) === 3), invalid);
    take(32); instructionCount = byte(); check(instructionCount <= 64, invalid);
  }
  const keyCount = v1 ? byte() : shortvec();
  check(keyCount >= count && readonlySigners < count && readonlyOthers <= keyCount - count, invalid);
  if (v1) check(keyCount <= 64, invalid);
  const keys: string[] = [];
  for (let k = 0; k < keyCount; k++) {
    const key = take(32); keys.push(base58.encode(key));
    if (k < count) check(ed25519.verify(signatures.subarray(k * 64, (k + 1) * 64), message, key, { zip215: false }), invalid);
  }
  check(new Set(keys).size === keys.length, invalid);
  let instructions: { program: number; accounts: number[]; data: Buffer }[];
  if (v1) {
    for (let bit = 0; bit < 5; bit++) if (mask & (1 << bit)) take(4);
    const headers = Array.from({ length: instructionCount }, () => ({ program: byte(), accounts: byte(), size: take(2).readUInt16LE() }));
    instructions = headers.map(h => ({ program: h.program, accounts: [...take(h.accounts)], data: take(h.size) }));
  } else {
    take(32); // recent blockhash of the deposit, not its inclusion blockhash
    instructions = Array.from({ length: shortvec() }, () => ({ program: byte(), accounts: [...take(shortvec())], data: take(shortvec()) }));
  }
  if (v0) {
    let writable = 0, readonly = 0;
    for (let n = shortvec(); n > 0; n--) { take(32); writable += take(shortvec()).length; readonly += take(shortvec()).length; }
    const loaded = obj(meta.loadedAddresses), w = list(loaded.writable), r = list(loaded.readonly);
    check(w.length === writable && r.length === readonly && keyCount + writable + readonly <= 256, invalid);
    for (const key of [...w, ...r]) { bytes58(key, 32, invalid); keys.push(key as string); }
  }
  check(pos === end, invalid);
  for (const instruction of instructions) check(instruction.program < keys.length && instruction.accounts.every(k => k < keys.length), invalid);
  const inner = new Map<number, unknown[]>();
  if (i.depositIndex > 0) check(Array.isArray(meta.innerInstructions), invalid);
  for (const entry of list(meta.innerInstructions ?? [])) {
    const e = obj(entry), at = slot(e.index);
    check(at < instructions.length && !inner.has(at), invalid); inner.set(at, list(e.instructions));
  }
  let flat = 0;
  for (const [index, outer] of instructions.entries()) {
    const nested = inner.get(index) ?? [];
    if (i.depositIndex >= flat && i.depositIndex <= flat + nested.length) {
      let { program, accounts, data } = outer;
      if (i.depositIndex !== flat) {
        const ix = obj(nested[i.depositIndex - flat - 1]);
        program = slot(ix.programIdIndex); accounts = list(ix.accounts).map(slot);
        check(typeof ix.data === 'string' && ix.data.length <= 1644, invalid);
        try { data = Buffer.from(base58.decode(ix.data)); } catch { throw new SweepStop(invalid); }
      }
      check(keys[program] === SYSTEM && data.length >= 12 && data.readBigUInt64LE(4) === i.amount, invalid);
      const type = data.readUInt32LE();
      check((type === 2 && data.length === 12) || (type === 11 && data.length >= 52 && data.length <= 84 &&
        data.readBigUInt64LE(12) === BigInt(data.length - 52)), invalid);
      const toIndex = accounts[type === 2 ? 1 : 2]!, from = keys[accounts[0]!], to = keys[toIndex];
      check(from && from !== to && to === i.source, invalid);
      const pre = list(meta.preBalances), post = list(meta.postBalances);
      check(pre.length === keys.length && post.length === keys.length && units(post[toIndex]) - units(pre[toIndex]) >= i.amount, invalid); return;
    }
    flat += 1 + nested.length;
  }
  throw new SweepStop(invalid);
}

export function createSolSweepAdapter(rpcUrl: string, signer: SolSweepSigner, options: SolSweepOptions = {}): SweepAdapter {
  const { fetch: transport, readCommittedStep, rpcTimeoutMs = 8000, maxFeeLamports = MAX_FEE, minSweepLamports = 5000n } = options;
  check(Number.isSafeInteger(rpcTimeoutMs) && rpcTimeoutMs > 0 && rpcTimeoutMs <= 30_000 &&
    typeof minSweepLamports === 'bigint' && minSweepLamports > 0n && minSweepLamports <= 1_000_000_000n, 'invalid_intent');
  check(typeof maxFeeLamports === 'bigint' && maxFeeLamports > 0n && maxFeeLamports <= MAX_FEE, 'fee_limit');
  const request = createSolRpc(rpcUrl, { fetch: transport, timeoutMs: rpcTimeoutMs, numbersAsStrings: true, throttle: process.env.NODE_ENV !== 'test' });
  async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    check(transport || process.env.NODE_ENV !== 'test', 'unavailable');
    try { return await request(method, params); } catch { throw new SweepStop('unavailable'); }
  }
  function contextual(v: unknown, minSlot: number) {
    const r = obj(v), contextSlot = slot(obj(r.context).slot);
    check(contextSlot >= minSlot && Object.hasOwn(r, 'value'), 'unavailable'); return { slot: contextSlot, value: r.value };
  }
  async function identity(i: SweepIntent) {
    terms(i); check(signer.solAddress(i.derivIndex) === i.source, 'unowned');
    check(await rpc('getGenesisHash') === GENESIS, 'wrong_chain');
  }
  async function evidence(txid: string) {
    const [history, tx] = await Promise.all([
      rpc('getSignatureStatuses', [[txid], { searchTransactionHistory: true }]),
      rpc('getTransaction', [txid, { ...finalized, encoding: 'base64', maxSupportedTransactionVersion: SOL_MAX_VERSION }]),
    ]);
    const h = contextual(history, 0), rows = list(h.value); check(rows.length === 1, invalid);
    const status = rows[0] === null ? null : obj(rows[0]);
    if (status) {
      check(slot(status.slot) <= h.slot && ['processed', 'confirmed', 'finalized'].includes(String(status.confirmationStatus)) &&
        Object.hasOwn(status, 'err'), invalid);
      if (status.confirmationStatus === 'finalized') check(status.confirmations === null, invalid);
    }
    return { status, tx: tx === null ? null : obj(tx) };
  }
  async function inclusion(txid: string, status: Record<string, unknown>, tx: Record<string, unknown>, i: SweepIntent) {
    const at = slot(tx.slot), meta = obj(tx.meta), wire = list(tx.transaction);
    check(status.confirmationStatus === 'finalized' && slot(status.slot) === at && status.err === null && meta.err === null &&
      wire.length === 2 && wire[1] === 'base64', invalid);
    const [block, head] = await Promise.all([
      rpc('getBlock', [at, { ...finalized, transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: SOL_MAX_VERSION }]),
      rpc('getSlot', [finalized]),
    ]);
    check(block !== null, 'ambiguous');
    const b = obj(block), signatures = list(b.signatures), tip = slot(head);
    bytes58(b.blockhash, 32, invalid);
    check(signatures.filter(s => s === txid).length === 1 && tip >= at, 'ambiguous');
    return { at, blockHash: b.blockhash as string, deep: tip - at >= i.requiredConf - 1, meta, raw: wire[0] };
  }
  async function verifyDeposit(i: SweepIntent) {
    await identity(i);
    const { status, tx } = await evidence(i.depositTxid);
    check(status && status.confirmationStatus === 'finalized', tx ? 'ambiguous' : 'not_final');
    check(tx, 'ambiguous');
    const proof = await inclusion(i.depositTxid, status, tx, i);
    check(proof.at === i.depositBlock && proof.blockHash === i.depositBlockHash, 'orphaned');
    check(proof.deep, 'not_final'); creditedTransfer(i, proof.raw, proof.meta);
  }
  async function accounts(i: SweepIntent) {
    const [pair, minimum] = await Promise.all([
      rpc('getMultipleAccounts', [[i.source, i.destination], { ...finalized, encoding: 'base64', minContextSlot: i.depositBlock }]),
      rpc('getMinimumBalanceForRentExemption', [0, finalized]),
    ]);
    const p = contextual(pair, i.depositBlock), rows = list(p.value), rent = units(minimum);
    check(rent > 0n && rent <= MAX_RENT, 'fee_limit'); check(rows.length === 2, invalid);
    const money = rows.map(row => {
      if (row === null) return 0n;
      const a = obj(row); check(a.owner === SYSTEM && a.executable === false && (a.space === undefined || units(a.space) === 0n) &&
        Array.isArray(a.data) && a.data.length === 2 && a.data[0] === '' && a.data[1] === 'base64', 'unowned');
      return units(a.lamports);
    });
    const [source, destination] = money as [bigint, bigint];
    check(source >= i.amount, 'insufficient_funds'); return { slot: p.slot, source, destination, rent };
  }
  function capacity(i: SweepIntent, a: Awaited<ReturnType<typeof accounts>>, fee: bigint) {
    check(fee > 0n && fee <= maxFeeLamports, 'fee_limit');
    // A zero-data system account can close to zero; never strand a nonzero sub-rent balance or spend another deposit.
    const left = a.source - i.amount, reserve = left > 0n && left < a.rent ? a.rent - left : 0n;
    const amount = i.amount - fee - reserve;
    check(a.source - fee >= a.rent && amount >= minSweepLamports && amount >= fee && a.destination + amount >= a.rent, 'dust');
    check(a.destination + amount <= U64, 'invalid_intent'); return amount;
  }
  async function quote(message: Buffer, minContextSlot: number, stale: 'expired' | 'not_final' = 'expired') {
    const r = contextual(await rpc('getFeeForMessage', [message.toString('base64'), { ...finalized, minContextSlot }]), minContextSlot);
    check(r.value !== null, stale); const fee = units(r.value); check(fee > 0n && fee <= maxFeeLamports, 'fee_limit'); return fee;
  }
  async function active(blockhash: string, until: number, minContextSlot: number, stale: 'expired' | 'not_final' = 'expired') {
    const config = { ...finalized, minContextSlot };
    const [height, valid] = await Promise.all([rpc('getBlockHeight', [config]), rpc('isBlockhashValid', [blockhash, config])]);
    const h = slot(height), ok = contextual(valid, minContextSlot).value;
    check(typeof ok === 'boolean', invalid); check(h <= until && ok, stale);
    check(until - h <= 200, 'ambiguous');
  }
  async function committed(i: SweepIntent) {
    check(readCommittedStep, 'unavailable');
    try {
      const row = await readCommittedStep(i.jobId, 'sweep'); return row === null ? null : Object.freeze({ ...row });
    } catch { throw new SweepStop('unavailable'); }
  }
  async function prepare(i: SweepIntent, sponsor: SignedSweep | null): Promise<SignedSweep> {
    check(sponsor === null, 'invalid_intent'); await verifyDeposit(i);
    if (readCommittedStep) check(await committed(i) === null, 'ambiguous');
    const a = await accounts(i);
    const latest = contextual(await rpc('getLatestBlockhash', [{ ...finalized, minContextSlot: a.slot }]), a.slot);
    const value = obj(latest.value), hash = bytes58(value.blockhash, 32, invalid), blockhash = base58.encode(hash);
    const until = slot(value.lastValidBlockHeight);
    const [source, destination] = terms(i);
    // A stale quote here is retryable: no signature exists yet. An expired persisted step is never replaced.
    const fee = await quote(transfer(source, destination, hash, i.amount), latest.slot, 'not_final');
    const fields = Object.freeze({ blockhash, amount: capacity(i, a, fee), fee });
    const message = buildSolSweepMessage(i, fields);
    check(await quote(message, latest.slot, 'not_final') === fee, 'fee_limit'); // quote the exact final message before signing it
    await active(blockhash, until, latest.slot, 'not_final');
    const signature = await signer.signSolSweep(i, fields);
    check(signature instanceof Uint8Array && signature.length === 64 && ed25519.verify(signature, message, source, { zip215: false }), 'unowned');
    return { phase: 'sweep', raw: Buffer.concat([Buffer.from([1]), signature, message]).toString('base64'), txid: base58.encode(signature),
      from: i.source, amount: fields.amount, fee, nonce: null, lastValidBlockHeight: until };
  }
  async function inspect(i: SweepIntent, s: SignedSweep): Promise<SweepObservation> {
    try {
      const { blockhash } = envelope(i, s); await identity(i);
      const { status, tx } = await evidence(s.txid);
      if (!tx && status?.confirmationStatus !== 'finalized') {
        try { await active(blockhash, s.lastValidBlockHeight!, i.depositBlock); }
        catch (e) { if (status && e instanceof SweepStop && e.code === 'expired') return { state: 'review', reason: 'ambiguous' }; throw e; }
        return { state: status ? 'pending' : 'unseen' };
      }
      check(status?.confirmationStatus === 'finalized' && tx, 'ambiguous');
      const p = await inclusion(s.txid, status, tx, i);
      check(p.at >= i.depositBlock && p.raw === s.raw && (tx.version === undefined || tx.version === 'legacy') && units(p.meta.fee) === s.fee, invalid);
      const pre = list(p.meta.preBalances).map(units), post = list(p.meta.postBalances).map(units);
      check(pre.length === 3 && post.length === 3 && pre[0]! - post[0]! === s.amount + s.fee &&
        post[1]! - pre[1]! === s.amount && pre[2] === post[2], invalid);
      return { state: p.deep ? 'final' : 'included', blockNumber: p.at, blockHash: p.blockHash, networkFee: units(p.meta.fee) };
    } catch (e) { if (e instanceof SweepStop && e.code !== 'unavailable') return { state: 'review', reason: e.code }; throw e; }
  }
  async function broadcast(i: SweepIntent, requested: SignedSweep) {
    const s = await committed(i); check(s, 'unavailable');
    const { message, blockhash } = envelope(i, s);
    check(s.raw === requested.raw && s.txid === requested.txid && s.from === requested.from && s.fee === requested.fee &&
      s.amount === requested.amount && s.lastValidBlockHeight === requested.lastValidBlockHeight &&
      s.nonce === requested.nonce && s.phase === requested.phase, 'invalid_intent');
    const state = await inspect(i, s);
    if (state.state === 'review') throw new SweepStop(state.reason);
    if (state.state !== 'unseen') return;
    await verifyDeposit(i);
    const a = await accounts(i); check(await quote(message, a.slot) === s.fee, 'fee_limit');
    check(s.amount <= capacity(i, a, s.fee) && s.amount >= minSweepLamports && a.destination + s.amount >= a.rent, 'dust');
    const left = a.source - s.amount - s.fee; check(left === 0n || left >= a.rent, 'dust');
    await active(blockhash, s.lastValidBlockHeight!, a.slot);
    const result = await rpc('sendTransaction', [s.raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0, minContextSlot: a.slot }]);
    check(result === s.txid, 'ambiguous');
  }
  return { verifyDeposit: i => verifyDeposit(Object.freeze({ ...i })), prepare: (i, s) => prepare(Object.freeze({ ...i }), s),
    inspect: (i, s) => inspect(Object.freeze({ ...i }), Object.freeze({ ...s })),
    broadcast: (i, s) => broadcast(Object.freeze({ ...i }), Object.freeze({ ...s })) };
}
