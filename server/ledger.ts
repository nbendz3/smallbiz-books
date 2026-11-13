// The ledger engine: posting rules. Every function here must be called inside db.inTx().
// Nothing in the app writes journal entries any other way.
//
// Books: ACCRUAL, CASH or BOTH. Reports read "chosen book + BOTH", so both books always balance.
//   invoice issued      -> ACCRUAL
//   payment received    -> one ACCRUAL entry (clears receivable) + one CASH entry (recognizes income)
//   expense paid now    -> BOTH
//   bill (unpaid)       -> ACCRUAL; when paid -> one ACCRUAL entry (clears payable) + one CASH entry
//   everything else     -> BOTH
import { randomBytes } from "node:crypto";
import { UserError, type Tx } from "./db.js";
import { allocate, lineAmount, mileageDeduction, pctOf, taxFor } from "./money.js";

export const ACCT = {
  CHECKING: "1010", AR: "1080", SUSPENSE: "1900", AP: "2000", SALES_TAX: "2060", CARD: "2100",
  DEPOSITS: "2200", OPENING: "3000", CONTRIB: "3050", DRAWS: "3070", MILEAGE: "6020", UNCATEGORIZED: "6990",
} as const;

export type Book = "ACCRUAL" | "CASH" | "BOTH";
export interface Line { accountId: number; debit?: number; credit?: number; invoiceId?: number | null }
export interface Entry {
  date: string; memo: string; book: Book; sourceType: string; sourceId: number; sourceKey: string;
  lines: Line[]; reversesId?: number;
}

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function needDate(s: unknown, what = "date"): string {
  if (!isDate(s)) throw new UserError(`Enter a valid ${what}.`);
  return s;
}
function needCents(n: unknown, what = "amount"): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new UserError(`Enter a ${what} greater than zero.`);
  return n;
}

export async function acctId(tx: Tx, number: string): Promise<number> {
  const r = await tx.q<{ id: number }>("SELECT id FROM accounts WHERE number = $1", [number]);
  if (!r[0]) throw new Error("Missing account " + number);
  return r[0].id;
}
async function account(tx: Tx, id: number) {
  const r = await tx.q("SELECT * FROM accounts WHERE id = $1", [id]);
  if (!r[0]) throw new UserError("That account does not exist.");
  return r[0] as { id: number; number: string; name: string; type: string; requires_purpose: boolean; pay_from: boolean };
}

/** Write one balanced entry. Posting the same sourceKey twice does nothing the second time. */
export async function post(tx: Tx, e: Entry): Promise<number | null> {
  const lines = e.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  let d = 0, c = 0;
  for (const l of lines) {
    const dv = l.debit ?? 0, cv = l.credit ?? 0;
    if (!Number.isSafeInteger(dv) || !Number.isSafeInteger(cv) || dv < 0 || cv < 0 || (dv > 0 && cv > 0)) throw new Error("Bad ledger line");
    d += dv; c += cv;
  }
  if (d !== c || lines.length < 2) throw new Error(`Entry "${e.memo}" does not balance: ${d} vs ${c}`);
  const ins = await tx.q<{ id: number }>(
    `INSERT INTO journal_entries (entry_date, memo, book, source_type, source_id, source_key, reverses_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_key) DO NOTHING RETURNING id`,
    [e.date, e.memo, e.book, e.sourceType, e.sourceId, e.sourceKey, e.reversesId ?? null],
  );
  if (!ins[0]) return null;
  for (const l of lines) {
    await tx.q("INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents, invoice_id) VALUES ($1,$2,$3,$4,$5)",
      [ins[0].id, l.accountId, l.debit ?? 0, l.credit ?? 0, l.invoiceId ?? null]);
  }
  return ins[0].id;
}

