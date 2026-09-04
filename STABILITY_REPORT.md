# Lightning Pay Stabilization Report

Date: 2026-08-27
Source: local extracted Node.js ZIP (`lighting-cashapp-complete-merged`); no Git repository was used.

## Corrected behavior

- Payments persist the exact integer satoshi amount used to create the invoice.
- Merchant payout and Binance settlement use a single allocation, so the same received funds cannot be allocated twice.
- Settlement operations use persistent, operation-specific jobs with a unique `(payment_id, operation_key)` constraint.
- Duplicate workers cannot claim the same payout, Binance sweep, or Telegram payment notification.
- Temporary failures may retry; invalid credentials become permanent failures; ambiguous timeouts become `unknown` and are not paid again automatically.
- Stale `processing` jobs are quarantined as `unknown` after restart instead of being blindly repeated.
- Manual settlement, payment settlement, and scheduled wallet sweep share a reseller-wallet lock within the Node.js process.
- Zero/below-minimum Binance allocations are held without repeatedly creating failed history records.
- Unsupported Binance on-chain configuration is rejected because the connected gateways execute Lightning payments.
- Telegram payment confirmation is sent immediately after receipt confirmation, uses the stored integer satoshi amount, and is idempotent.
- Existing QR preview, LNbits, Blink, payment-page, and dashboard behavior was preserved.
- Existing provider errors are redacted before being shown publicly.

## Database migration

Startup adds `payments.amount_sats` and creates `settlement_jobs` without deleting existing users, wallet credentials, links, payments, or history. Both SQLite and MariaDB adapters contain the required compatibility translations.

## Verification actually run

```text
node --check services/telegramService.js
node --check services/payoutService.js
node --check routes/sweeps.js
PASS

npm test -- --runInBand --detectOpenHandles
Test Suites: 24 passed, 24 total
Tests:       173 passed, 173 total

npm run test:coverage -- --runInBand
Test Suites: 24 passed, 24 total
Tests:       173 passed, 173 total
Coverage: statements 49.92%, branches 37.29%, functions 42.69%, lines 53.45%
Result: coverage command fails the package's configured global 80/70/80/80 thresholds.
```

The package has no formatter, linter, type-check, or production-build script, so those checks cannot be claimed. This is a server-rendered Node.js application and does not require a separate frontend build.

## Deployment safety

The deployment archive intentionally excludes `.env` and `data/` so extraction cannot overwrite production credentials or the live database. It includes `node_modules` because the target cPanel account has no terminal for `npm ci`.

After extracting over `/home/portalca/lightning-pay-production`, restart the cPanel Node.js application once. Keep the existing production `.env` and database in place.

## Remaining limitations

- The configured global coverage threshold is not met; expanding test coverage is separate from the repaired functional paths.
- Cross-process serialization of different operations on one wallet still relies on cPanel running one Node.js application process. Same-operation duplicates remain protected by the database uniqueness constraint.
- Real transfers against production LNbits, Blink, Binance, and Telegram accounts cannot be executed in local tests without using live funds and credentials.
