# BANDITBLOX

BANDITBLOX serves its game lobby, player profiles and crypto wallet on one origin. Player sessions, balances, chat and game state use the project's own PostgreSQL treasury. The legacy Supabase SQL remains as a record of the original game catalog and rules.

The account icon opens `/account/profile`. Wallet deposits use a permanent address for the selected currency and network, with a local QR code and copy action. There is no deposit amount input: the wallet credits the actual on-chain amount after canonical confirmation and review checks. New deposits support ETH, BNB, POL, SOL and USDT on Ethereum, BNB Chain or Polygon. Choosing a deposit currency does not change the playing currency.

Operators enroll the isolated signing worker, network RPCs and pinned public collection destinations under **Admin → Direct wallets**. Keep separate backups of the offline custody seed, worker wrapping-key volume, vault master key and database assignments/signed history. **Settings** controls new address requests and USDT wager limits. Previously issued addresses remain monitored while new requests are paused, subject to their existing chain and asset controls. Each playable coin keeps its own balance; the three USDT routes credit one USDT balance. Withdrawals remain a separate manual review flow.

Hosted checkout is retired. Migration 019 removes its active configuration and freezes its historical payment records; settled ledger entries, balances and audit evidence remain available. There is no active hosted invoice, callback or checkout flow.

The frontend uses `index.html`, `app.js`, `wallet.js` and `assets/`, including the shared `assets/site.css` stylesheet. The header Wallet action opens balances, deposits and withdrawals inside one centered popup; account pages contain profile and activity sections. The Docker Compose deployment serves those files through Caddy and load-balances two treasury replicas. To install, run the complete test suite, configure deposits or deploy, see [the treasury guide](treasury/README.md).