/** Cancel everything a source posted by writing mirror-image entries. Never edits the originals. */
export async function reverseSource(tx: Tx, sourceType: string, sourceId: number, today: string, keyLike?: string): Promise<number> {
  const entries = await tx.q(
    `SELECT e.* FROM journal_entries e
      WHERE e.source_type = $1 AND e.source_id = $2 AND e.reverses_id IS NULL
        AND ($3::text IS NULL OR e.source_key LIKE $3)
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id)
      ORDER BY e.id`, [sourceType, sourceId, keyLike ?? null]);
  const locked = (await tx.q("SELECT locked_through FROM settings WHERE id = 1"))[0]?.locked_through as string | null;
  for (const e of entries) {
    const lines = await tx.q("SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY id", [e.id]);
    // Reverse on the original date so the period nets to zero; if that period is locked, reverse today.
    const date = locked && e.entry_date <= locked ? today : e.entry_date;
    await post(tx, {
      date, memo: "Reversal: " + e.memo, book: e.book, sourceType, sourceId, sourceKey: "rev:" + e.id, reversesId: e.id,
      lines: lines.map((l) => ({ accountId: l.account_id, debit: l.credit_cents, credit: l.debit_cents, invoiceId: l.invoice_id })),
    });
  }
  return entries.length;
}

export async function audit(tx: Tx, action: string, detail = ""): Promise<void> {
  await tx.q("INSERT INTO audit_log (action, detail) VALUES ($1,$2)", [action, detail]);
}

// ---------------------------------------------------------------- invoices --
export interface InvoiceLineInput { description: string; qtyX100: number; unitPriceCents: number; accountId: number; taxable: boolean }
export interface InvoiceInput { customerId: number; issueDate: string; dueDate: string; notes: string; taxRateX1000: number; lines: InvoiceLineInput[] }

export function invoiceTotals(lines: InvoiceLineInput[], taxRateX1000: number) {
  const amounts = lines.map((l) => lineAmount(l.qtyX100, l.unitPriceCents));
  const subtotal = amounts.reduce((a, b) => a + b, 0);
  const tax = lines.reduce((a, l, i) => a + (l.taxable ? taxFor(amounts[i], taxRateX1000) : 0), 0);
  return { amounts, subtotal, tax, total: subtotal + tax };
}

