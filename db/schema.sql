-- Small Business Books: schema + ledger protections.
-- Safe to run again and again: it only creates what is missing and never drops data.
-- All money is integer cents.

CREATE TABLE IF NOT EXISTS settings (
  id                    integer PRIMARY KEY CHECK (id = 1),
  business_name         text NOT NULL DEFAULT 'My Business',
  entity_type           text NOT NULL DEFAULT 'sole_prop',
  basis                 text NOT NULL DEFAULT 'CASH' CHECK (basis IN ('CASH','ACCRUAL')),
  address               text NOT NULL DEFAULT '',
  email                 text NOT NULL DEFAULT '',
  phone                 text NOT NULL DEFAULT '',
  invoice_prefix        text NOT NULL DEFAULT 'INV-',
  next_invoice_number   integer NOT NULL DEFAULT 1001,
  terms_days            integer NOT NULL DEFAULT 30,
  invoice_footer        text NOT NULL DEFAULT '',
  sales_tax_on          boolean NOT NULL DEFAULT false,
  tax_rate_x1000        integer NOT NULL DEFAULT 0,       -- 7.25% is stored as 7250
  tax_set_aside_pct     integer NOT NULL DEFAULT 25,
  threshold_1099_cents  bigint NOT NULL DEFAULT 200000,
  locked_through        date,
  last_export_at        timestamptz
);

