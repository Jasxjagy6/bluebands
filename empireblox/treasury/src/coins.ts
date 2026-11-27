/** Internal denomination. Exactly 6,000 coins = 10 USDT in both directions. */
export const COINS = 'COINS';
export const COIN_DECIMALS = 18;
export const COIN_SCALE = 10n ** BigInt(COIN_DECIMALS);
export const COINS_PER_USDT = 600n;
export const COIN_BASE = COIN_SCALE * COINS_PER_USDT;