/** Create or update a DRAFT. Drafts post nothing. */
export async function saveDraftInvoice(tx: Tx, inv: InvoiceInput, id?: number): Promise<number> {
  needDate(inv.issueDate, "invoice date"); needDate(inv.dueDate, "due date");
  if (!inv.lines.length) throw new UserError("Add at least one line.");
  const cust = await tx.q("SELECT tax_exempt FROM customers WHERE id = $1", [inv.customerId]);
  if (!cust[0]) throw new UserError("Pick a customer.");
  const s = (await tx.q("SELECT sales_tax_on FROM settings WHERE id = 1"))[0];
  const taxOn = s.sales_tax_on && !cust[0].tax_exempt;
  const rate = taxOn ? inv.taxRateX1000 : 0;
  const lines = inv.lines.map((l) => ({ ...l, taxable: taxOn && l.taxable }));
  for (const l of lines) {
    const a = await account(tx, l.accountId);
    if (a.type !== "income") throw new UserError("Invoice lines must use an income account.");
    if (!Number.isSafeInteger(l.qtyX100) || !Number.isSafeInteger(l.unitPriceCents) || l.qtyX100 < 0 || l.unitPriceCents < 0) throw new UserError("Quantity and price cannot be negative.");
  }
  const t = invoiceTotals(lines, rate);
  if (id) {
    const cur = await tx.q("SELECT status FROM invoices WHERE id = $1 FOR UPDATE", [id]);
    if (!cur[0]) throw new UserError("Invoice not found.");
    if (cur[0].status !== "draft") throw new UserError("This invoice has been issued and can no longer be edited. Void it and create a new one.");
    await tx.q(`UPDATE invoices SET customer_id=$2, issue_date=$3, due_date=$4, notes=$5, tax_rate_x1000=$6, subtotal_cents=$7, tax_cents=$8, total_cents=$9 WHERE id=$1`,
      [id, inv.customerId, inv.issueDate, inv.dueDate, inv.notes, rate, t.subtotal, t.tax, t.total]);
    await tx.q("DELETE FROM invoice_lines WHERE invoice_id = $1", [id]);
  } else {
    const token = randomBytes(24).toString("base64url");
    id = (await tx.q<{ id: number }>(
      `INSERT INTO invoices (customer_id, issue_date, due_date, notes, tax_rate_x1000, subtotal_cents, tax_cents, total_cents, public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [inv.customerId, inv.issueDate, inv.dueDate, inv.notes, rate, t.subtotal, t.tax, t.total, token]))[0].id;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await tx.q(`INSERT INTO invoice_lines (invoice_id, position, description, qty_x100, unit_price_cents, amount_cents, account_id, taxable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, i, l.description, l.qtyX100, l.unitPriceCents, t.amounts[i], l.accountId, l.taxable]);
  }
  return id!;
}

/** What an invoice is made of: income per account, plus one sales tax piece. */
export async function invoiceComponents(tx: Tx, invoiceId: number): Promise<{ accountId: number; amount: number }[]> {
  const rows = await tx.q<{ account_id: number; amount: number }>(
    "SELECT account_id, SUM(amount_cents)::bigint AS amount FROM invoice_lines WHERE invoice_id = $1 GROUP BY account_id ORDER BY account_id", [invoiceId]);
  const inv = (await tx.q("SELECT tax_cents FROM invoices WHERE id = $1", [invoiceId]))[0];
  const comps = rows.filter((r) => r.amount > 0).map((r) => ({ accountId: r.account_id, amount: r.amount }));
  if (inv.tax_cents > 0) comps.push({ accountId: await acctId(tx, ACCT.SALES_TAX), amount: inv.tax_cents });
  return comps;
}

/** Issue a draft: assign the next number (never reused) and post receivable vs income. */
export async function issueInvoice(tx: Tx, id: number): Promise<string> {
  const inv = (await tx.q("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!inv) throw new UserError("Invoice not found.");
  if (inv.status !== "draft") throw new UserError("This invoice was already issued.");
  if (inv.total_cents <= 0) throw new UserError("The invoice total must be more than zero.");
  const s = (await tx.q("SELECT invoice_prefix, next_invoice_number FROM settings WHERE id = 1 FOR UPDATE"))[0];
  const number = s.invoice_prefix + s.next_invoice_number;
  await tx.q("UPDATE settings SET next_invoice_number = next_invoice_number + 1 WHERE id = 1");
  await tx.q("UPDATE invoices SET status = 'sent', number = $2 WHERE id = $1", [id, number]);
  const comps = await invoiceComponents(tx, id);
  await post(tx, {
    date: inv.issue_date, memo: "Invoice " + number, book: "ACCRUAL", sourceType: "invoice", sourceId: id, sourceKey: `invoice:${id}:issue`,
    lines: [{ accountId: await acctId(tx, ACCT.AR), debit: inv.total_cents, invoiceId: id }, ...comps.map((c) => ({ accountId: c.accountId, credit: c.amount, invoiceId: id }))],
  });
  await audit(tx, "invoice_issued", number);
  return number;
}

export async function invoicePaid(tx: Tx, invoiceId: number): Promise<number> {
  return (await tx.q<{ paid: number }>(
    `SELECT COALESCE(SUM(pa.amount_cents),0)::bigint AS paid FROM payment_applications pa
       JOIN payments p ON p.id = pa.payment_id AND NOT p.voided WHERE pa.invoice_id = $1`, [invoiceId]))[0].paid;
}

export async function voidInvoice(tx: Tx, id: number, today: string): Promise<void> {
  const inv = (await tx.q("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!inv) throw new UserError("Invoice not found.");
  if (inv.status !== "sent") throw new UserError("Only an issued invoice can be voided. A draft can simply be deleted.");
  if ((await invoicePaid(tx, id)) > 0) throw new UserError("This invoice has payments applied. Void the payments first.");
  await reverseSource(tx, "invoice", id, today);
  await tx.q("UPDATE invoices SET status = 'void' WHERE id = $1", [id]);
  await audit(tx, "invoice_voided", inv.number);
}

// ---------------------------------------------------------------- payments --
export interface PaymentInput {
  customerId: number; date: string; amountCents: number; method: string; depositAccountId: number; reference: string;
  applications: { invoiceId: number; amountCents: number }[];
}

export async function recordPayment(tx: Tx, p: PaymentInput): Promise<number> {
  needDate(p.date, "payment date"); needCents(p.amountCents, "payment amount");
  const dep = await account(tx, p.depositAccountId);
  if (!dep.pay_from && dep.number !== ACCT.DEPOSITS) throw new UserError("Pick a bank account for the deposit.");
  const apps = p.applications.filter((a) => a.amountCents !== 0);
  if (new Set(apps.map((a) => a.invoiceId)).size !== apps.length) throw new UserError("Each invoice can appear only once per payment.");
  const applied = apps.reduce((a, b) => a + needCents(b.amountCents, "applied amount"), 0);
  if (applied > p.amountCents) throw new UserError("You applied more than the payment amount.");
  const leftover = p.amountCents - applied;
  if (leftover > 0 && dep.number === ACCT.DEPOSITS) throw new UserError("When using customer credit, apply the whole amount to invoices.");

  const payId = (await tx.q<{ id: number }>(
    `INSERT INTO payments (customer_id, pay_date, amount_cents, method, deposit_account_id, reference) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.customerId, p.date, p.amountCents, p.method, p.depositAccountId, p.reference]))[0].id;

  const ar = await acctId(tx, ACCT.AR), deposits = await acctId(tx, ACCT.DEPOSITS);
  const accrual: Line[] = [{ accountId: p.depositAccountId, debit: p.amountCents }];
  const cash: Line[] = [{ accountId: p.depositAccountId, debit: p.amountCents }];
  const numbers: string[] = [];

  for (const a of apps) {
    const inv = (await tx.q("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [a.invoiceId]))[0];
    if (!inv || inv.status !== "sent") throw new UserError("Payments can only be applied to issued invoices.");
    if (inv.customer_id !== p.customerId) throw new UserError(`Invoice ${inv.number} belongs to a different customer.`);
    const balance = inv.total_cents - (await invoicePaid(tx, a.invoiceId));
    if (a.amountCents > balance) throw new UserError(`Invoice ${inv.number} only has ${(balance / 100).toFixed(2)} left to pay.`);
    numbers.push(inv.number);

    // Cash book: recognize income and sales tax in proportion to what is still unrecognized,
    // read from the ledger itself so that voids and partial payments always land on the exact cent.
    const comps = await invoiceComponents(tx, a.invoiceId);
    const remaining: number[] = [];
    for (const c of comps) {
      const rec = (await tx.q<{ n: number }>(
        `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0)::bigint AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.book = 'CASH' AND l.invoice_id = $1 AND l.account_id = $2`, [a.invoiceId, c.accountId]))[0].n;
      remaining.push(c.amount - rec);
    }
    const parts = allocate(a.amountCents, remaining);
    comps.forEach((c, i) => cash.push({ accountId: c.accountId, credit: parts[i], invoiceId: a.invoiceId }));
    accrual.push({ accountId: ar, credit: a.amountCents, invoiceId: a.invoiceId });
    await tx.q("INSERT INTO payment_applications (payment_id, invoice_id, amount_cents) VALUES ($1,$2,$3)", [payId, a.invoiceId, a.amountCents]);
  }
  if (leftover > 0) {
    accrual.push({ accountId: deposits, credit: leftover });
    cash.push({ accountId: deposits, credit: leftover });
  }
  const memo = "Payment" + (numbers.length ? " for " + numbers.join(", ") : " (customer deposit)") + (p.reference ? " ref " + p.reference : "");
  await post(tx, { date: p.date, memo, book: "ACCRUAL", sourceType: "payment", sourceId: payId, sourceKey: `payment:${payId}:ACCRUAL`, lines: accrual });
  await post(tx, { date: p.date, memo, book: "CASH", sourceType: "payment", sourceId: payId, sourceKey: `payment:${payId}:CASH`, lines: cash });
  await audit(tx, "payment_recorded", `${memo} ${(p.amountCents / 100).toFixed(2)}`);
  return payId;
}

export async function voidPayment(tx: Tx, id: number, today: string): Promise<void> {
  const pay = (await tx.q("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!pay) throw new UserError("Payment not found.");
  if (pay.voided) throw new UserError("This payment was already voided.");
  await reverseSource(tx, "payment", id, today);
  await tx.q("UPDATE payments SET voided = true WHERE id = $1", [id]);
  await audit(tx, "payment_voided", `payment ${id} ${(pay.amount_cents / 100).toFixed(2)}`);
}

// ---------------------------------------------------------------- expenses --
export interface ExpenseInput {
  vendorId: number | null; date: string; description: string; purpose: string; businessPct: number;
  lines: { accountId: number; amountCents: number }[];
  paidFromAccountId: number | null; paidDate?: string | null; payMethod?: string; dueDate?: string | null; receiptId?: number | null;
}

async function expenseDebits(tx: Tx, lines: { accountId: number; amountCents: number }[], businessPct: number): Promise<Line[]> {
  const total = lines.reduce((a, l) => a + l.amountCents, 0);
  const business = pctOf(total, businessPct);
  const parts = allocate(business, lines.map((l) => l.amountCents));
  const out: Line[] = lines.map((l, i) => ({ accountId: l.accountId, debit: parts[i] }));
  if (total - business > 0) out.push({ accountId: await acctId(tx, ACCT.DRAWS), debit: total - business }); // personal share is an owner draw
  return out;
}

function defaultMethod(a: { type: string; number: string }): string {
  return a.type === "liability" ? "credit_card" : a.number === "1050" ? "cash" : "ach";
}

export async function recordExpense(tx: Tx, x: ExpenseInput): Promise<number> {
  needDate(x.date, "expense date");
  if (!x.lines.length) throw new UserError("Pick a category.");
  if (!Number.isInteger(x.businessPct) || x.businessPct < 0 || x.businessPct > 100) throw new UserError("Business use must be between 0 and 100 percent.");
  let needsPurpose = false;
  for (const l of x.lines) {
    needCents(l.amountCents);
    const a = await account(tx, l.accountId);
    if (a.type !== "expense" && a.type !== "cogs" && a.type !== "asset") throw new UserError(`${a.number} ${a.name} is not an expense category.`);
    if (a.requires_purpose) needsPurpose = true;
  }
  if (needsPurpose && !x.purpose.trim()) throw new UserError("Meals and travel need a business purpose (who, and why).");
  const total = x.lines.reduce((a, l) => a + l.amountCents, 0);
  let paidFrom: Awaited<ReturnType<typeof account>> | null = null;
  if (x.paidFromAccountId) {
    paidFrom = await account(tx, x.paidFromAccountId);
    if (!paidFrom.pay_from) throw new UserError("Pick the bank account, card or cash this was paid from.");
  }
  const paidDate = paidFrom ? needDate(x.paidDate || x.date, "paid date") : null;
  if (x.receiptId) {
    const used = await tx.q("SELECT id FROM expenses WHERE receipt_id = $1 AND NOT voided", [x.receiptId]);
    if (used[0]) throw new UserError("That receipt is already attached to another expense.");
  }
  const id = (await tx.q<{ id: number }>(
    `INSERT INTO expenses (vendor_id, exp_date, total_cents, description, purpose, business_pct, paid_from_account_id, paid_date, pay_method, due_date, receipt_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [x.vendorId, x.date, total, x.description, x.purpose, x.businessPct, paidFrom?.id ?? null, paidDate,
      paidFrom ? x.payMethod || defaultMethod(paidFrom) : "", x.dueDate || null, x.receiptId ?? null]))[0].id;
  for (const l of x.lines) await tx.q("INSERT INTO expense_lines (expense_id, account_id, amount_cents) VALUES ($1,$2,$3)", [id, l.accountId, l.amountCents]);

  const debits = await expenseDebits(tx, x.lines, x.businessPct);
  const memo = "Expense" + (x.description ? ": " + x.description : "");
  if (paidFrom) {
    await post(tx, { date: paidDate!, memo, book: "BOTH", sourceType: "expense", sourceId: id, sourceKey: `expense:${id}:paid`,
      lines: [...debits, { accountId: paidFrom.id, credit: total }] });
  } else {
    await post(tx, { date: x.date, memo: "Bill" + (x.description ? ": " + x.description : ""), book: "ACCRUAL", sourceType: "expense", sourceId: id,
      sourceKey: `expense:${id}:bill`, lines: [...debits, { accountId: await acctId(tx, ACCT.AP), credit: total }] });
  }
  return id;
}

export async function payBill(tx: Tx, id: number, pay: { accountId: number; date: string; method?: string }): Promise<void> {
  needDate(pay.date, "paid date");
  const x = (await tx.q("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!x || x.voided) throw new UserError("Bill not found.");
  if (x.paid_from_account_id) throw new UserError("This bill is already paid.");
  const from = await account(tx, pay.accountId);
  if (!from.pay_from) throw new UserError("Pick the account this was paid from.");
  const lines = (await tx.q("SELECT account_id, amount_cents FROM expense_lines WHERE expense_id = $1 ORDER BY id", [id])).map((l) => ({ accountId: l.account_id, amountCents: l.amount_cents }));
  const memo = "Bill paid" + (x.description ? ": " + x.description : "");
  await post(tx, { date: pay.date, memo, book: "ACCRUAL", sourceType: "expense", sourceId: id, sourceKey: `expense:${id}:pay:ACCRUAL`,
    lines: [{ accountId: await acctId(tx, ACCT.AP), debit: x.total_cents }, { accountId: from.id, credit: x.total_cents }] });
  await post(tx, { date: pay.date, memo, book: "CASH", sourceType: "expense", sourceId: id, sourceKey: `expense:${id}:pay:CASH`,
    lines: [...(await expenseDebits(tx, lines, x.business_pct)), { accountId: from.id, credit: x.total_cents }] });
  await tx.q("UPDATE expenses SET paid_from_account_id = $2, paid_date = $3, pay_method = $4 WHERE id = $1", [id, from.id, pay.date, pay.method || defaultMethod(from)]);
}

export async function voidExpense(tx: Tx, id: number, today: string): Promise<void> {
  const x = (await tx.q("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!x) throw new UserError("Expense not found.");
  if (x.voided) throw new UserError("This expense was already voided.");
  await reverseSource(tx, "expense", id, today);
  await tx.q("UPDATE expenses SET voided = true WHERE id = $1", [id]);
  await audit(tx, "expense_voided", `expense ${id} ${(x.total_cents / 100).toFixed(2)}`);
}

// ------------------------------------------------- owner money, transfers --
export type MoveKind = "owner_contribution" | "owner_draw" | "transfer" | "other_income" | "opening_balance" | "sales_tax_remit" | "adjustment";
export interface MoveInput { kind: MoveKind; date: string; amountCents: number; memo: string; accountId: number; otherAccountId?: number }

const MOVE_LABEL: Record<MoveKind, string> = {
  owner_contribution: "Owner contribution", owner_draw: "Owner draw", transfer: "Transfer", other_income: "Deposit",
  opening_balance: "Opening balance", sales_tax_remit: "Sales tax remitted", adjustment: "Adjustment",
};

/**
 * Two-sided money moves that are neither an invoice nor an expense.
 *   owner_contribution: accountId = bank receiving the money
 *   owner_draw:         accountId = bank paying it out
 *   transfer:           accountId = from, otherAccountId = to (paying the card bill is a transfer to 2100)
 *   other_income:       accountId = bank, otherAccountId = income account (cash sale, interest)
 *   opening_balance:    accountId = bank or card being set up
 *   sales_tax_remit:    accountId = bank paying the state
 *   adjustment:         accountId = debit, otherAccountId = credit (year-end entries from your CPA)
 */
export async function recordMove(tx: Tx, m: MoveInput): Promise<number> {
  needDate(m.date); needCents(m.amountCents);
  const a = await account(tx, m.accountId);
  const other = m.otherAccountId ? await account(tx, m.otherAccountId) : null;
  const need = (ok: unknown, msg: string) => { if (!ok) throw new UserError(msg); };
  let debit: number, credit: number;
  switch (m.kind) {
    case "owner_contribution": need(a.pay_from, "Pick the account that received the money."); debit = a.id; credit = await acctId(tx, ACCT.CONTRIB); break;
    case "owner_draw": need(a.pay_from, "Pick the account the money came out of."); debit = await acctId(tx, ACCT.DRAWS); credit = a.id; break;
    case "transfer": need(other && a.pay_from && other.pay_from && a.id !== other.id, "Pick two different accounts."); debit = other!.id; credit = a.id; break;
    case "other_income": need(a.pay_from && other?.type === "income", "Pick a bank account and an income category."); debit = a.id; credit = other!.id; break;
    case "opening_balance": {
      need(a.pay_from, "Pick a bank account or card.");
      const ob = await acctId(tx, ACCT.OPENING);
      if (a.type === "liability") { debit = ob; credit = a.id; } else { debit = a.id; credit = ob; }
      break;
    }
    case "sales_tax_remit": need(a.pay_from, "Pick the account that paid."); debit = await acctId(tx, ACCT.SALES_TAX); credit = a.id; break;
    case "adjustment": need(other && a.id !== other.id, "Pick two different accounts."); need(m.memo.trim(), "Adjustments need a note explaining why."); debit = a.id; credit = other!.id; break;
    default: throw new UserError("Unknown kind of entry.");
  }
  const id = (await tx.q<{ id: number }>(
    `INSERT INTO money_moves (kind, move_date, amount_cents, debit_account_id, credit_account_id, memo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [m.kind, m.date, m.amountCents, debit, credit, m.memo]))[0].id;
  await post(tx, { date: m.date, memo: MOVE_LABEL[m.kind] + (m.memo ? ": " + m.memo : ""), book: "BOTH", sourceType: "move", sourceId: id, sourceKey: `move:${id}`,
    lines: [{ accountId: debit, debit: m.amountCents }, { accountId: credit, credit: m.amountCents }] });
  if (m.kind === "adjustment") await audit(tx, "adjustment_posted", m.memo);
  return id;
}

export async function voidMove(tx: Tx, id: number, today: string): Promise<void> {
  const m = (await tx.q("SELECT * FROM money_moves WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!m || m.voided) throw new UserError("Entry not found or already voided.");
  await reverseSource(tx, "move", id, today);
  await tx.q("UPDATE money_moves SET voided = true WHERE id = $1", [id]);
  await audit(tx, "move_voided", `${m.kind} ${(m.amount_cents / 100).toFixed(2)}`);
}

// ----------------------------------------------------------------- mileage --
export interface TripInput { date: string; milesX10: number; from: string; to: string; purpose: string; odometer?: number | null }

export async function recordTrip(tx: Tx, t: TripInput): Promise<number> {
  needDate(t.date, "trip date");
  if (!Number.isSafeInteger(t.milesX10) || t.milesX10 <= 0) throw new UserError("Enter the miles driven.");
  if (!t.purpose.trim()) throw new UserError("Every trip needs a business purpose.");
  const rate = (await tx.q("SELECT rate_tenth_cents FROM mileage_rates WHERE effective_date <= $1 ORDER BY effective_date DESC LIMIT 1", [t.date]))[0];
  if (!rate) throw new UserError("No mileage rate is set for that date. Add one in Settings.");
  const deduction = mileageDeduction(t.milesX10, rate.rate_tenth_cents);
  const id = (await tx.q<{ id: number }>(
    `INSERT INTO mileage_trips (trip_date, miles_x10, from_place, to_place, purpose, odometer, rate_tenth_cents, deduction_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t.date, t.milesX10, t.from, t.to, t.purpose, t.odometer ?? null, rate.rate_tenth_cents, deduction]))[0].id;
  // No cash moves: you paid for the car personally, so the other side is an owner contribution.
  await post(tx, { date: t.date, memo: `Mileage: ${(t.milesX10 / 10).toFixed(1)} mi, ${t.purpose}`, book: "BOTH", sourceType: "mileage", sourceId: id, sourceKey: `mileage:${id}`,
    lines: [{ accountId: await acctId(tx, ACCT.MILEAGE), debit: deduction }, { accountId: await acctId(tx, ACCT.CONTRIB), credit: deduction }] });
  return id;
}

export async function voidTrip(tx: Tx, id: number, today: string): Promise<void> {
  const t = (await tx.q("SELECT * FROM mileage_trips WHERE id = $1 FOR UPDATE", [id]))[0];
  if (!t || t.voided) throw new UserError("Trip not found or already removed.");
  await reverseSource(tx, "mileage", id, today);
  await tx.q("UPDATE mileage_trips SET voided = true WHERE id = $1", [id]);
}
