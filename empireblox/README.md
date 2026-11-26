# EmpireBlox

EmpireBlox serves its game lobby, player profiles and crypto wallet on one origin. Player sessions, balances, chat and game state use the project's own PostgreSQL treasury. The legacy Supabase SQL remains as a record of the original game catalog and rules.

The account icon opens `/account/profile`. Deposit starts with an amount in the selected playing currency, then opens hosted OxaPay checkout. Choosing a different deposit currency does not change the playing currency. Transaction history, notifications and balances distinguish an issued invoice from a credited payment.

Operators configure the encrypted OxaPay merchant key, optional direct-wallet deposit method, and minimum/maximum USDT bet under **Admin → Settings**. Each playable coin keeps its own balance; USDT uses one wallet instead of one balance per network. Withdrawals remain a separate manual review flow.

The frontend uses `index.html`, `app.js`, `wallet.js` and `assets/`. The Docker Compose deployment serves those files through Caddy and load-balances two treasury replicas. To install, run the complete test suite, configure deposits or deploy, see [the treasury guide](treasury/README.md).
