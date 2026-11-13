# Small Business Books

Invoices, receipts and tax-ready books for one small business. You enter invoices, payments,
receipts and bank lines; the app writes balanced debits and credits behind the scenes and every
report reads from that one ledger.

This is working code, not a set of prompts. Upload it to Replit, press Run, and use it.

## Get it running in Replit (about 5 minutes, no Agent needed)

1. In Replit choose **Create App > Import code** and upload `smallbiz-books.zip`.
   (Or create a blank Node.js app, drag the zip into the file list, open the Shell and run
   `unzip smallbiz-books.zip && cp -r smallbiz-books/. . && rm -rf smallbiz-books smallbiz-books.zip`.)
2. Open **Secrets** (lock icon) and add `APP_PASSWORD` with a long password only you know.
3. Open the **Database** tool and add a PostgreSQL database. This sets `DATABASE_URL` for you.
4. Press **Run**. The first start installs packages, creates the tables, loads the chart of
   accounts and builds the screens.
5. Open the app in its own browser tab and sign in.
6. In the app: **Settings** (business name, address, how to pay, sales tax on or off), then
   **Owner & Transfers > Opening balance** for each bank account and card.
7. In the Shell run `npm test`. You should see 31 passing checks.

To use it from your phone or send invoice links to customers, press **Publish**. Published apps
have their own database, so add `APP_PASSWORD` to the published app's secrets too.
Autoscale is the cheapest setting: the app sleeps when you are not using it.

## What is in it

- **Invoices**: drafts, numbering that never repeats, PDF, a private link per invoice for the
  customer, an Email button (opens your own mail app, so there is no email service to pay for),
  duplicate, void. Status is worked out for you: Draft, Sent, Partially paid, Paid, Overdue, Void.
- **Payments**: apply one payment to several invoices, part payments, overpayments held as
  customer credit and used later, void (a bounced check).
- **Receipts and expenses**: photo or PDF inbox (phone camera works), duplicates refused, split
  across categories, business-use percent with the personal part booked as an owner draw,
  required business purpose for meals and travel, unpaid bills with Mark paid.
- **Bank**: import a CSV from your bank, safe to import the same file twice, suggested matches,
  one-tap sorting, and a statement check that should come to $0.00.
- **Mileage**: trip log using the IRS rate in effect on the trip date.
- **Owner & Transfers**: money you put in or took out, transfers and card payments, opening
  balances, sales tax paid, and year-end entries from your CPA.
- **Reports**: Profit & Loss, Balance Sheet, Schedule C summary (meals at 50 percent), who owes
  you, sales tax, 1099 contractors, trial balance, general ledger. Cash or accrual with one
  switch, CSV download, and Print / PDF.
- **Year end**: live checklist, accountant package (one ZIP with reports, lists and receipts),
  full backup ZIP, lock the books through a date, activity log.

## How the books are protected

- The database itself refuses an entry whose debits and credits differ.
- Posted entries cannot be edited or deleted, even by hand in the database. Fixes are reversals.
- Nothing can be posted into a locked period.
- Posting the same thing twice (a double click, a retry) does nothing the second time.
- All money is whole cents. Part payments are split between income and sales tax to the exact cent.

`npm test` proves each of these, plus: receivables in the ledger equal open invoices, the balance
sheet balances on both books, Schedule C ties to the P&L, sales tax collected equals sales tax
owed, the 1099 list leaves out card payments, and every API route refuses a visitor who is not
signed in.

## Choices made to keep cost and upkeep low

- **One password instead of Replit Auth.** No integration to set up; one secret.
- **Receipts are stored in the database** rather than a separate storage bucket, so backups are
  one thing and there is no second service. If you ever store thousands of large photos, move
  them to Replit App Storage (prompt below).
- **Tables are created at start-up from `db/schema.sql`.** No migration tool to run.
- **Email uses your own mail app.** Automated email with the PDF attached is an optional add-on.
- **No Stripe yet.** Add it only when customers ask to pay by card.

## Not included (on purpose)

Payroll, inventory counts, credit memos and refunds, multi-user access, and anything that
calculates tax owed. Self-employment tax, income tax, your own health insurance and retirement,
depreciation choices and the home office figure belong with your CPA or tax software.

## Optional add-ons: prompts for Replit Agent

Use these only if you want the feature. Paste one at a time, then run `npm test`.

**Online card payment**
> Read replit.md first and follow its rules. Add Stripe Checkout to the public invoice page
> `/i/:token`: a "Pay now" button when the invoice is issued and has a balance, creating a Checkout
> Session for the balance (keys from Secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, test
> mode first). Add `POST /stripe/webhook` outside the sign-in guard that verifies the signature on
> the raw body, stores the event id in a new `stripe_events` table and stops if it already exists,
> then inside `db.inTx` calls `recordPayment` with deposit account 1170 Stripe Clearing and method
> "stripe", and posts the Stripe fee as debit 6031, credit 1170. In the Bank inbox add a "Stripe
> payout" choice that transfers from 1170 to the bank account. Add tests: the same event twice
> records one payment; 1170 ends at zero after the fee and the payout.

**Send invoices by email with the PDF attached**
> Read replit.md first. Add a Send button on the invoice page that emails the customer through
> Resend (`RESEND_API_KEY`, `EMAIL_FROM` in Secrets) with the PDF from `invoicePdf` attached and the
> public link in the body. Show an editable preview first; never send automatically. Log each send
> to a new `email_log` table and to the audit log.

**Read receipts automatically**
> Read replit.md first. Add an off-by-default setting "Read receipts automatically". When on,
> after a receipt upload send the image to a vision model (`OCR_API_KEY`, `OCR_MODEL` in Secrets)
> and ask for strict JSON: vendor, date, total, suggested category from our expense accounts.
> Pre-fill the expense form with these as suggestions the owner must review; never post
> automatically. Handle malformed JSON without crashing and add a test for that.

**Move receipt files to App Storage**
> Read replit.md first. Store new receipt files in Replit App Storage (private bucket) instead of
> the `receipts.data` column, keeping the same routes and the SHA-256 duplicate check. Add a nullable
> `storage_key` column, keep serving old rows from the database, and include bucket files in both
> ZIP exports.

**Recurring invoices**
> Read replit.md first. Add recurring invoice templates (customer, lines, every N months, next
> date). A dashboard to-do lists templates that are due; one tap creates the draft with
> `saveDraftInvoice`. Never issue automatically.

---

This app organizes records. It is not tax advice. Confirm tax questions with your CPA.
