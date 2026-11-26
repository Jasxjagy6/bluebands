// Integer money. Every amount is a bigint in an asset's smallest unit
// (wei, sat, 18 decimals for playable USDT). No floats ever touch a balance. Multipliers are
// applied as exact rational arithmetic and always rounded DOWN (house-safe).

export function parseAmount(human: string, decimals: number): bigint {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid amount');
  const parts = s.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function formatAmount(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const d = 10n ** BigInt(decimals);
  const whole = a / d;
  const frac = (a % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/** payout = floor(amount * multiplier). multiplier is a decimal string like "1.98". */
export function applyMultiplier(amount: bigint, multiplier: string): bigint {
  const s = String(multiplier).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid multiplier');
  const parts = s.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  const num = BigInt(whole + frac);        // numerator = digits without the dot
  const den = 10n ** BigInt(frac.length);  // denominator = 10^(fraction length)
  if (amount < 0n) throw new Error('amount must be non-negative');
  return (amount * num) / den;             // integer division floors
}

export function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }
export function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
