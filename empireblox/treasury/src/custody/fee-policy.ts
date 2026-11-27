import type { SweepChain } from './types.js';

export const sweepFeeCeiling: Record<SweepChain, bigint> = {
  ETH: 10_000_000_000_000_000n, BSC: 600_000_000_000_000n, POL: 60_000_000_000_000_000n, SOL: 50_000n,
};
export const dailySponsorCeilings = 10n;