CREATE TABLE IF NOT EXISTS accounts (
  id               serial PRIMARY KEY,
  number           text NOT NULL UNIQUE,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('asset','liability','equity','income','cogs','expense')),
  sched_c_line     text,
  deductible_pct   integer NOT NULL DEFAULT 100 CHECK (deductible_pct BETWEEN 0 AND 100),
  requires_purpose boolean NOT NULL DEFAULT false,
  pay_from         boolean NOT NULL DEFAULT false,      -- can money be paid from / deposited to it
  system           boolean NOT NULL DEFAULT false,      -- used by posting rules; cannot be hidden
  active           boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS customers (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  tax_exempt  boolean NOT NULL DEFAULT false,
  notes       text NOT NULL DEFAULT '',
  archived    boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS vendors (
  id                  serial PRIMARY KEY,
  name                text NOT NULL,
  email               text NOT NULL DEFAULT '',
  address             text NOT NULL DEFAULT '',
  is_1099             boolean NOT NULL DEFAULT false,
  has_w9              boolean NOT NULL DEFAULT false,
  tax_id_last4        text NOT NULL DEFAULT '' CHECK (length(tax_id_last4) <= 4),
  default_account_id  integer REFERENCES accounts(id),
  archived            boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS invoices (
  id              serial PRIMARY KEY,
  number          text UNIQUE,                          -- assigned when issued, never reused
  customer_id     integer NOT NULL REFERENCES customers(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','void')),
  issue_date      date NOT NULL,
  due_date        date NOT NULL,
  notes           text NOT NULL DEFAULT '',
  tax_rate_x1000  integer NOT NULL DEFAULT 0,
  subtotal_cents  bigint NOT NULL DEFAULT 0,
  tax_cents       bigint NOT NULL DEFAULT 0,
  total_cents     bigint NOT NULL DEFAULT 0,
  public_token    text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                serial PRIMARY KEY,
  invoice_id        integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position          integer NOT NULL DEFAULT 0,
  description       text NOT NULL DEFAULT '',
  qty_x100          bigint NOT NULL CHECK (qty_x100 >= 0),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  account_id        integer NOT NULL REFERENCES accounts(id),
  taxable           boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS payments (
  id                  serial PRIMARY KEY,
  customer_id         integer NOT NULL REFERENCES customers(id),
  pay_date            date NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  method              text NOT NULL DEFAULT 'check',
  deposit_account_id  integer NOT NULL REFERENCES accounts(id),
  reference           text NOT NULL DEFAULT '',
  voided              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_applications (
  id            serial PRIMARY KEY,
  payment_id    integer NOT NULL REFERENCES payments(id),
  invoice_id    integer NOT NULL REFERENCES invoices(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0)
);

CREATE TABLE IF NOT EXISTS receipts (
  id           serial PRIMARY KEY,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text NOT NULL UNIQUE,
  data         bytea NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id                    serial PRIMARY KEY,
  vendor_id             integer REFERENCES vendors(id),
  exp_date              date NOT NULL,
  total_cents           bigint NOT NULL CHECK (total_cents > 0),
  description           text NOT NULL DEFAULT '',
  purpose               text NOT NULL DEFAULT '',
  business_pct          integer NOT NULL DEFAULT 100 CHECK (business_pct BETWEEN 0 AND 100),
  paid_from_account_id  integer REFERENCES accounts(id),   -- null means an unpaid bill
  paid_date             date,
  pay_method            text NOT NULL DEFAULT '',          -- check, ach, cash, debit_card, credit_card, other
  due_date              date,
  receipt_id            integer REFERENCES receipts(id),
  voided                boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expense_lines (
  id            serial PRIMARY KEY,
  expense_id    integer NOT NULL REFERENCES expenses(id),
  account_id    integer NOT NULL REFERENCES accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id            serial PRIMARY KEY,
  account_id    integer NOT NULL REFERENCES accounts(id),
  txn_date      date NOT NULL,
  description   text NOT NULL DEFAULT '',
  amount_cents  bigint NOT NULL,                           -- plus = money in, minus = money out
  fingerprint   text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','matched','ignored')),
  resolution    text NOT NULL DEFAULT '',
  imported_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mileage_rates (
  effective_date   date PRIMARY KEY,
  rate_tenth_cents integer NOT NULL CHECK (rate_tenth_cents > 0)   -- 72.5 cents is stored as 725
);

CREATE TABLE IF NOT EXISTS mileage_trips (
  id               serial PRIMARY KEY,
  trip_date        date NOT NULL,
  miles_x10        integer NOT NULL CHECK (miles_x10 > 0),
  from_place       text NOT NULL DEFAULT '',
  to_place         text NOT NULL DEFAULT '',
  purpose          text NOT NULL,
  odometer         integer,
  rate_tenth_cents integer NOT NULL,
  deduction_cents  bigint NOT NULL,
  voided           boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS money_moves (
  id               serial PRIMARY KEY,
  kind             text NOT NULL,     -- owner_contribution, owner_draw, transfer, other_income, opening_balance, sales_tax_remit, adjustment
  move_date        date NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  debit_account_id  integer NOT NULL REFERENCES accounts(id),
  credit_account_id integer NOT NULL REFERENCES accounts(id),
  memo             text NOT NULL DEFAULT '',
  voided           boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The ledger -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id           serial PRIMARY KEY,
  entry_date   date NOT NULL,
  memo         text NOT NULL DEFAULT '',
  book         text NOT NULL CHECK (book IN ('ACCRUAL','CASH','BOTH')),
  source_type  text NOT NULL,
  source_id    integer NOT NULL,
  source_key   text NOT NULL UNIQUE,                      -- makes posting twice impossible
  reverses_id  integer REFERENCES journal_entries(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id            serial PRIMARY KEY,
  entry_id      integer NOT NULL REFERENCES journal_entries(id),
  account_id    integer NOT NULL REFERENCES accounts(id),
  debit_cents   bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents  bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  invoice_id    integer,
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS journal_lines_invoice_idx ON journal_lines(invoice_id);
CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON journal_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      serial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  action  text NOT NULL,
  detail  text NOT NULL DEFAULT ''
);

-- Protection 1: every entry must balance when the transaction commits.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint; n integer;
BEGIN
  SELECT COALESCE(SUM(debit_cents),0), COALESCE(SUM(credit_cents),0), COUNT(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c OR n < 2 THEN
    RAISE EXCEPTION 'Ledger entry % does not balance (debits % / credits %)', NEW.entry_id, d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Protection 2: posted entries and lines can never be changed or removed.
CREATE OR REPLACE FUNCTION ledger_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The ledger cannot be edited or deleted. Post a reversing entry instead.';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_is_immutable();
DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_immutable();

-- Protection 3: nothing can be posted into a locked period.
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE locked date;
BEGIN
  SELECT locked_through INTO locked FROM settings WHERE id = 1;
  IF locked IS NOT NULL AND NEW.entry_date <= locked THEN
    RAISE EXCEPTION 'The books are locked through %. Unlock them in Settings to post on %.', locked, NEW.entry_date;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();
