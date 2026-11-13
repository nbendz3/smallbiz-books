// The checks that prove the books are right. Run with: npm test
// They use a throwaway in-memory database, never your real one. All data here is example data.
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../server/db.js";
import * as L from "../server/ledger.js";
import * as R from "../server/reports.js";
import * as B from "../server/bank.js";
import { allocate, lineAmount, mileageDeduction, taxFor } from "../server/money.js";
import { buildZip, reportRows } from "../server/exports.js";

let db: Db;
const TODAY = "2026-11-12";
const acct = (n: string) => db.inTx((tx) => L.acctId(tx, n));
const customer = async (name = "Example Customer") => (await db.q("INSERT INTO customers (name) VALUES ($1) RETURNING id", [name]))[0].id as number;
const vendor = async (name = "Example Vendor", is1099 = false) => (await db.q("INSERT INTO vendors (name, is_1099) VALUES ($1,$2) RETURNING id", [name, is1099]))[0].id as number;

async function invoice(customerId: number, lines: { cents: number; taxable?: boolean; account?: string }[], opts: { date?: string; due?: string; rate?: number } = {}) {
  const input: L.InvoiceInput = {
    customerId, issueDate: opts.date ?? "2026-03-01", dueDate: opts.due ?? "2026-03-31", notes: "", taxRateX1000: opts.rate ?? 0,
    lines: await Promise.all(lines.map(async (l) => ({ description: "Example work", qtyX100: 100, unitPriceCents: l.cents, accountId: await acct(l.account ?? "4000"), taxable: !!l.taxable }))),
  };
  const id = await db.inTx((tx) => L.saveDraftInvoice(tx, input));
  await db.inTx((tx) => L.issueInvoice(tx, id));
  return id;
}
const pay = async (customerId: number, invoiceId: number | null, amountCents: number, applied = amountCents, date = "2026-03-10") =>
  db.inTx(async (tx) => L.recordPayment(tx, { customerId, date, amountCents, method: "check", depositAccountId: await L.acctId(tx, "1010"), reference: "",
    applications: invoiceId ? [{ invoiceId, amountCents: applied }] : [] }));
const expense = async (o: Partial<L.ExpenseInput> & { cents: number; account: string; from?: string | null }) =>
  db.inTx(async (tx) => L.recordExpense(tx, { vendorId: null, date: "2026-03-05", description: "Example", purpose: "", businessPct: 100,
    lines: [{ accountId: await L.acctId(tx, o.account), amountCents: o.cents }], paidFromAccountId: o.from === null ? null : await L.acctId(tx, o.from ?? "1010"), ...o }));
const bal = async (basis: R.Basis, number: string) => { const b = (await db.inTx((tx) => R.balances(tx, basis, null, null))).find((x) => x.number === number)!; return b.debit - b.credit; };
const bothBalanced = async () => {
  for (const basis of ["CASH", "ACCRUAL"] as const) {
    for (const d of ["2026-03-05", "2026-03-10", "2026-12-31"]) expect((await db.inTx((tx) => R.trialBalance(tx, basis, d))).balanced).toBe(true);
    expect((await db.inTx((tx) => R.balanceSheet(tx, basis, "2026-12-31"))).balanced).toBe(true);
  }
};

beforeEach(async () => { db = await openDb({ memory: true }); });

describe("money math", () => {
  it("splits to the exact cent in 2,000 random cases", () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const weights = Array.from({ length: 1 + rnd(5) }, () => rnd(100000));
      const sum = weights.reduce((a, b) => a + b, 0);
      if (sum === 0) continue;
      const total = rnd(sum + 1);
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p, j) => { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(weights[j]); });
    }
  });
  it("rounds lines, tax and mileage half up", () => {
    expect(lineAmount(150, 9999)).toBe(14999); // 1.5 x 99.99 = 149.985
    expect(taxFor(10000, 7250)).toBe(725);
    expect(taxFor(999, 9375)).toBe(94); // 9.99 x 9.375% = 0.9366
    expect(mileageDeduction(124, 725)).toBe(899); // 12.4 mi x 72.5 cents
  });
});

