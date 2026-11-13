# Small Business Books

Private invoicing, receipts and tax-ready books for one small business owner.
Express + PostgreSQL on the server, React + Vite on the client, TypeScript throughout.

## Rules for anyone (or any AI agent) changing this project

1. All money is integer cents. Never use floating point for money. Show dollars only when displaying.
2. The ledger (`journal_entries`, `journal_lines`) is the single source of truth for every report.
3. Ledger entries are never edited or deleted. Corrections are reversing entries (`reverseSource`).
4. Every posting goes through `server/ledger.ts`, inside `db.inTx(...)`. Debits must equal credits;
   the database enforces this when the transaction commits.
5. Every `/api` route requires the signed-in owner. Only `/i/:token` (one invoice, read-only) is public.
6. Validate every request body with zod. Parameterized SQL only.
7. Never store card numbers, bank logins, full SSNs or full EINs.
8. The database schema lives in `db/schema.sql`, which runs at every start and must stay safe to re-run.
   Add tables or columns with `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
   Never drop a table or column that holds data.
9. Anything tax-specific shown to the user says "Confirm with your CPA."
10. Anything that posts to the ledger gets a test in `tests/`. Run `npm test` before and after every change.
    If a test fails, fix the code, not the test.

## Map

- `db/schema.sql` tables plus the three database protections (balanced, immutable, period lock)
- `server/ledger.ts` posting rules: invoices, payments, expenses, bills, owner money, mileage
- `server/reports.ts` P&L, balance sheet, trial balance, Schedule C, AR aging, sales tax, 1099, dashboard
- `server/bank.ts` CSV parsing, duplicate fingerprints, match suggestions
- `server/routes.ts` the API; `server/index.ts` sign-in, public invoice link, static files
- `server/pdf.ts` invoice PDF and public invoice page; `server/exports.ts` CSVs and ZIP downloads
- `server/seed.ts` chart of accounts, Schedule C lines, mileage rates
- `client/src/pages/*` one file per screen

## Commands

- `npm run dev` build the screens and start the server (what the Run button does)
- `npm test` run the 31 checks against a throwaway in-memory database
- `npm run check` TypeScript type check

## Secrets

- `APP_PASSWORD` (required) the owner's sign-in password
- `DATABASE_URL` set automatically when a PostgreSQL database is added to the app
- `SESSION_SECRET` (optional) any long random string; signs the sign-in cookie
