# EmpireBlox treasury

The Node 22 service owns player accounts, opaque HTTP-only sessions, the PostgreSQL double-entry ledger, crypto games, chat, and the deposit watcher. The public frontend, player API and administrator panel share one origin. The Docker Compose stack exposes Caddy on `PUBLIC_PORT` (default 3000).

For the `durov.me` deployment, the host Caddy site reverse-proxies to `127.0.0.1:3000`. Use `PUBLIC_BIND_ADDRESS=127.0.0.1`, `COOKIE_SECURE=true`, and `PUBLIC_SITE_ORIGIN` and `ALLOW_ORIGIN` set to `https://durov.me`. `TRUSTED_EDGE_PROXY` is the exact Compose gateway address seen by the inner Caddy; check it if recreating the Docker network. Do not trust arbitrary client forwarding headers or publish the plaintext admin port. The apex A record must point only to this server; remove records for any previous web host. Verify publicly trusted HTTPS before entering a merchant key.

## Run and verify

Use `npm ci` inside `treasury/`, then `npm run build`. For the full suite, install Chromium with `npx playwright install chromium` and run `npm test`. Docker is required. The test runner creates and removes an isolated PostgreSQL container, applies migrations twice, and runs the unit, API, ledger, chain and browser suites. To use an installed Chromium binary set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

From the project root, `./deploy.sh` builds the backend, applies recorded migrations and rolls the two replicas. Database data lives in the Compose volume. Supply the database password, vault master key and bootstrap admin credentials through the deployment environment. Use the domain's HTTPS listener and secure cookies for real funds. Preserve the vault key and wallet backups separately from the database.

## Deposit setup

**OxaPay hosted checkout is the default for new deposits.** On a deployed treasury, go to **Admin → Settings → OxaPay checkout** and save the OxaPay **merchant API key** (not a payout or general-purpose key). Confirm the deposit method is **OxaPay hosted checkout** and new deposits are not paused. No player addresses, RPC keys, or Solana pool are needed for hosted payments. The key is encrypted in the vault. It is not included in player configuration, audit bodies or key previews.

The site must be reachable over HTTPS on an origin serving both `/account` and `/api`. Set `PUBLIC_SITE_ORIGIN` to that origin in the deployment environment if the treasury does not already have exactly one trusted HTTPS origin in `ALLOW_ORIGIN`. The admin panel shows the callback URL. It must reach `POST /api/oxapay/webhook` without a login, redirect, or proxy that changes request bodies. The server supplies both URLs to OxaPay per invoice. The outgoing connection to `api.oxapay.com` must be available. Sign in with admin two-factor authentication; check out a small real invoice above the displayed minimum before opening deposits to players.

Players enter an amount in their playing currency (or choose another deposit currency), then pay the invoice in that currency on OxaPay. No network is selected on EmpireBlox. Enable the currencies you accept in your OxaPay merchant account. Local **Assets** controls and provider availability still apply. A return URL or screenshot is not proof of payment. Only provider-verified, fully covered invoices post a balanced deposit journal. Partial payments, unverifiable payments or different payment currencies are not credited automatically. Check **Admin → Deposits** against the provider's invoice/tracking reference before resolving an exception; never issue a parallel player credit for an invoice still reconciling.

To pause intake, use **Settings → Pause deposits**. This does not discard paid invoices, callbacks, or transfers to already-issued direct addresses. Pause issuance before rolling over a pre-OxaPay deployment and wait until both replicas have been upgraded before resuming. Before replacing the merchant key, pause new deposits and reconcile outstanding invoices with OxaPay. Keep merchant collection and payout wallets separate from direct player deposit addresses. Direct network controls still govern withdrawals; accepting a coin through OxaPay does not enable its withdrawal route or automate payouts.