describe("database protections", () => {
  it("refuses an unbalanced entry", async () => {
    await expect(db.inTx(async (tx) => {
      const e = (await tx.q("INSERT INTO journal_entries (entry_date, memo, book, source_type, source_id, source_key) VALUES ('2026-01-01','bad','BOTH','test',1,'bad:1') RETURNING id"))[0].id;
      await tx.q("INSERT INTO journal_lines (entry_id, account_id, debit_cents) VALUES ($1,$2,500)", [e, await L.acctId(tx, "1010")]);
      await tx.q("INSERT INTO journal_lines (entry_id, account_id, credit_cents) VALUES ($1,$2,400)", [e, await L.acctId(tx, "4000")]);
    })).rejects.toThrow(/does not balance/);
    expect((await db.q("SELECT COUNT(*)::int AS n FROM journal_entries"))[0].n).toBe(0);
  });
  it("refuses edits and deletes of posted lines", async () => {
    await expense({ cents: 4510, account: "6140" });
    await expect(db.q("UPDATE journal_lines SET debit_cents = 1 WHERE debit_cents > 0")).rejects.toThrow(/cannot be edited/);
    await expect(db.q("DELETE FROM journal_lines")).rejects.toThrow(/cannot be edited/);
    await expect(db.q("DELETE FROM journal_entries")).rejects.toThrow();
  });
  it("blocks posting into a locked period, and reverses in the open period instead", async () => {
    const id = await expense({ cents: 1000, account: "6140" });
    await db.q("UPDATE settings SET locked_through = '2026-06-30' WHERE id = 1");
    await expect(expense({ cents: 500, account: "6140" })).rejects.toThrow(/locked/);
    await db.inTx((tx) => L.voidExpense(tx, id, TODAY));
    const rev = (await db.q("SELECT entry_date FROM journal_entries WHERE reverses_id IS NOT NULL"))[0];
    expect(rev.entry_date).toBe(TODAY);
    expect(await bal("CASH", "6140")).toBe(0);
  });
  it("does not double post the same source", async () => {
    const line = async (tx: any) => [{ accountId: await L.acctId(tx, "1010"), debit: 100 }, { accountId: await L.acctId(tx, "3050"), credit: 100 }];
    const first = await db.inTx(async (tx) => L.post(tx, { date: "2026-01-02", memo: "x", book: "BOTH", sourceType: "t", sourceId: 1, sourceKey: "t:1", lines: await line(tx) }));
    const second = await db.inTx(async (tx) => L.post(tx, { date: "2026-01-02", memo: "x", book: "BOTH", sourceType: "t", sourceId: 1, sourceKey: "t:1", lines: await line(tx) }));
    expect(first).not.toBeNull(); expect(second).toBeNull();
    expect(await bal("CASH", "1010")).toBe(100);
  });
});

