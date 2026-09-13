# Blizz — GPT AI + Wallet + Creator Rewards Upgrade

This build upgrades the Blizz test project with a real server-side GPT-style support brain, a server-authoritative Blizz Coin ledger, gift transfers, creator earnings calculations, payment webhook reconciliation, and a more lively wallet/creator UI.

## Important security model
- The AI does **not** own Blizz and cannot change Founder authority.
- The financial ledger is authoritative; the AI cannot invent or directly edit balances.
- Money/coin mutations happen through server endpoints with validation and transaction IDs.
- Founder-sensitive operations require Founder authorization.
- Never put API keys in the frontend or GitHub.
- The JSON data store is for testing/development. Before a public launch, migrate users, sessions, wallet and ledger data to PostgreSQL/managed storage with backups, encryption, monitoring and strict access control.

## GPT AI setup on Render
In Render → your Blizz service → Environment, add:
- `OPENAI_API_KEY` = your secret OpenAI API key
- `OPENAI_MODEL` = `gpt-5.6-luna` (or another model available to your API account)

The key is read only by `server.js`. It is never sent to the browser.

## Founder controls
Set:
- `FOUNDER_ADMIN_KEY` = a long random secret

Founder-authorized requests can use `X-Founder-Key` server-side. For production, replace the simple bootstrap mechanism with a proper database-backed role/permission system, MFA/passkeys, least privilege and audit logs.

## Coins and payments
The server provides:
- `/api/wallet` — verified balance + ledger history
- `/api/gifts/send` — atomic sender debit + recipient credit
- `/api/payments/webhook` — signed payment-provider adapter endpoint
- `/api/coins/test-credit` — development-only test credits

The payment webhook expects a normalized JSON event:
`{ "event":"coin_purchase", "reference":"provider-reference", "userId":"user-id", "coins":5000 }`

Sign the exact JSON body with HMAC-SHA256 using `PAYMENT_WEBHOOK_SECRET` and send it as `X-Payment-Signature`. Duplicate references are ignored, preventing double-crediting.

A real gateway (such as a provider available in your launch country) must be connected and its official webhook format mapped to this normalized event before selling coins for real money.

## Creator rewards
The server supports the Blizz rule:
- Creator: 60%
- Blizz: 40%

`/api/creator/calculate` is Founder-authorized and finalizes a period using verified eligible views and net ad revenue. It records the period so it cannot be finalized twice.

`/api/creator/payout` approves a payout amount from finalized available creator earnings. A real payout provider still needs to be connected for the actual bank/mobile-money transfer.

## Run locally
Node 18+:
```bash
npm start
```
Then open `http://localhost:8080` (or the configured PORT).

## GitHub / Render
Upload the project files to the root of your existing `blizz` repository, commit to `main`, and let Render redeploy. Then set the environment variables above in Render.
