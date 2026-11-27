# Coins, conversions and the winter collection

## Player flow

1. Deposit crypto using the existing Wallet popup, permanent receive address, network picker and QR code.
2. The confirmed transfer credits the crypto wallet, not playing coins.
3. Open **Account → Conversion**, select crypto and direction, enter an amount, review the exact server quote, and confirm.
4. All new games debit and pay the server-owned COINS balance.
5. Convert coins back to crypto before making the existing manually reviewed withdrawal request.

Exactly **6,000 coins = 10 USDT** in both directions, with no conversion fee. Other crypto is valued against USDT using live provider legs from the same snapshot. Market prices can change between separate conversions. Receive amounts round down to the receiving asset’s smallest unit; tiny amounts that would receive zero are rejected.

## Accounting

- `COINS` has 18 decimal places. Ledger arithmetic uses bigint/integer NUMERIC, never JavaScript floating point.
- Existing crypto balances, deposit addresses, scans, confirmation policy, custody assignments, collection destinations, holds and signing history are preserved.
- `playing_assets` contains only COINS. `wallet_assets` contains supported canonical crypto balances. Deposit and withdrawal routes remain chain assets, never COINS.
- USDT keeps its existing 18-place unified balance; network USDT precision is still normalized at credit/withdrawal.
- One conversion journal balances independently in crypto and COINS. Its four legs use the existing money movement primitive and `house:conversion` as counterpart.
- Immutable server quotes record exact input/output minor units, the rational exchange rate and the supporting market-quote ID. They last at most 30 seconds, bounded by market expiry.
- All player money operations serialize with account restrictions and the same user lock. The balance cache and immutable ledger commit together.
- `(user_id, request)` and a unique consumed quote prevent duplicate trades. Reusing a request for another quote is a conflict. A replay can recover a completed result after expiry.
- The browser stores only an unresolved request/quote identifier to recover a lost response. Amounts, balances, rates, expiry, cooldowns, eligibility and payouts are authoritative on the server.
- New coin gameplay has a fixed 600-coins-per-USDT valuation and does not call a market provider. Crypto conversion stops when its native price is unavailable; fixed-rate USDT conversion remains available.

## Existing rounds and history

No existing round or receipt is rewritten. Purchased crypto Mines/Blackjack rounds can finish in their original asset. Additional crypto bets are blocked, including insurance, splitting, doubling and new battle seats. An owned legacy battle is still visible and can settle with bots or refund on cancellation. A DB trigger prevents an older API replica from posting crypto wager debits after the currency gate is installed.

Coin statistics use exact coin stakes. Historical crypto results can be presented in coins using their frozen placement valuation; unpriced history is not assigned a current exchange rate. Original financial receipts remain denominated in their actual assets.

## Rewards

The old crypto/USD VIP tier and one-time bonus program is retired. Its tables and historical journals remain as evidence; the old claim endpoint is HTTP 410 and the DB rejects new VIP claims from an older replica.

The active winter collection has 100 player levels and ten daily packs. Existing catalog progress is retained, and settled paid coin wagers in every game count. Each unlocked pack opens once per rolling 24 hours, with disclosed original item odds and direct coin payouts. Free payouts, conversions, deposits and cancelled battle entries cannot manufacture reward progress.

The weekly top-ten coin prizes total 500,000 coins when all ten positions are occupied. Stakes enter a week when their paid round settles, so a cancellable battle cannot win a prize and then refund its stake. A DB transaction barrier orders player settlement and week closure; deterministic ranking, an exclusive season lock and unique payout rows prevent cross-replica duplicate awards. Journals, receipts and notifications commit atomically. Catch-up runs on startup, every minute, and on leaderboard reads.

## Release

Migrations **034–036** add the coin denomination, conversion receipts, winter season bookkeeping and retirement of VIP claims. They do not convert crypto balances or rewrite existing ledger entries.

Run `npm run build` and `npm test` in `treasury/`. Tests use a disposable local Postgres container and local market/RPC fixtures. `coins.int.ts` covers exchange accounting, rejection/retry/concurrency, legacy rounds, rewards and weekly prizes. `coins.browser.ts` covers the real profile conversion flow, lost replies, persistent coin balances, crypto withdrawal, coin statistics, daily packs, mobile layout and motion preferences. Existing deposit/custody/security suites remain in the full runner.

Before a live release, retain a protected database backup and the previous image tag. Roll both API replicas before rebinding the static frontend; `deploy.sh` follows that order and restarts the existing custody worker. Check both replicas’ health, the public coin/crypto catalog, unchanged deposit routes and the new static files. Do not restore an old database over later deposits or conversions. An old crypto-playing API/frontend is not a compatible application-only rollback after the coin gate; preserve funds and roll forward to a corrected coin-compatible build.