describe("invoices and payments", () => {
  it("an invoice hits accrual only; the payment recognizes cash income", async () => {
    const c = await customer(), inv = await invoice(c, [{ cents: 100000 }]);
    expect(await bal("ACCRUAL", "1080")).toBe(100000);
    expect(await bal("ACCRUAL", "4000")).toBe(-100000);
    expect(await bal("CASH", "4000")).toBe(0);
    await pay(c, inv, 100000);
    expect(await bal("ACCRUAL", "1080")).toBe(0);
    expect(await bal("CASH", "4000")).toBe(-100000);
    expect(await bal("CASH", "1010")).toBe(100000);
    expect(await bal("ACCRUAL", "1010")).toBe(100000);
    await bothBalanced();
  });
  it("numbers never repeat and issued invoices cannot be edited", async () => {
    const c = await customer();
    const a = await invoice(c, [{ cents: 1000 }]), b = await invoice(c, [{ cents: 2000 }]);
    const nums = (await db.q("SELECT number FROM invoices ORDER BY id")).map((r) => r.number);
    expect(nums).toEqual(["INV-1001", "INV-1002"]);
    await db.inTx((tx) => L.voidInvoice(tx, a, TODAY));
    const d = await invoice(c, [{ cents: 3000 }]);
    expect((await db.q("SELECT number FROM invoices WHERE id = $1", [d]))[0].number).toBe("INV-1003");
    await expect(db.inTx(async (tx) => L.saveDraftInvoice(tx, { customerId: c, issueDate: "2026-03-01", dueDate: "2026-03-31", notes: "", taxRateX1000: 0,
      lines: [{ description: "", qtyX100: 100, unitPriceCents: 1, accountId: await L.acctId(tx, "4000"), taxable: false }] }, b))).rejects.toThrow(/no longer be edited/);
    await expect(db.inTx((tx) => L.issueInvoice(tx, b))).rejects.toThrow(/already issued/);
  });
  it("void posts an exact reversal, and is blocked while payments are applied", async () => {
    const c = await customer(), inv = await invoice(c, [{ cents: 50000 }]);
    const p = await pay(c, inv, 20000);
    await expect(db.inTx((tx) => L.voidInvoice(tx, inv, TODAY))).rejects.toThrow(/payments applied/);
    await db.inTx((tx) => L.voidPayment(tx, p, TODAY));
    expect(await bal("CASH", "4000")).toBe(0);
    expect(await bal("CASH", "1010")).toBe(0);
    await db.inTx((tx) => L.voidInvoice(tx, inv, TODAY));
    for (const n of ["1080", "4000", "1010"]) expect(await bal("ACCRUAL", n)).toBe(0);
    await bothBalanced();
  });
  it("cannot be over-applied; paid amount always equals applications", async () => {
    const c = await customer(), other = await customer("Someone Else"), inv = await invoice(c, [{ cents: 30000 }]);
    await expect(pay(c, inv, 40000, 40000)).rejects.toThrow(/left to pay/);
    await expect(pay(c, inv, 10000, 20000)).rejects.toThrow(/more than the payment/);
    await expect(pay(other, inv, 10000)).rejects.toThrow(/different customer/);
    await pay(c, inv, 10000); await pay(c, inv, 20000);
    await expect(pay(c, inv, 1)).rejects.toThrow(/left to pay/);
    const row = (await db.q(`SELECT * FROM (${R.INVOICE_LIST_SQL}) x WHERE id = $2`, [TODAY, inv]))[0];
    expect(row.paid_cents).toBe(30000); expect(row.display_status).toBe("Paid");
  });
  it("derives every status", async () => {
    const c = await customer();
    const status = async (id: number) => (await db.q(`SELECT display_status FROM (${R.INVOICE_LIST_SQL}) x WHERE id = $2`, [TODAY, id]))[0].display_status;
    const sent = await invoice(c, [{ cents: 1000 }], { date: "2026-11-01", due: "2026-12-01" });
    const part = await invoice(c, [{ cents: 1000 }], { date: "2026-11-01", due: "2026-12-01" });
    const late = await invoice(c, [{ cents: 1000 }]);
    await pay(c, part, 400, 400, "2026-11-05");
    expect([await status(sent), await status(part), await status(late)]).toEqual(["Sent", "Partially paid", "Overdue"]);
  });
  it("partial payments split income and sales tax to the cent, across many odd payments", async () => {
    await db.q("UPDATE settings SET sales_tax_on = true WHERE id = 1");
    const c = await customer();
    const inv = await invoice(c, [{ cents: 33333, taxable: true, account: "4010" }, { cents: 12345 }, { cents: 7, taxable: true, account: "4010" }], { rate: 9375 });
    const total = (await db.q("SELECT total_cents, tax_cents FROM invoices WHERE id = $1", [inv]))[0];
    expect(total.tax_cents).toBe(taxFor(33333, 9375) + taxFor(7, 9375));
    let left = total.total_cents as number, n = 0, voided = false;
    while (left > 0) {
      const amt = Math.min(left, [1, 777, 3, 12001, 5000][n++ % 5]);
      const p = await pay(c, inv, amt);
      if (!voided && n === 3) { await db.inTx((tx) => L.voidPayment(tx, p, TODAY)); voided = true; continue; } // a bounced check in the middle
      left -= amt;
      expect(-(await bal("CASH", "4000")) - (await bal("CASH", "4010")) - (await bal("CASH", "2060"))).toBe(total.total_cents - left); // cash income recognized = cash received
    }
    for (const n2 of ["4000", "4010", "2060"]) expect(await bal("CASH", n2)).toBe(await bal("ACCRUAL", n2));
    expect(await bal("ACCRUAL", "1080")).toBe(0);
    await bothBalanced();
  });
  it("overpayments go to Customer Deposits and can be used later", async () => {
    const c = await customer(), inv = await invoice(c, [{ cents: 10000 }]);
    await pay(c, inv, 15000, 10000);
    expect(await bal("CASH", "2200")).toBe(-5000); expect(await bal("ACCRUAL", "2200")).toBe(-5000);
    const inv2 = await invoice(c, [{ cents: 5000 }]);
    await db.inTx(async (tx) => L.recordPayment(tx, { customerId: c, date: "2026-04-01", amountCents: 5000, method: "other", depositAccountId: await L.acctId(tx, "2200"), reference: "credit", applications: [{ invoiceId: inv2, amountCents: 5000 }] }));
    expect(await bal("CASH", "2200")).toBe(0); expect(await bal("CASH", "4000")).toBe(-15000); expect(await bal("CASH", "1010")).toBe(15000);
    await bothBalanced();
  });
  it("accounts receivable in the ledger equals open invoices", async () => {
    const c = await customer();
    const a = await invoice(c, [{ cents: 40000 }]); await invoice(c, [{ cents: 2500 }]); const v = await invoice(c, [{ cents: 999 }]);
    await pay(c, a, 15000); await db.inTx((tx) => L.voidInvoice(tx, v, TODAY));
    const aging = await db.inTx((tx) => R.arAging(tx, "2026-12-31"));
    expect(aging.totals.total).toBe(27500);
    expect(await bal("ACCRUAL", "1080")).toBe(27500);
    expect(aging.totals.d90plus).toBe(27500);
  });
});

