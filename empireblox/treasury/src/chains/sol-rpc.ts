import { setTimeout as wait } from 'node:timers/promises';

export const SOL_MAX_VERSION = 1;
export class SolRpcUnavailable extends Error {
  constructor(readonly retryAfterMs = 3000) { super('Solana RPC unavailable'); }
}
export type SolRpcOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  numbersAsStrings?: boolean;
  throttle?: boolean;
  now?: () => number;
};
type Budget = { next: number; methods: Map<string, number>; blocked: number; failures: number;
  received: { at: number; bytes: number }[]; reserved: number };
const budgets = new Map<string, Budget>();
const MAX_RESPONSE = 4_194_304, BYTE_BUDGET = 12 * 1024 * 1024;
let sequence = 0;

/** Shared per origin within a process. The three deployed processes each reserve a conservative share. */
export function createSolRpc(endpoint: string, options: SolRpcOptions = {}) {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new SolRpcUnavailable(); }
  const origin = url.origin;
  const { fetch: transport = fetch, timeoutMs = 8000, throttle = true, now = Date.now } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new SolRpcUnavailable();
  return async (method: string, params: unknown[] = []): Promise<any> => {
    let budget = budgets.get(origin);
    if (!budget) { budget = { next: 0, methods: new Map(), blocked: 0, failures: 0, received: [], reserved: 0 }; budgets.set(origin, budget); }
    const time = now();
    if (budget.blocked > time) throw new SolRpcUnavailable(budget.blocked - time);
    budget.received = budget.received.filter(part => part.at > time - 30_000);
    const used = budget.received.reduce((sum, part) => sum + part.bytes, 0);
    // Reserve the whole maximum response before starting, including concurrent requests.
    if (throttle && used + budget.reserved + MAX_RESPONSE > BYTE_BUDGET)
      throw new SolRpcUnavailable(Math.max(1000, (budget.received[0]?.at ?? time) + 30_000 - time));
    const start = throttle ? Math.max(time, budget.next, budget.methods.get(method) ?? 0) : time;
    // Never retain a database lock while waiting out an unbounded RPC queue.
    if (start - time > 1500) throw new SolRpcUnavailable(start - time);
    if (throttle) { budget.next = start + 500; budget.methods.set(method, start + 1100); }
    let reserved = throttle ? MAX_RESPONSE : 0;
    budget.reserved += reserved;
    const abort = new AbortController(), id = `sol-${++sequence}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (start > time) await wait(start - time);
      if (budget.blocked > now()) throw new SolRpcUnavailable(budget.blocked - now());
      return await Promise.race([new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new SolRpcUnavailable()); }, timeoutMs);
      }), (async () => {
        const res = await transport(url.href, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: abort.signal });
        if (res.status === 429 || res.status === 503) {
          const header = res.headers.get('retry-after'), seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : NaN;
          const date = header ? Date.parse(header) - now() : NaN;
          const fallback = Math.min(60_000, 1000 * 2 ** Math.min(++budget!.failures, 6));
          const delay = Math.max(fallback, Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : 0);
          budget!.blocked = Math.max(budget!.blocked, now() + delay);
          await res.body?.cancel().catch(() => {});
          throw new SolRpcUnavailable(delay);
        }
        if (!res.ok || res.redirected || !res.body || abort.signal.aborted) throw new SolRpcUnavailable();
        const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.length;
            const at = Math.ceil(now() / 1000) * 1000, last = budget!.received[budget!.received.length - 1];
            if (last?.at === at) last.bytes += chunk.value.length;
            else budget!.received.push({ at, bytes: chunk.value.length });
            const consumed = Math.min(reserved, chunk.value.length); reserved -= consumed; budget!.reserved -= consumed;
            if (size > MAX_RESPONSE || abort.signal.aborted) throw new SolRpcUnavailable();
            chunks.push(chunk.value);
          }
        } finally { if (abort.signal.aborted || size > MAX_RESPONSE) await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const text = Buffer.concat(chunks, size).toString('utf8'); JSON.parse(text);
        // Preserve the original integer lexeme even on test runtimes without JSON.parse source context.
        const msg = JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
          token => token.startsWith('"') || (!options.numbersAsStrings && Number.isSafeInteger(Number(token))) ? token : `"${token}"`));
        if (!msg || msg.jsonrpc !== '2.0' || msg.id !== id || Object.hasOwn(msg, 'error') || !Object.hasOwn(msg, 'result')) throw new SolRpcUnavailable();
        budget!.failures = 0;
        return msg.result;
      })()]);
    } catch (error) { throw error instanceof SolRpcUnavailable ? error : new SolRpcUnavailable(); }
    finally { clearTimeout(timer); abort.abort(); budget.reserved -= reserved; reserved = 0; }
  };
}
