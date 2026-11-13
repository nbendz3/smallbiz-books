// All owner-only API routes. index.ts puts the sign-in guard in front of everything here.
import { createHash } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { UserError, type Db, type Tx } from "./db.js";
import * as L from "./ledger.js";
import * as R from "./reports.js";
import * as B from "./bank.js";
import { buildZip, reportRows, toCsv } from "./exports.js";
import { invoicePdf, loadInvoice } from "./pdf.js";

export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "America/Los_Angeles" }).format(new Date());

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zCents = z.number().int().min(0).max(100_000_000_000);
const zId = z.number().int().positive();
const zText = z.string().max(4000).default("");
const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"];

type H = (req: Request, res: Response) => Promise<unknown>;

export function apiRoutes(db: Db): Router {
  const r = express.Router();
  const h = (fn: H) => (req: Request, res: Response) => {
    fn(req, res).then((out) => { if (!res.headersSent) res.json(out ?? { ok: true }); }).catch((e) => sendError(res, e));
  };
  const id = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new UserError("Bad id.");
    return n;
  };
  const basisOf = async (req: Request, tx: Tx): Promise<R.Basis> => {
    const b = String(req.query.basis ?? "");
    return b === "CASH" || b === "ACCRUAL" ? b : (await tx.q("SELECT basis FROM settings WHERE id = 1"))[0].basis;
  };
  const qDate = (req: Request, key: string, fallback: string) => {
    const v = req.query[key];
    return typeof v === "string" && zDate.safeParse(v).success ? v : fallback;
  };

  // ------------------------------------------------------------ bootstrap --
  r.get("/bootstrap", h(async () => ({
    today: today(),
    settings: (await db.q("SELECT * FROM settings WHERE id = 1"))[0],
    accounts: await db.q("SELECT * FROM accounts ORDER BY number"),
    customers: await db.q("SELECT * FROM customers ORDER BY archived, name"),
    vendors: await db.q("SELECT * FROM vendors ORDER BY archived, name"),
    mileageRates: await db.q("SELECT * FROM mileage_rates ORDER BY effective_date DESC"),
    database: db.kind,
  })));

  r.get("/dashboard", h(async (req) => db.inTx(async (tx) => R.dashboard(tx, await basisOf(req, tx), today()))));

  // ------------------------------------------------------------- settings --
  const Settings = z.object({
    business_name: z.string().min(1).max(200), entity_type: z.enum(["sole_prop", "smllc", "s_corp", "partnership", "c_corp"]), basis: z.enum(["CASH", "ACCRUAL"]),
    address: zText, email: zText, phone: zText, invoice_prefix: z.string().max(12), next_invoice_number: z.number().int().min(1),
    terms_days: z.number().int().min(0).max(365), invoice_footer: zText, sales_tax_on: z.boolean(), tax_rate_x1000: z.number().int().min(0).max(30000),
    tax_set_aside_pct: z.number().int().min(0).max(100), threshold_1099_cents: zCents,
  });
  r.put("/settings", h(async (req) => {
    const s = Settings.parse(req.body);
    await db.inTx(async (tx) => {
      const cur = (await tx.q("SELECT next_invoice_number FROM settings WHERE id = 1 FOR UPDATE"))[0];
      if (s.next_invoice_number < cur.next_invoice_number) throw new UserError("The next invoice number can only go up, so numbers are never reused.");
      await tx.q(`UPDATE settings SET business_name=$1, entity_type=$2, basis=$3, address=$4, email=$5, phone=$6, invoice_prefix=$7, next_invoice_number=$8, terms_days=$9,
                  invoice_footer=$10, sales_tax_on=$11, tax_rate_x1000=$12, tax_set_aside_pct=$13, threshold_1099_cents=$14 WHERE id = 1`,
        [s.business_name, s.entity_type, s.basis, s.address, s.email, s.phone, s.invoice_prefix, s.next_invoice_number, s.terms_days, s.invoice_footer, s.sales_tax_on, s.tax_rate_x1000, s.tax_set_aside_pct, s.threshold_1099_cents]);
    });
  }));
  r.post("/settings/lock", h(async (req) => {
    const b = z.object({ date: zDate.nullable(), confirm: z.string() }).parse(req.body);
    if (b.confirm !== (b.date ? "LOCK" : "UNLOCK")) throw new UserError(`Type ${b.date ? "LOCK" : "UNLOCK"} to confirm.`);
    await db.inTx(async (tx) => {
      await tx.q("UPDATE settings SET locked_through = $1 WHERE id = 1", [b.date]);
      await L.audit(tx, b.date ? "books_locked" : "books_unlocked", b.date ?? "");
    });
  }));
  r.post("/mileage-rates", h(async (req) => {
    const b = z.object({ effective_date: zDate, rate_tenth_cents: z.number().int().min(1).max(5000) }).parse(req.body);
    await db.q("INSERT INTO mileage_rates (effective_date, rate_tenth_cents) VALUES ($1,$2) ON CONFLICT (effective_date) DO UPDATE SET rate_tenth_cents = EXCLUDED.rate_tenth_cents", [b.effective_date, b.rate_tenth_cents]);
  }));

  const Account = z.object({
    number: z.string().regex(/^\d{4}$/, "Use a 4-digit account number."), name: z.string().min(1).max(120), type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]),
    sched_c_line: z.string().max(4).nullable(), deductible_pct: z.number().int().min(0).max(100), requires_purpose: z.boolean(), pay_from: z.boolean(), active: z.boolean(),
  });
  r.post("/accounts", h(async (req) => {
    const a = Account.parse(req.body);
    if ((await db.q("SELECT 1 FROM accounts WHERE number = $1", [a.number]))[0]) throw new UserError("That account number is already used.");
    await db.q("INSERT INTO accounts (number, name, type, sched_c_line, deductible_pct, requires_purpose, pay_from, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [a.number, a.name, a.type, a.sched_c_line || null, a.deductible_pct, a.requires_purpose, a.pay_from, a.active]);
  }));
  r.put("/accounts/:id", h(async (req) => {
    const a = Account.parse(req.body);
    const cur = (await db.q("SELECT * FROM accounts WHERE id = $1", [id(req)]))[0];
    if (!cur) throw new UserError("Account not found.");
    if (cur.system && !a.active) throw new UserError("The app posts to this account automatically, so it cannot be hidden.");
    // Number and type never change once created: history must keep meaning the same thing.
    await db.q("UPDATE accounts SET name=$2, sched_c_line=$3, deductible_pct=$4, requires_purpose=$5, pay_from=$6, active=$7 WHERE id=$1",
      [cur.id, a.name, a.sched_c_line || null, a.deductible_pct, a.requires_purpose, cur.system ? cur.pay_from : a.pay_from, a.active]);
  }));

  // ------------------------------------------------- customers and vendors --
  const Customer = z.object({ name: z.string().min(1).max(200), email: zText, phone: zText, address: zText, tax_exempt: z.boolean().default(false), notes: zText, archived: z.boolean().default(false) });
  r.post("/customers", h(async (req) => {
    const c = Customer.parse(req.body);
    return (await db.q("INSERT INTO customers (name,email,phone,address,tax_exempt,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [c.name, c.email, c.phone, c.address, c.tax_exempt, c.notes]))[0];
  }));
  r.put("/customers/:id", h(async (req) => {
    const c = Customer.parse(req.body);
    await db.q("UPDATE customers SET name=$2,email=$3,phone=$4,address=$5,tax_exempt=$6,notes=$7,archived=$8 WHERE id=$1", [id(req), c.name, c.email, c.phone, c.address, c.tax_exempt, c.notes, c.archived]);
  }));
  const Vendor = z.object({ name: z.string().min(1).max(200), email: zText, address: zText, is_1099: z.boolean().default(false), has_w9: z.boolean().default(false),
    tax_id_last4: z.string().regex(/^\d{0,4}$/, "Enter only the last 4 digits.").default(""), default_account_id: zId.nullable().default(null), archived: z.boolean().default(false) });
  r.post("/vendors", h(async (req) => {
    const v = Vendor.parse(req.body);
    return (await db.q("INSERT INTO vendors (name,email,address,is_1099,has_w9,tax_id_last4,default_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [v.name, v.email, v.address, v.is_1099, v.has_w9, v.tax_id_last4, v.default_account_id]))[0];
  }));
  r.put("/vendors/:id", h(async (req) => {
    const v = Vendor.parse(req.body);
    await db.q("UPDATE vendors SET name=$2,email=$3,address=$4,is_1099=$5,has_w9=$6,tax_id_last4=$7,default_account_id=$8,archived=$9 WHERE id=$1",
      [id(req), v.name, v.email, v.address, v.is_1099, v.has_w9, v.tax_id_last4, v.default_account_id, v.archived]);
  }));

  // ------------------------------------------------------------- invoices --
  const Invoice = z.object({
    customerId: zId, issueDate: zDate, dueDate: zDate, notes: zText, taxRateX1000: z.number().int().min(0).max(30000),
    lines: z.array(z.object({ description: z.string().max(1000), qtyX100: zCents, unitPriceCents: zCents, accountId: zId, taxable: z.boolean() })).min(1).max(200),
  });
  r.get("/invoices", h(async () => db.q(`SELECT * FROM (${R.INVOICE_LIST_SQL}) x ORDER BY issue_date DESC, id DESC LIMIT 2000`, [today()])));
  r.get("/invoices/:id", h(async (req) => db.inTx(async (tx) => {
    const data = await loadInvoice(tx, { id: id(req) }, today());
    if (!data) throw new UserError("Invoice not found.");
    const payments = await tx.q(`SELECT p.*, pa.amount_cents AS applied_cents, a.name AS account_name FROM payment_applications pa JOIN payments p ON p.id = pa.payment_id
                                   JOIN accounts a ON a.id = p.deposit_account_id WHERE pa.invoice_id = $1 ORDER BY p.pay_date, p.id`, [data.inv.id]);
    return { invoice: data.inv, lines: data.lines, payments, entries: await entriesFor(tx, "invoice", data.inv.id) };
  })));
  r.post("/invoices", h(async (req) => ({ id: await db.inTx((tx) => L.saveDraftInvoice(tx, Invoice.parse(req.body))) })));
  r.put("/invoices/:id", h(async (req) => ({ id: await db.inTx((tx) => L.saveDraftInvoice(tx, Invoice.parse(req.body), id(req))) })));
  r.put("/invoices/:id/notes", h(async (req) => { await db.q("UPDATE invoices SET notes = $2 WHERE id = $1", [id(req), z.object({ notes: zText }).parse(req.body).notes]); }));
  r.delete("/invoices/:id", h(async (req) => {
    const out = await db.q("DELETE FROM invoices WHERE id = $1 AND status = 'draft' RETURNING id", [id(req)]);
    if (!out[0]) throw new UserError("Only drafts can be deleted. Void an issued invoice instead.");
  }));
  r.post("/invoices/:id/issue", h(async (req) => ({ number: await db.inTx((tx) => L.issueInvoice(tx, id(req))) })));
  r.post("/invoices/:id/void", h(async (req) => db.inTx((tx) => L.voidInvoice(tx, id(req), today()))));
  r.post("/invoices/:id/duplicate", h(async (req) => db.inTx(async (tx) => {
    const d = await loadInvoice(tx, { id: id(req) }, today());
    if (!d) throw new UserError("Invoice not found.");
    const t = today(), terms = d.settings.terms_days as number;
    const due = new Date(Date.parse(t) + terms * 86400000).toISOString().slice(0, 10);
    return { id: await L.saveDraftInvoice(tx, { customerId: d.inv.customer_id, issueDate: t, dueDate: due, notes: d.inv.notes, taxRateX1000: d.inv.tax_rate_x1000,
      lines: d.lines.map((l) => ({ description: l.description, qtyX100: l.qty_x100, unitPriceCents: l.unit_price_cents, accountId: l.account_id, taxable: l.taxable })) }) };
  })));
  r.get("/invoices/:id/pdf", h(async (req, res) => {
    const d = await db.inTx((tx) => loadInvoice(tx, { id: id(req) }, today()));
    if (!d) throw new UserError("Invoice not found.");
    sendFile(res, await invoicePdf(d), "application/pdf", `${d.inv.number ?? "draft"}.pdf`, true);
  }));

  // ------------------------------------------------------------- payments --
  const Payment = z.object({ customerId: zId, date: zDate, amountCents: zCents, method: z.enum(["check", "ach", "wire", "card", "cash", "zelle", "venmo", "stripe", "other"]),
    depositAccountId: zId, reference: z.string().max(200).default(""), applications: z.array(z.object({ invoiceId: zId, amountCents: zCents })).max(200) });
  r.get("/payments", h(async () => db.q(
    `SELECT p.*, c.name AS customer_name, a.name AS account_name,
            (SELECT string_agg(i.number, ', ') FROM payment_applications pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = p.id) AS invoices,
            (SELECT COALESCE(SUM(pa.amount_cents),0)::bigint FROM payment_applications pa WHERE pa.payment_id = p.id) AS applied_cents
       FROM payments p JOIN customers c ON c.id = p.customer_id JOIN accounts a ON a.id = p.deposit_account_id ORDER BY p.pay_date DESC, p.id DESC LIMIT 2000`)));
  r.post("/payments", h(async (req) => ({ id: await db.inTx((tx) => L.recordPayment(tx, Payment.parse(req.body))) })));
  r.post("/payments/:id/void", h(async (req) => db.inTx((tx) => L.voidPayment(tx, id(req), today()))));

  // ------------------------------------------------------------- receipts --
  r.get("/receipts", h(async () => db.q(
    `SELECT r.id, r.filename, r.mime, r.size_bytes, r.uploaded_at FROM receipts r
      WHERE NOT EXISTS (SELECT 1 FROM expenses x WHERE x.receipt_id = r.id AND NOT x.voided) ORDER BY r.id DESC`)));
  r.post("/receipts", express.raw({ type: () => true, limit: "15mb" }), h(async (req) => {
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!RECEIPT_TYPES.includes(mime)) throw new UserError("Receipts can be photos (JPG, PNG, HEIC, WebP) or PDFs.");
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new UserError("That file is empty.");
    const sha = createHash("sha256").update(body).digest("hex");
    const name = decodeURIComponent(String(req.headers["x-filename"] ?? "receipt")).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "receipt";
    const dup = (await db.q("SELECT id, filename, uploaded_at FROM receipts WHERE sha256 = $1", [sha]))[0];
    if (dup) throw new UserError(`This exact file was already uploaded as "${dup.filename}" (receipt #${dup.id}).`);
    return (await db.q("INSERT INTO receipts (filename, mime, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, mime, size_bytes", [name, mime, body.length, sha, body]))[0];
  }));
  r.get("/receipts/:id/file", h(async (req, res) => {
    const f = (await db.q("SELECT filename, mime, data FROM receipts WHERE id = $1", [id(req)]))[0];
    if (!f) throw new UserError("Receipt not found.");
    sendFile(res, Buffer.from(f.data), f.mime, f.filename, true);
  }));
  r.delete("/receipts/:id", h(async (req) => {
    if ((await db.q("SELECT 1 FROM expenses WHERE receipt_id = $1", [id(req)]))[0]) throw new UserError("This receipt is attached to an expense and is kept with it.");
    await db.q("DELETE FROM receipts WHERE id = $1", [id(req)]);
  }));

  // ------------------------------------------------------------- expenses --
  const Expense = z.object({
    vendorId: zId.nullable(), date: zDate, description: zText, purpose: zText, businessPct: z.number().int().min(0).max(100),
    lines: z.array(z.object({ accountId: zId, amountCents: zCents })).min(1).max(50),
    paidFromAccountId: zId.nullable(), paidDate: zDate.nullable().optional(), payMethod: z.enum(["", "check", "ach", "cash", "debit_card", "credit_card", "other"]).optional(),
    dueDate: zDate.nullable().optional(), receiptId: zId.nullable().optional(),
  });
  r.get("/expenses", h(async (req) => db.q(
    `SELECT x.*, v.name AS vendor_name, pf.name AS paid_from_name,
            (SELECT string_agg(a.number || ' ' || a.name, ', ') FROM expense_lines l JOIN accounts a ON a.id = l.account_id WHERE l.expense_id = x.id) AS categories,
            (SELECT json_agg(json_build_object('account_id', l.account_id, 'amount_cents', l.amount_cents)) FROM expense_lines l WHERE l.expense_id = x.id) AS lines
       FROM expenses x LEFT JOIN vendors v ON v.id = x.vendor_id LEFT JOIN accounts pf ON pf.id = x.paid_from_account_id
      WHERE x.exp_date BETWEEN $1::date AND $2::date ORDER BY x.exp_date DESC, x.id DESC LIMIT 5000`,
    [qDate(req, "from", "1900-01-01"), qDate(req, "to", "2999-12-31")])));
  r.post("/expenses", h(async (req) => ({ id: await db.inTx((tx) => L.recordExpense(tx, Expense.parse(req.body))) })));
  r.post("/expenses/:id/pay", h(async (req) => {
    const b = z.object({ accountId: zId, date: zDate, method: z.string().max(20).optional() }).parse(req.body);
    await db.inTx((tx) => L.payBill(tx, id(req), b));
  }));
  r.post("/expenses/:id/void", h(async (req) => db.inTx((tx) => L.voidExpense(tx, id(req), today()))));

  // -------------------------------------------------- owner money, mileage --
  const Move = z.object({ kind: z.enum(["owner_contribution", "owner_draw", "transfer", "other_income", "opening_balance", "sales_tax_remit", "adjustment"]),
    date: zDate, amountCents: zCents, memo: zText, accountId: zId, otherAccountId: zId.optional() });
  r.get("/moves", h(async () => db.q(
    `SELECT m.*, d.number || ' ' || d.name AS debit_name, c.number || ' ' || c.name AS credit_name FROM money_moves m
       JOIN accounts d ON d.id = m.debit_account_id JOIN accounts c ON c.id = m.credit_account_id ORDER BY m.move_date DESC, m.id DESC LIMIT 2000`)));
  r.post("/moves", h(async (req) => ({ id: await db.inTx((tx) => L.recordMove(tx, Move.parse(req.body))) })));
  r.post("/moves/:id/void", h(async (req) => db.inTx((tx) => L.voidMove(tx, id(req), today()))));

  const Trip = z.object({ date: zDate, milesX10: z.number().int().min(1).max(100000), from: zText, to: zText, purpose: z.string().max(500), odometer: z.number().int().min(0).nullable().optional() });
  r.get("/mileage", h(async () => db.q("SELECT * FROM mileage_trips WHERE NOT voided ORDER BY trip_date DESC, id DESC LIMIT 5000")));
  r.post("/mileage", h(async (req) => ({ id: await db.inTx((tx) => L.recordTrip(tx, Trip.parse(req.body))) })));
  r.post("/mileage/:id/void", h(async (req) => db.inTx((tx) => L.voidTrip(tx, id(req), today()))));

  // ----------------------------------------------------------------- bank --
  const Mapping = z.object({ date: z.number().int().min(0), description: z.number().int().min(0), amount: z.number().int().min(0).optional(),
    debit: z.number().int().min(0).optional(), credit: z.number().int().min(0).optional(), flip: z.boolean().optional() }).nullable().optional();
  const Csv = z.object({ accountId: zId, text: z.string().min(1).max(5_000_000), mapping: Mapping, flip: z.boolean().optional() });
  const parseUpload = (b: z.infer<typeof Csv>) => {
    const first = B.parseBankCsv(b.text, b.mapping ?? undefined);
    if (first.mapping && b.flip !== undefined && !b.mapping) return B.parseBankCsv(b.text, { ...first.mapping, flip: b.flip });
    return first;
  };
  r.post("/bank/preview", h(async (req) => {
    const p = parseUpload(Csv.parse(req.body));
    return { header: p.header, mapping: p.mapping, count: p.lines.length, skipped: p.skipped, sample: p.lines.slice(0, 8),
      moneyIn: p.lines.filter((l) => l.amountCents > 0).reduce((a, l) => a + l.amountCents, 0), moneyOut: p.lines.filter((l) => l.amountCents < 0).reduce((a, l) => a - l.amountCents, 0) };
  }));
  r.post("/bank/import", h(async (req) => {
    const b = Csv.parse(req.body), p = parseUpload(b);
    if (!p.mapping) throw new UserError("Tell me which columns hold the date, description and amount.");
    const acct = (await db.q("SELECT pay_from FROM accounts WHERE id = $1", [b.accountId]))[0];
    if (!acct?.pay_from) throw new UserError("Pick a bank or card account.");
    return db.inTx(async (tx) => ({ ...(await B.importLines(tx, b.accountId, p.lines)), skipped: p.skipped }));
  }));
  r.get("/bank", h(async () => db.inTx(async (tx) => {
    const t = today();
    const lines = await tx.q(`SELECT b.*, a.number AS account_number, a.name AS account_name FROM bank_transactions b JOIN accounts a ON a.id = b.account_id
                               WHERE b.status = 'new' ORDER BY b.txn_date, b.id LIMIT 300`);
    for (const l of lines) l.suggestions = await B.suggest(tx, l, t);
    const waiting = (await tx.q("SELECT COUNT(*)::int AS n FROM bank_transactions WHERE status = 'new'"))[0].n;
    const recent = await tx.q(`SELECT b.*, a.name AS account_name FROM bank_transactions b JOIN accounts a ON a.id = b.account_id WHERE b.status <> 'new' ORDER BY b.id DESC LIMIT 30`);
    return { lines, waiting, recent };
  })));
  r.get("/bank/reconcile", h(async (req) => db.inTx(async (tx) => {
    const accountId = Number(req.query.accountId), asOf = qDate(req, "asOf", today());
    const a = (await R.balances(tx, "CASH", null, asOf)).find((x) => x.id === accountId);
    if (!a) throw new UserError("Pick an account.");
    const unsortedLines = (await tx.q("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS total FROM bank_transactions WHERE account_id = $1 AND status = 'new' AND txn_date <= $2", [accountId, asOf]))[0];
    return { asOf, type: a.type, booksBalance: a.type === "liability" ? a.credit - a.debit : a.debit - a.credit, unsortedCount: unsortedLines.n, unsortedTotal: unsortedLines.total };
  })));
  const Resolve = z.object({
    action: z.enum(["invoice", "bill", "link", "expense", "income", "owner_contribution", "owner_draw", "transfer", "ignore", "reopen"]),
    invoiceId: zId.optional(), expenseId: zId.optional(), ref: z.string().max(40).optional(), accountId: zId.optional(), vendorId: zId.nullable().optional(),
    description: zText, purpose: zText, businessPct: z.number().int().min(0).max(100).default(100), payMethod: z.string().max(20).optional(),
  });
  r.post("/bank/:id/resolve", h(async (req) => db.inTx(async (tx) => {
    const b = Resolve.parse(req.body);
    const t = (await tx.q("SELECT * FROM bank_transactions WHERE id = $1 FOR UPDATE", [id(req)]))[0];
    if (!t) throw new UserError("Bank line not found.");
    if (b.action === "reopen") {
      if (t.status !== "ignored" && !/^(payment|expense):/.test(t.resolution)) throw new UserError("Only ignored or linked lines can be reopened. To undo a posted line, void what it created.");
      await tx.q("UPDATE bank_transactions SET status = 'new', resolution = '' WHERE id = $1", [t.id]);
      return;
    }
    if (t.status !== "new") throw new UserError("This line was already sorted.");
    const amt = Math.abs(t.amount_cents), isIn = t.amount_cents > 0;
    const need = <T>(v: T | undefined | null, msg: string): T => { if (v === undefined || v === null) throw new UserError(msg); return v; };
    let resolution = "";
    switch (b.action) {
      case "ignore": break;
      case "link": resolution = need(b.ref, "Pick what this matches."); break;
      case "invoice": {
        if (!isIn) throw new UserError("Only deposits can pay an invoice.");
        const inv = (await tx.q("SELECT * FROM invoices WHERE id = $1", [need(b.invoiceId, "Pick an invoice.")]))[0];
        if (!inv) throw new UserError("Invoice not found.");
        const balance = inv.total_cents - (await L.invoicePaid(tx, inv.id));
        const payId = await L.recordPayment(tx, { customerId: inv.customer_id, date: t.txn_date, amountCents: amt, method: "ach", depositAccountId: t.account_id,
          reference: t.description.slice(0, 180), applications: [{ invoiceId: inv.id, amountCents: Math.min(amt, balance) }] });
        resolution = "payment:" + payId; break;
      }
      case "bill":
        if (isIn) throw new UserError("Only money going out can pay a bill.");
        await L.payBill(tx, need(b.expenseId, "Pick a bill."), { accountId: t.account_id, date: t.txn_date, method: b.payMethod });
        resolution = "expense:" + b.expenseId; break;
      case "expense": {
        if (isIn) throw new UserError("This line is money in. Choose Income, Owner contribution or Transfer.");
        const xid = await L.recordExpense(tx, { vendorId: b.vendorId ?? null, date: t.txn_date, description: b.description || t.description, purpose: b.purpose, businessPct: b.businessPct,
          lines: [{ accountId: need(b.accountId, "Pick a category."), amountCents: amt }], paidFromAccountId: t.account_id, paidDate: t.txn_date, payMethod: (b.payMethod as any) || undefined });
        resolution = "expense:" + xid; break;
      }
      case "income":
        if (!isIn) throw new UserError("This line is money out.");
        resolution = "move:" + (await L.recordMove(tx, { kind: "other_income", date: t.txn_date, amountCents: amt, memo: b.description || t.description, accountId: t.account_id, otherAccountId: need(b.accountId, "Pick an income category.") }));
        break;
      case "owner_contribution":
        if (!isIn) throw new UserError("A contribution is money in.");
        resolution = "move:" + (await L.recordMove(tx, { kind: "owner_contribution", date: t.txn_date, amountCents: amt, memo: b.description || t.description, accountId: t.account_id })); break;
      case "owner_draw":
        if (isIn) throw new UserError("A draw is money out.");
        resolution = "move:" + (await L.recordMove(tx, { kind: "owner_draw", date: t.txn_date, amountCents: amt, memo: b.description || t.description, accountId: t.account_id })); break;
      case "transfer": {
        const other = need(b.accountId, "Pick the other account.");
        const from = isIn ? other : t.account_id, to = isIn ? t.account_id : other;
        resolution = "move:" + (await L.recordMove(tx, { kind: "transfer", date: t.txn_date, amountCents: amt, memo: b.description || t.description, accountId: from, otherAccountId: to }));
        // The same transfer usually shows up in the other account's import too. Mark that side so it is not posted twice.
        await tx.q(`UPDATE bank_transactions SET status = 'matched', resolution = $1 WHERE id = (
                      SELECT id FROM bank_transactions WHERE status = 'new' AND account_id = $2 AND amount_cents = $3 AND ABS(txn_date - $4::date) <= 5 ORDER BY ABS(txn_date - $4::date), id LIMIT 1)`,
          [resolution, other, -t.amount_cents, t.txn_date]);
        break;
      }
    }
    await tx.q("UPDATE bank_transactions SET status = $2, resolution = $3 WHERE id = $1", [t.id, b.action === "ignore" ? "ignored" : "matched", resolution]);
  })));

  // -------------------------------------------------------------- reports --
  r.get("/reports/:name", h(async (req, res) => db.inTx(async (tx) => {
    const t = today(), basis = await basisOf(req, tx);
    const from = qDate(req, "from", t.slice(0, 4) + "-01-01"), to = qDate(req, "to", t);
    const year = Number(req.query.year) || Number(t.slice(0, 4));
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const name = req.params.name;
    if (req.query.format === "csv") {
      const csv = toCsv(await reportRows(tx, name, { basis, from, to, year, accountId }));
      sendFile(res, Buffer.from("﻿" + csv), "text/csv; charset=utf-8", `${name}_${to}.csv`, false);
      return;
    }
    switch (name) {
      case "pl": return R.profitAndLoss(tx, basis, from, to);
      case "tb": return R.trialBalance(tx, basis, to);
      case "bs": return R.balanceSheet(tx, basis, to);
      case "schedc": return R.scheduleC(tx, basis, from, to);
      case "aging": return R.arAging(tx, to);
      case "salestax": return R.salesTax(tx, from, to);
      case "1099": return R.report1099(tx, year);
      case "gl": return R.generalLedger(tx, basis, from, to, accountId);
      default: throw new UserError("Unknown report.");
    }
  })));
  r.get("/entries", h(async (req) => db.inTx((tx) => entriesFor(tx, String(req.query.type), Number(req.query.id)))));
  r.get("/checklist", h(async (req) => db.inTx((tx) => R.yearEndChecklist(tx, Number(req.query.year) || Number(today().slice(0, 4)), today()))));
  r.get("/audit", h(async () => db.q("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500")));

  r.get("/export", h(async (req, res) => {
    const year = Number(req.query.year) || Number(today().slice(0, 4)), full = req.query.full === "1";
    if (year < 2000 || year > 2100) throw new UserError("Pick a year.");
    const zip = await db.inTx(async (tx) => {
      const z = await buildZip(tx, year, full);
      await L.audit(tx, full ? "export_everything" : "export_accountant_package", String(year));
      if (full) await tx.q("UPDATE settings SET last_export_at = now() WHERE id = 1");
      return z;
    });
    sendFile(res, Buffer.from(zip), "application/zip", full ? `books-backup-${today()}.zip` : `accountant-package-${year}.zip`, false);
  }));

  return r;
}

async function entriesFor(tx: Tx, type: string, sourceId: number) {
  const entries = await tx.q("SELECT * FROM journal_entries WHERE source_type = $1 AND source_id = $2 ORDER BY id", [type, sourceId]);
  for (const e of entries) e.lines = await tx.q("SELECT l.debit_cents, l.credit_cents, a.number, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.id", [e.id]);
  return entries;
}

export function sendFile(res: Response, body: Buffer, type: string, filename: string, inline: boolean) {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.\- ]+/g, "_")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.end(body);
}

export function sendError(res: Response, e: unknown) {
  if (res.headersSent) return;
  if (e instanceof z.ZodError) {
    const i = e.issues[0];
    return res.status(400).json({ error: `Check ${i.path.join(".") || "the form"}: ${i.message}` });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof UserError) return res.status(400).json({ error: msg });
  // Messages raised by the database protections are meant for the owner to read.
  if (/books are locked|does not balance|cannot be edited or deleted/.test(msg)) return res.status(400).json({ error: msg });
  if (/payload|too large/i.test(msg)) return res.status(413).json({ error: "That file is too large (15 MB limit)." });
  console.error(e);
  res.status(500).json({ error: "Something went wrong on the server. Nothing was saved." });
}