describe("expenses and bills", () => {
  it("a card purchase is an expense now; paying the card is only a transfer", async () => {
    await expense({ cents: 4510, account: "6140", from: "2100" });
    expect(await bal("CASH", "6140")).toBe(4510); expect(await bal("CASH", "2100")).toBe(-4510);
    await db.inTx(async (tx) => L.recordMove(tx, { kind: "transfer", date: "2026-03-20", amountCents: 4510, memo: "card bill", accountId: await L.acctId(tx, "1010"), otherAccountId: await L.acctId(tx, "2100") }));
    expect(await bal("CASH", "2100")).toBe(0); expect(await bal("CASH", "1010")).toBe(-4510); expect(await bal("CASH", "6140")).toBe(4510);
    await bothBalanced();
  });
  it("personal share goes to Owner Draws", async () => {
    await expense({ cents: 9999, account: "6185", businessPct: 60 });
    expect(await bal("CASH", "6185")).toBe(5999); expect(await bal("CASH", "3070")).toBe(4000); expect(await bal("CASH", "1010")).toBe(-9999);
  });
  it("a bill is in accrual only until paid", async () => {
    const id = await expense({ cents: 25000, account: "6090", from: null });
    expect(await bal("ACCRUAL", "6090")).toBe(25000); expect(await bal("ACCRUAL", "2000")).toBe(-25000); expect(await bal("CASH", "6090")).toBe(0);
    await db.inTx(async (tx) => L.payBill(tx, id, { accountId: await L.acctId(tx, "1010"), date: "2026-04-02" }));
    expect(await bal("ACCRUAL", "2000")).toBe(0); expect(await bal("CASH", "6090")).toBe(25000); expect(await bal("ACCRUAL", "6090")).toBe(25000);
    expect(await bal("CASH", "1010")).toBe(-25000); expect(await bal("ACCRUAL", "1010")).toBe(-25000);
    await expect(db.inTx(async (tx) => L.payBill(tx, id, { accountId: await L.acctId(tx, "1010"), date: "2026-04-02" }))).rejects.toThrow(/already paid/);
    await db.inTx((tx) => L.voidExpense(tx, id, TODAY));
    for (const b of ["CASH", "ACCRUAL"] as const) for (const n of ["6090", "2000", "1010"]) expect(await bal(b, n)).toBe(0);
    await bothBalanced();
  });
  it("meals and travel need a business purpose", async () => {
    await expect(expense({ cents: 5000, account: "6170" })).rejects.toThrow(/business purpose/);
    await expense({ cents: 5000, account: "6170", purpose: "Lunch with example client about the March project" });
  });
  it("a receipt can be attached once", async () => {
    const r = (await db.q("INSERT INTO receipts (filename, mime, size_bytes, sha256, data) VALUES ('a.pdf','application/pdf',3,'abc',$1) RETURNING id", [Buffer.from("abc")]))[0].id;
    await expense({ cents: 100, account: "6140", receiptId: r });
    await expect(expense({ cents: 100, account: "6140", receiptId: r })).rejects.toThrow(/already attached/);
    await expect(db.q("INSERT INTO receipts (filename, mime, size_bytes, sha256, data) VALUES ('b.pdf','application/pdf',3,'abc',$1)", [Buffer.from("abc")])).rejects.toThrow();
  });
});