Provider reference: [hosted invoices](https://docs.oxapay.com/api-reference/payment/generate-invoice), [payment information](https://docs.oxapay.com/api-reference/payment/payment-information), [signed callbacks](https://docs.oxapay.com/webhook).

### Optional direct wallets

Select **Direct wallet addresses** in Settings only if you intend to re-enable the original deposit flow. Retain its original keys and endpoints while old addresses may receive funds.

Open `/admin`, sign in, and enroll an authenticator under Security. Under Secrets, add an account-level watch-only BIP32 public key named `xpub:EVM`, or a separate `xpub:ETH`, `xpub:BSC`, or `xpub:POL`. Receive paths below that key are `0/index`. Supply the matching mainnet endpoints as `rpc:ETH`, `rpc:BSC` and `rpc:POL`. Each provider must support full blocks, receipts and block-hash-filtered transfer logs. Verify the chain, token contract, minimum amount and confirmation settings in the panel. The wallet offers an address after the scanner establishes a current checkpoint. Private signing keys belong in the owner's custody.

The six network adapters support the following receive methods.

| Network | Receiving material and node requirements |
| --- | --- |
| Ethereum, BNB Chain, Polygon | Account xpub and a mainnet EVM RPC. Direct native transfers and configured ERC-20 transfer events. |
| Bitcoin | `xpub:BTC` from the owner's mainnet native SegWit account (standard xpub serialization) and `rpc:BTC` for a synced Bitcoin Core node. Addresses are P2WPKH. Coinbase mining rewards are excluded. |
| Solana | Import unique unfunded owner public keys from the offline wallet under Admin → Secrets. Keep their private keys and derivation records offline. Set `rpc:SOL` to a mainnet-beta RPC providing finalized full blocks, parsed transactions and inner instructions. Supports native SOL transfers and USDT sent to the owner's associated token account. |
| TRON | `xpub:TRON` and `rpc:TRON` pointing to the mainnet endpoint root that serves `/jsonrpc` and the solidity HTTP API. Accepts direct TRX transfers. |

BTC, Solana and TRON start disabled. Enable each chain in the administrator panel after provisioning it. Monitors stop advancing when a block, receipt or network identity check fails. Deep reorganizations that affect already credited funds need operator reconciliation. The automated suites use local RPC fixtures without spending funds.

## Wallet and games

Currency choice, deposit addresses, balances, game snapshots and history live in PostgreSQL. The site uses session cookies. Native Mines and Blackjack stakes are decimal strings converted to integer minor units. Cases, Upgrader, rewards and battle entries use the existing catalog of 600 units per USD, converted with short-lived market quotes. The server checks the quote on entry. Each battle keeps its entry price through settlement or refund. Market service failure suspends new priced entries until a fresh quote is available.

After all serving replicas have upgraded, set an inclusive minimum and maximum in **Admin → Settings → Wager limits**. A zero minimum or blank maximum disables that bound. Limits are in USDT across all paid games, not in the playing coin. Stakes use recent market conversion at acceptance; pricing failures cannot silently admit unpriced exposure. Paid additions count toward the hand maximum, and refunds, payouts and free entries are not new bets. The separate USD-based reward schedule and native currency histories remain intact.

`GET /api/games/bet-limits` and authenticated `GET /api/admin/bet-limits` return `{"min_usdt":"0","max_usdt":null}` on a new installation. An administrator can `PUT /api/admin/bet-limits` with both fields to replace the pair atomically. Supply nonnegative decimal strings with at most 18 fractional and 60 integer digits. A non-null maximum must be positive and at least the minimum.

The minimum applies to each actual player debit. The maximum applies to the total cash put at risk by that player in that round: blackjack insurance, splits and doubles add to the previously booked stakes at their individual entry rates. A battle uses the cost of that player's seat **after** borrowing, not the sticker price or the combined pot. Late seats keep the original asset entry cost but must pass current limits at a fresh market rate. Rejecting an optional action does not change the hand or balance. Hits, stands, declining insurance, reveals, cashouts, refunds, prizes, bots, free claims and successful request replays do not place a wager or recheck the limits.

Each real debit records its asset minor units and server-issued quote. BNB, BTC, ETH, POL, SOL and USDT use a single Coinbase USD exchange-rate response. TRX uses the bid/ask midpoints for TRX/USD and USDT/USD from **one public Kraken ticker response**. Both books must be present, positive and non-crossed. The two reciprocals share one rounding factor: the stored USD legs must be accurate to one part in 10^16, and their TRX/USDT ratio stays exact. There is no dollar-peg assumption, rounded catalog-unit conversion, or cross-provider fallback for a missing leg.

Quotes expire within two minutes of observation (including HTTP cache age), checked against the database wall clock at acceptance. New paid stakes need a verified valuation even with unbounded limits. A legacy native blackjack hand lacking an opening USDT valuation can finish without adding funds, but cannot add risk under a finite maximum.


## USDT, withdrawals and account activity

Players choose USDT once. Transfers on Ethereum, BNB Chain, Polygon and Solana credit the same USDT ledger balance. The ledger uses 18 decimals and converts each transfer from its network precision. The deposit history keeps the original chain and transaction ID. A disabled network is labelled unavailable in the deposit form. Other supported cryptocurrencies retain their own balances.

The account icon opens `/account/profile`. Deposit, Withdraw, Statistics, Transactions, Bet history, Rewards, Notifications and Security each have a shareable account route. Authentication scopes every player record. The header bell shows the five latest notifications without leaving the current page. The profile overview shows the selected balance, reward progress and recent deposits. Players can update their username and password in Security. Balance and in-game payout displays round USDT to three decimals, ETH to five, POL to two and BNB to four. The ledger, game stakes, receipts and withdrawal confirmations retain the underlying precision. Statistics show cumulative net results or daily wagered amounts by UTC date placed for the selected currency over 7, 30 or 90 days. Settled paid wagers count toward statistics. Individual results include stakes, payouts and game-specific details. Active rounds hide unrevealed outcomes.

Withdrawal requests reserve the exact amount immediately. Players may cancel before review. Under **Admin → Withdrawals**, claim the request and verify the destination, network and amount against the custody wallet. The assigned reviewer approves the request before signing and broadcasting it externally. The reviewer can return reserved funds before sending or record the broadcast transaction ID after sending. Record the on-chain transaction ID once per request. The treasury records the operator's attestation and has no signing key or automated confirmation of outbound transfers.

## Player management and notifications

Under **Admin → Users**, search by full or partial email, username or account ID. Use the status filter to find active, suspended or banned accounts. Select a row for balances, deposit addresses, statistics, deposits, withdrawals, bet results, transactions and operator actions. Under **Controls**, enter a reason and review each adjustment, suspension, ban or restoration. Adjustments post a balanced journal. Bans and suspensions revoke player sessions immediately. A temporary suspension expires at the chosen time.

For a pending deposit, **Deposits → Hold credit for review** preserves the observation and blocks credit. Release the hold to let the watcher recheck the canonical block and confirmation count. Players receive a notification when the scanner detects a deposit and again when it credits the balance. EVM detection follows the configured reorganization safety lag. Outbound requests notify the player when requested, claimed for review, approved, returned or recorded as sent. The withdrawal receipt includes the operator's transaction hash.

Notifications persist in PostgreSQL. A long poll wakes after an event commits, including events written by another replica. Reopening the inbox loads saved activity and read state.

## Level rewards

The Rewards section shows lifetime settled wager, current level, next threshold and available bonuses. Each of the nine tiers contains five levels. Players can claim each earned level once. A claim posts the listed bonus to the unified USDT ledger and records a receipt. Unclaimed levels remain available after reaching higher ones. The Rewards section displays the wager-level program. Previously settled daily-pack entries remain in account history.

New stakes retain their entry-time valuations. Older rounds use their historical valuation where available, not today's market price. The reward screen discloses excluded unpriced historical wagers. Free entries, cancelled battles, deposits, operator credits and bonuses contribute zero wager.

VIP thresholds remain in USD. New settled wagers use the actual USD value of every debit (including USDT); player/admin progress also returns `wagered_usdt`. Statistics keep native stakes and payouts with a separate daily `wagered_usdt`. Reporting truncates each valuation to 18 fractional places, never before a limit comparison. Legacy USD progress stays under its original rules. Legacy USDT is known by denomination; old native wagers with no recorded USDT leg are disclosed via `unpriced_usdt`. The old `users.wagered` sum of mixed minor units is not used for admissions or reporting.

Both player and admin transaction histories can filter deposits, withdrawals, bets, rewards and balance adjustments. A bet filter includes stakes, game payouts and returned battle entries. A withdrawal reservation or refund appears with the current request status and any recorded hash.
