import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSolRpc, SolRpcUnavailable } from '../chains/sol-rpc.js';

let next = 0;
const url = () => `https://rpc-${++next}.fixture.invalid/private?token=DO_NOT_REFLECT`;
const unavailable = (error: unknown) => error instanceof SolRpcUnavailable && error.message === 'Solana RPC unavailable';
const reply = (options: RequestInit | undefined, result: unknown) => new Response(JSON.stringify({
  jsonrpc: '2.0', id: JSON.parse(String(options?.body)).id, result,
}));

test('SOL transport shares Retry-After cooldown across paths, methods and scanner/sweeper clients', async () => {
  let time = 1_000_000, calls = 0;
  const endpoint = url(), transport: typeof fetch = async () => { calls++; return new Response('DO_NOT_REFLECT', {
    status: 429, headers: { 'retry-after': '17' },
  }); };
  const first = createSolRpc(endpoint, { fetch: transport, now: () => time, throttle: false });
  const second = createSolRpc(new URL('/other', endpoint).href, { fetch: transport, now: () => time, throttle: false });
  await assert.rejects(first('getSlot'), e => unavailable(e) && (e as SolRpcUnavailable).retryAfterMs === 17_000);
  time += 16_999;
  await assert.rejects(second('getTransaction'), unavailable); assert.equal(calls, 1);
  time++;
  await assert.rejects(second('getTransaction'), unavailable); assert.equal(calls, 2);
});

test('SOL transport honors HTTP-date Retry-After and bounded exponential fallback for 503', async () => {
  let time = 1_800_000_000_000, calls = 0;
  const endpoint = url(), request = createSolRpc(endpoint, { throttle: false, now: () => time,
    fetch: async () => { calls++; return new Response('secret provider text', { status: 503,
      headers: { 'retry-after': calls === 1 ? new Date(time + 23_000).toUTCString() : 'invalid' } }); } });
  await assert.rejects(request('getSlot'), e => unavailable(e) && (e as SolRpcUnavailable).retryAfterMs === 23_000);
  time += 23_000;
  await assert.rejects(request('getSlot'), e => unavailable(e) && (e as SolRpcUnavailable).retryAfterMs === 4000);
  await assert.rejects(request('getBlock'), unavailable); assert.equal(calls, 2);
});

test('SOL transport preserves integers and rejects mismatched, malformed, redirected and oversized responses', async () => {
  assert.throws(() => createSolRpc('DO_NOT_REFLECT'), unavailable);
  const valid = createSolRpc(url(), { throttle: false, fetch: async (_, options) => reply(options, 1) });
  assert.equal(await valid('getSlot'), 1);
  for (const bad of [async () => new Response('{"jsonrpc":"2.0","id":"wrong","result":1}'),
    async () => new Response('{private diagnostic'),
    async () => new Response(Buffer.alloc(4_194_305)),
    async () => Object.defineProperty(new Response('{}'), 'redirected', { value: true }),
    async () => { throw new Error('https://secret.invalid/?key=DO_NOT_REFLECT'); }]) {
    const request = createSolRpc(url(), { throttle: false, fetch: bad as typeof fetch });
    await assert.rejects(request('getSlot'), unavailable);
  }
  const request = createSolRpc(url(), { throttle: false, numbersAsStrings: true, fetch: async (_, options) => {
    const id = JSON.parse(String(options?.body)).id;
    return new Response(`{"jsonrpc":"2.0","id":"${id}","result":{"lamports":9007199254740993,"label":"9007199254740993"}}`);
  } });
  assert.deepEqual(await request('getAccountInfo'), { lamports: '9007199254740993', label: '9007199254740993' });
  const mixed = createSolRpc(url(), { throttle: false, fetch: async (_, options) => {
    const id = JSON.parse(String(options?.body)).id;
    return new Response(`{"jsonrpc":"2.0","id":"${id}","result":[100,9007199254740993]}`);
  } });
  assert.deepEqual(await mixed('getAccountInfo'), [100, '9007199254740993']);
});

test('SOL transport bounds stalled headers and stalled bodies without exposing provider diagnostics', async () => {
  for (const transport of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const request = createSolRpc(url(), { throttle: false, timeoutMs: 20, fetch: transport as typeof fetch });
    const started = Date.now(); await assert.rejects(request('getSlot'), unavailable);
    assert.ok(Date.now() - started < 1000);
  }
});

test('SOL byte budget uses rolling windows and reserves maximum in-flight responses', async () => {
  let time = 500_000, calls = 0;
  const endpoint = url(), request = createSolRpc(endpoint, { now: () => time, fetch: async (_, options) => {
    calls++; return reply(options, 'x'.repeat(3 * 1024 * 1024));
  } });
  await request('getBlock'); time += 1200; await request('getBlock'); time += 1200; await request('getBlock');
  time = 530_001;
  // The first bucket can expire, but the two later responses must not reset with it.
  await request('getBlock'); assert.equal(calls, 4);
  time += 1200;
  await assert.rejects(request('getBlock'), unavailable); assert.equal(calls, 4);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  time = 900_000; calls = 0;
  const parallel = createSolRpc(url(), { now: () => time, fetch: async (_, options) => { calls++; await gate; return reply(options, 0); } });
  const pending = [parallel('a')]; time += 1200; pending.push(parallel('b')); time += 1200; pending.push(parallel('c')); time += 1200;
  await assert.rejects(parallel('d'), unavailable); assert.equal(calls, 3);
  release(); await Promise.all(pending);
});