describe("reports", () => {
  async function busyYear() {
    await db.q("UPDATE settings SET sales_tax_on = true WHERE id = 1");
    const c = await customer();
    const a = await invoice(c, [{ cents: 250000 }, { cents: 40000, taxable: true, account: "4010" }], { rate: 7250 });
    await invoice(c, [{ cents: 80000 }], { date: "2026-05-01", due: "2026-05-31" });
    await pay(c, a, 200000);
    await expense({ cents: 12345, account: "6170", purpose: "Example client dinner" });
    await expense({ cents: 12301, account: "6170", purpose: "Example client lunch" });
    await expense({ cents: 30000, account: "5000", from: "2100" });
    await expense({ cents: 9900, account: "6200" });
    await expense({ cents: 60000, account: "6090", from: null });
    await db.inTx(async (tx) => L.recordMove(tx, { kind: "owner_contribution", date: "2026-01-02", amountCents: 500000, memo: "", accountId: await L.acctId(tx, "1010") }));
    await db.inTx(async (tx) => L.recordMove(tx, { kind: "owner_draw", date: "2026-06-01", amountCents: 50000, memo: "", accountId: await L.acctId(tx, "1010") }));
    await db.inTx(async (tx) => L.recordMove(tx, { kind: "other_income", date: "2026-06-30", amountCents: 321, memo: "interest", accountId: await L.acctId(tx, "1020"), otherAccountId: await L.acctId(tx, "4200") }));
    await db.inTx((tx) => L.recordTrip(tx, { date: "2026-02-03", milesX10: 124, from: "Office", to: "Example client", purpose: "Site visit" }));
    await db.inTx((tx) => L.recordTrip(tx, { date: "2026-08-03", milesX10: 100, from: "Office", to: "Example client", purpose: "Site visit" }));
  }
  it("trial balance, balance sheet and Schedule C all tie, on both books", async () => {
    await busyYear();
    await bothBalanced();
    for (const basis of ["CASH", "ACCRUAL"] as const) {
      const pl = await db.inTx((tx) => R.profitAndLoss(tx, basis, "2026-01-01", "2026-12-31"));
      const sc = await db.inTx((tx) => R.scheduleC(tx, basis, "2026-01-01", "2026-12-31"));
      expect(sc.ties).toBe(true);
      expect(sc.bookNet).toBe(pl.net);
      const meals = sc.rows.find((r) => r.line === "24b")!;
      expect(meals.ledger).toBe(24646);
      expect(meals.reportable).toBe(12323); // 50% of the meals total
      expect(sc.nonDeductible).toBe(24646 - meals.reportable);
      expect(sc.netProfit - sc.nonDeductible).toBe(pl.net);
      expect(sc.unsorted).toEqual({ suspense: 0, uncategorized: 0 });
    }
    const cash = await db.inTx((tx) => R.profitAndLoss(tx, "CASH", "2026-01-01", "2026-12-31"));
    const accrual = await db.inTx((tx) => R.profitAndLoss(tx, "ACCRUAL", "2026-01-01", "2026-12-31"));
    expect(accrual.totalIncome).toBe(250000 + 40000 + 80000 + 321);
    expect(cash.totalIncome + -(await bal("CASH", "2060"))).toBe(200000 + 321);
    expect(accrual.totalExpenses - cash.totalExpenses).toBe(60000); // the unpaid bill
  });
  it("uncategorized money is flagged", async () => {
    await expense({ cents: 700, account: "6990" });
    const sc = await db.inTx((tx) => R.scheduleC(tx, "CASH", "2026-01-01", "2026-12-31"));
    expect(sc.unsorted.uncategorized).toBe(700); expect(sc.unassigned).toBe(700); expect(sc.ties).toBe(true);
  });
  it("mileage uses the rate in effect on the trip date", async () => {
    await busyYear();
    const trips = await db.q("SELECT deduction_cents FROM mileage_trips ORDER BY trip_date");
    expect(trips.map((t) => t.deduction_cents)).toEqual([899, 760]);
    expect(await bal("CASH", "6020")).toBe(1659);
  });
  it("sales tax report equals the 2060 liability, and remitting clears it", async () => {
    await busyYear();
    const st = await db.inTx((tx) => R.salesTax(tx, "2026-01-01", "2026-12-31"));
    const tax = st.rows.reduce((a, r) => a + r.tax, 0);
    expect(tax).toBe(2900); expect(st.liability).toBe(2900);
    expect(st.rows.find((r) => r.rate === 7250)!.taxable).toBe(40000);
    await db.inTx(async (tx) => L.recordMove(tx, { kind: "sales_tax_remit", date: "2026-07-31", amountCents: 2900, memo: "Q2", accountId: await L.acctId(tx, "1010") }));
    expect(await bal("ACCRUAL", "2060")).toBe(0);
  });
  it("1099 report leaves out card payments and vendors under the threshold", async () => {
    const big = await vendor("Example Contractor A", true), small = await vendor("Example Contractor B", true), card = await vendor("Example Contractor C", true);
    await expense({ cents: 150000, account: "6040", vendorId: big }); await expense({ cents: 60000, account: "6040", vendorId: big, date: "2026-09-01" });
    await expense({ cents: 199999, account: "6040", vendorId: small });
    await expense({ cents: 500000, account: "6040", vendorId: card, from: "2100" });
    const r = await db.inTx((tx) => R.report1099(tx, 2026));
    expect(r.threshold).toBe(200000);
    expect(r.over.map((v) => [v.name, v.reportable])).toEqual([["Example Contractor A", 210000]]);
    expect(r.under.map((v) => v.name).sort()).toEqual(["Example Contractor B", "Example Contractor C"]);
    expect(r.under.find((v) => v.name === "Example Contractor C")!.by_card).toBe(500000);
  });
  it("dashboard, checklist, CSV reports and both ZIP exports build", async () => {
    await busyYear();
    const d = await db.inTx((tx) => R.dashboard(tx, "CASH", TODAY));
    expect(d.invoices.unpaid).toBe(92900 + 80000); expect(d.invoices.overdue_count).toBe(2); expect(d.setAside).toBeGreaterThan(0);
    expect((await db.inTx((tx) => R.yearEndChecklist(tx, 2026, TODAY))).length).toBeGreaterThan(5);
    for (const name of ["pl", "tb", "bs", "schedc", "aging", "salestax", "1099", "gl", "mileage"])
      expect((await db.inTx((tx) => reportRows(tx, name, { basis: "CASH", from: "2026-01-01", to: "2026-12-31", year: 2026 }))).length).toBeGreaterThan(0);
    expect((await db.inTx((tx) => buildZip(tx, 2026, false))).length).toBeGreaterThan(1000);
    expect((await db.inTx((tx) => buildZip(tx, 2026, true))).length).toBeGreaterThan(1000);
  });
});

describe("bank import", () => {
  const CSV = `Date,Description,Amount\n03/10/2026,"DEPOSIT EXAMPLE CUSTOMER, INC",1000.00\n3/11/2026,OFFICE STORE #12,-45.10\n03/11/2026,OFFICE STORE #12,-45.10\n03/12/2026,CARD PAYMENT,(200.00)\nnot a date,x,1\n`;
  it("parses common bank formats", () => {
    const p = B.parseBankCsv(CSV);
    expect(p.lines.map((l) => l.amountCents)).toEqual([100000, -4510, -4510, -20000]);
    expect(p.lines[0]).toMatchObject({ date: "2026-03-10", description: "DEPOSIT EXAMPLE CUSTOMER, INC" });
    expect(p.skipped).toBe(1);
    const two = B.parseBankCsv("Posted Date,Payee,Debit,Credit\n2026-03-01,RENT,1500.00,\n2026-03-02,DEPOSIT,,\"2,000.50\"\n");
    expect(two.lines.map((l) => l.amountCents)).toEqual([-150000, 200050]);
    expect(B.parseBankCsv("a,b\n1,2\n").mapping).toBeNull();
    expect(B.parseAmount("$1,234.5")).toBe(123450); expect(B.parseAmount("abc")).toBeNull();
  });
  it("re-importing the same file adds nothing, and identical same-day lines are both kept", async () => {
    const a = await acct("1010"), lines = B.parseBankCsv(CSV).lines;
    expect(await db.inTx((tx) => B.importLines(tx, a, lines))).toEqual({ imported: 4, duplicates: 0 });
    expect(await db.inTx((tx) => B.importLines(tx, a, lines))).toEqual({ imported: 0, duplicates: 4 });
    expect((await db.q("SELECT COUNT(*)::int AS n FROM journal_entries"))[0].n).toBe(0); // importing posts nothing
  });
  it("suggests the matching invoice, the unpaid bill, and things already recorded", async () => {
    const a = await acct("1010"), c = await customer("Example Customer Inc"), inv = await invoice(c, [{ cents: 100000 }]);
    const bill = await expense({ cents: 20000, account: "6090", from: null });
    const paid = await expense({ cents: 4510, account: "6140", date: "2026-03-11" });
    await db.inTx((tx) => B.importLines(tx, a, B.parseBankCsv(CSV).lines));
    const rows = await db.q("SELECT * FROM bank_transactions ORDER BY id");
    const s = await db.inTx(async (tx) => Promise.all(rows.map((r) => B.suggest(tx, r, TODAY))));
    expect(s[0][0]).toMatchObject({ action: "invoice", id: inv, score: 92 });
    expect(s[1][0]).toMatchObject({ action: "link", ref: "expense:" + paid });
    expect(s[3][0]).toMatchObject({ action: "bill", id: bill });
  });
});
