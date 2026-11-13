// Reports. Every number here is read from the ledger (journal_entries + journal_lines),
// except the invoice sub-ledger views (AR aging, sales tax by invoice) which tests prove tie to it.
import type { Tx } from "./db.js";
import { pctOf } from "./money.js";
import { SCHED_C_LABELS, SCHED_C_ORDER } from "./seed.js";

export type Basis = "CASH" | "ACCRUAL";

interface Bal { id: number; number: string; name: string; type: string; sched_c_line: string | null; deductible_pct: number; debit: number; credit: number }

/** Debit and credit totals per account for one book, between two dates (either end optional). */
export async function balances(tx: Tx, basis: Basis, from: string | null, to: string | null): Promise<Bal[]> {
  return tx.q<Bal>(
    `SELECT a.id, a.number, a.name, a.type, a.sched_c_line, a.deductible_pct,
            COALESCE(SUM(l.debit_cents),0)::bigint AS debit, COALESCE(SUM(l.credit_cents),0)::bigint AS credit
       FROM accounts a
       LEFT JOIN (journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                  AND e.book IN ($1,'BOTH')
                  AND ($2::date IS NULL OR e.entry_date >= $2::date)
                  AND ($3::date IS NULL OR e.entry_date <= $3::date)) ON l.account_id = a.id
      GROUP BY a.id ORDER BY a.number`, [basis, from, to]);
}

const isPL = (t: string) => t === "income" || t === "cogs" || t === "expense";
/** Natural-sign amount: income and liabilities/equity are credit-normal, the rest debit-normal. */
const natural = (b: Bal) => (b.type === "income" || b.type === "liability" || b.type === "equity" ? b.credit - b.debit : b.debit - b.credit);

export async function trialBalance(tx: Tx, basis: Basis, asOf: string) {
  const rows = (await balances(tx, basis, null, asOf))
    .map((b) => {
      const net = b.debit - b.credit;
      return { id: b.id, number: b.number, name: b.name, type: b.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debit || r.credit);
  const totalDebit = rows.reduce((a, r) => a + r.debit, 0), totalCredit = rows.reduce((a, r) => a + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export async function profitAndLoss(tx: Tx, basis: Basis, from: string, to: string) {
  const all = (await balances(tx, basis, from, to)).filter((b) => isPL(b.type)).map((b) => ({ id: b.id, number: b.number, name: b.name, type: b.type, amount: natural(b) })).filter((r) => r.amount !== 0);
  const group = (t: string) => all.filter((r) => r.type === t);
  const sum = (rs: { amount: number }[]) => rs.reduce((a, r) => a + r.amount, 0);
  const income = group("income"), cogs = group("cogs"), expenses = group("expense");
  const totalIncome = sum(income), totalCogs = sum(cogs), totalExpenses = sum(expenses);
  return { income, cogs, expenses, totalIncome, totalCogs, grossProfit: totalIncome - totalCogs, totalExpenses, net: totalIncome - totalCogs - totalExpenses };
}

export async function balanceSheet(tx: Tx, basis: Basis, asOf: string) {
  const all = await balances(tx, basis, null, asOf);
  const yearStart = asOf.slice(0, 4) + "-01-01";
  const section = (t: string) => all.filter((b) => b.type === t).map((b) => ({ id: b.id, number: b.number, name: b.name, amount: natural(b) })).filter((r) => r.amount !== 0);
  const sum = (rs: { amount: number }[]) => rs.reduce((a, r) => a + r.amount, 0);
  const assets = section("asset"), liabilities = section("liability"), equity = section("equity");
  // No closing entries are posted. Profit to date is computed and shown as two equity lines.
  const allTimeNet = all.filter((b) => isPL(b.type)).reduce((a, b) => a + (b.credit - b.debit), 0);
  const currentYearNet = (await profitAndLoss(tx, basis, yearStart, asOf)).net;
  const priorEarnings = allTimeNet - currentYearNet;
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + currentYearNet + priorEarnings;
  return { assets, liabilities, equity, currentYearNet, priorEarnings, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

/** Schedule C summary: ledger amounts grouped by form line, with the deductible percent applied (meals 50). */
export async function scheduleC(tx: Tx, basis: Basis, from: string, to: string) {
  const all = (await balances(tx, basis, from, to)).filter((b) => isPL(b.type));
  const lines = new Map<string, { line: string; label: string; ledger: number; reportable: number; accounts: string[] }>();
  let unassigned = 0;
  for (const b of all) {
    const amt = natural(b);
    if (amt === 0) continue;
    if (!b.sched_c_line) { unassigned += b.type === "income" ? -amt : amt; continue; }
    const row = lines.get(b.sched_c_line) ?? { line: b.sched_c_line, label: SCHED_C_LABELS[b.sched_c_line] ?? "Other", ledger: 0, reportable: 0, accounts: [] };
    row.ledger += amt;
    row.reportable += amt >= 0 ? pctOf(amt, b.deductible_pct) : -pctOf(-amt, b.deductible_pct);
    row.accounts.push(`${b.number} ${b.name}`);
    lines.set(b.sched_c_line, row);
  }
  const rows = [...lines.values()].sort((a, b) => SCHED_C_ORDER.indexOf(a.line) - SCHED_C_ORDER.indexOf(b.line));
  const get = (l: string) => lines.get(l)?.reportable ?? 0;
  const grossReceipts = get("1");
  const returns = -get("2"); // 4090 carries a debit balance; shown as a positive number that is subtracted
  const cogs = get("4"), otherIncome = get("6");
  const grossIncome = grossReceipts - returns - cogs + otherIncome;
  const expenseRows = rows.filter((r) => !["1", "2", "4", "6", "30"].includes(r.line));
  const totalExpenses = expenseRows.reduce((a, r) => a + r.reportable, 0);
  const homeOffice = get("30");
  const netProfit = grossIncome - totalExpenses - homeOffice;
  const nonDeductible = rows.reduce((a, r) => a + (r.ledger - r.reportable), 0);
  const pl = await profitAndLoss(tx, basis, from, to);
  return {
    rows: rows.map((r) => (r.line === "2" ? { ...r, ledger: -r.ledger, reportable: -r.reportable } : r)),
    grossReceipts, returns, cogs, otherIncome, grossIncome, totalExpenses, homeOffice, netProfit,
    nonDeductible, unassigned, bookNet: pl.net,
    ties: netProfit - nonDeductible - unassigned === pl.net,
    unsorted: await unsorted(tx, basis, to),
  };
}

/** Money parked in Suspense (1900) or Uncategorized (6990). Should be zero before tax reports. */
export async function unsorted(tx: Tx, basis: Basis, asOf: string | null) {
  const b = (await balances(tx, basis, null, asOf)).filter((x) => x.number === "1900" || x.number === "6990");
  const of = (n: string) => { const x = b.find((y) => y.number === n); return x ? x.debit - x.credit : 0; };
  return { suspense: of("1900"), uncategorized: of("6990") };
}

export async function generalLedger(tx: Tx, basis: Basis, from: string, to: string, accountId?: number) {
  return tx.q(
    `SELECT e.id AS entry_id, e.entry_date, e.memo, e.book, e.source_type, e.source_id, a.number, a.name, l.debit_cents, l.credit_cents
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.book IN ($1,'BOTH') AND e.entry_date BETWEEN $2::date AND $3::date AND ($4::int IS NULL OR l.account_id = $4::int)
      ORDER BY e.entry_date, e.id, l.id`, [basis, from, to, accountId ?? null]);
}

/** SQL for the derived invoice status. $1 must be today's date. */
export const INVOICE_LIST_SQL = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email, p.paid AS paid_cents, i.total_cents - p.paid AS balance_cents,
         CASE WHEN i.status = 'void' THEN 'Void'
              WHEN i.status = 'draft' THEN 'Draft'
              WHEN p.paid >= i.total_cents THEN 'Paid'
              WHEN i.due_date < $1::date THEN 'Overdue'
              WHEN p.paid > 0 THEN 'Partially paid'
              ELSE 'Sent' END AS display_status
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    CROSS JOIN LATERAL (SELECT COALESCE(SUM(pa.amount_cents),0)::bigint AS paid FROM payment_applications pa
                          JOIN payments pm ON pm.id = pa.payment_id AND NOT pm.voided WHERE pa.invoice_id = i.id) p`;

export async function arAging(tx: Tx, asOf: string) {
  const rows = await tx.q(
    `SELECT i.id, i.number, i.due_date, i.issue_date, c.name AS customer_name, i.total_cents - p.paid AS balance, ($1::date - i.due_date) AS days_late
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       CROSS JOIN LATERAL (SELECT COALESCE(SUM(pa.amount_cents),0)::bigint AS paid FROM payment_applications pa
                             JOIN payments pm ON pm.id = pa.payment_id AND NOT pm.voided AND pm.pay_date <= $1::date WHERE pa.invoice_id = i.id) p
      WHERE i.status = 'sent' AND i.issue_date <= $1::date AND i.total_cents - p.paid > 0
      ORDER BY c.name, i.due_date`, [asOf]);
  const bucket = (d: number) => (d <= 0 ? "current" : d <= 30 ? "d30" : d <= 60 ? "d60" : d <= 90 ? "d90" : "d90plus");
  const totals: Record<string, number> = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 };
  const out = rows.map((r) => {
    const b = bucket(Number(r.days_late));
    totals[b] += r.balance; totals.total += r.balance;
    return { ...r, days_late: Number(r.days_late), bucket: b };
  });
  return { rows: out, totals };
}

export async function salesTax(tx: Tx, from: string, to: string) {
  const rows = await tx.q(
    `SELECT i.tax_rate_x1000 AS rate, COUNT(DISTINCT i.id)::int AS invoices,
            COALESCE(SUM(CASE WHEN l.taxable THEN l.amount_cents ELSE 0 END),0)::bigint AS taxable,
            COALESCE(SUM(CASE WHEN l.taxable THEN 0 ELSE l.amount_cents END),0)::bigint AS nontaxable
       FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE i.status = 'sent' AND i.issue_date BETWEEN $1::date AND $2::date
      GROUP BY i.tax_rate_x1000 ORDER BY 1`, [from, to]);
  const tax = await tx.q(`SELECT tax_rate_x1000 AS rate, COALESCE(SUM(tax_cents),0)::bigint AS tax FROM invoices
                           WHERE status = 'sent' AND issue_date BETWEEN $1::date AND $2::date GROUP BY 1`, [from, to]);
  const owed = (await balances(tx, "ACCRUAL", null, null)).find((b) => b.number === "2060");
  return {
    rows: rows.map((r) => ({ ...r, tax: tax.find((t) => t.rate === r.rate)?.tax ?? 0 })),
    liability: owed ? owed.credit - owed.debit : 0,
  };
}

/** 1099 list: paid by check, ACH, cash or other. Card payments are left out (the processor reports them). */
export async function report1099(tx: Tx, year: number) {
  const threshold = (await tx.q("SELECT threshold_1099_cents FROM settings WHERE id = 1"))[0].threshold_1099_cents as number;
  const rows = await tx.q(
    `SELECT v.id, v.name, v.has_w9, v.tax_id_last4,
            COALESCE(SUM(CASE WHEN x.pay_method NOT IN ('credit_card','debit_card') THEN x.total_cents ELSE 0 END),0)::bigint AS reportable,
            COALESCE(SUM(CASE WHEN x.pay_method IN ('credit_card','debit_card') THEN x.total_cents ELSE 0 END),0)::bigint AS by_card
       FROM vendors v
       LEFT JOIN expenses x ON x.vendor_id = v.id AND NOT x.voided AND x.paid_date IS NOT NULL
                           AND x.paid_date BETWEEN $1::date AND $2::date
      WHERE v.is_1099 GROUP BY v.id ORDER BY v.name`, [`${year}-01-01`, `${year}-12-31`]);
  return { threshold, over: rows.filter((r) => r.reportable >= threshold), under: rows.filter((r) => r.reportable < threshold) };
}

export async function dashboard(tx: Tx, basis: Basis, today: string) {
  const ym = today.slice(0, 7), year = today.slice(0, 4);
  const month = await profitAndLoss(tx, basis, ym + "-01", today);
  const ytd = await profitAndLoss(tx, basis, year + "-01-01", today);
  const inv = (await tx.q(
    `SELECT COALESCE(SUM(balance_cents),0)::bigint AS unpaid, COUNT(*)::int AS unpaid_count,
            COALESCE(SUM(CASE WHEN display_status = 'Overdue' THEN balance_cents ELSE 0 END),0)::bigint AS overdue,
            COUNT(*) FILTER (WHERE display_status = 'Overdue')::int AS overdue_count
       FROM (${INVOICE_LIST_SQL}) x WHERE status = 'sent' AND balance_cents > 0`, [today]))[0];
  const one = async (sql: string, p: any[] = []) => (await tx.q(sql, p))[0];
  const receipts = (await one("SELECT COUNT(*)::int AS n FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM expenses x WHERE x.receipt_id = r.id AND NOT x.voided)")).n;
  const bankNew = (await one("SELECT COUNT(*)::int AS n FROM bank_transactions WHERE status = 'new'")).n;
  const bills = await one("SELECT COALESCE(SUM(total_cents),0)::bigint AS total, COUNT(*)::int AS n FROM expenses WHERE NOT voided AND paid_from_account_id IS NULL");
  const s = await one("SELECT tax_set_aside_pct, last_export_at, locked_through FROM settings WHERE id = 1");
  const chart = await tx.q(
    `SELECT to_char(e.entry_date, 'YYYY-MM') AS ym,
            COALESCE(SUM(CASE WHEN a.type = 'income' THEN l.credit_cents - l.debit_cents ELSE 0 END),0)::bigint AS money_in,
            COALESCE(SUM(CASE WHEN a.type IN ('cogs','expense') THEN l.debit_cents - l.credit_cents ELSE 0 END),0)::bigint AS money_out
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.book IN ($1,'BOTH') AND e.entry_date > ($2::date - interval '12 months') AND e.entry_date <= $2::date
      GROUP BY 1 ORDER BY 1`, [basis, today]);
  const cashAccts = (await balances(tx, basis, null, today)).filter((b) => ["1010", "1020", "1050", "1170", "2100"].includes(b.number) && (b.debit || b.credit))
    .map((b) => ({ number: b.number, name: b.name, type: b.type, amount: natural(b) }));
  return {
    month: { in: month.totalIncome, out: month.totalCogs + month.totalExpenses, net: month.net },
    ytd: { in: ytd.totalIncome, out: ytd.totalCogs + ytd.totalExpenses, net: ytd.net },
    invoices: inv, receiptsWaiting: receipts, bankUnsorted: bankNew, bills,
    setAsidePct: s.tax_set_aside_pct, setAside: ytd.net > 0 ? pctOf(ytd.net, s.tax_set_aside_pct) : 0,
    lastExportAt: s.last_export_at, lockedThrough: s.locked_through,
    unsorted: await unsorted(tx, basis, today), chart, accounts: cashAccts,
  };
}

export async function yearEndChecklist(tx: Tx, year: number, today: string) {
  const one = async (sql: string, p: any[] = []) => (await tx.q(sql, p))[0];
  const end = `${year}-12-31`;
  const u = await unsorted(tx, "CASH", end);
  const s = await one("SELECT locked_through FROM settings WHERE id = 1");
  return [
    { label: "Bank inbox is empty", ok: (await one("SELECT COUNT(*)::int AS n FROM bank_transactions WHERE status = 'new' AND txn_date <= $1", [end])).n === 0 },
    { label: "Suspense (1900) and Uncategorized (6990) are zero", ok: u.suspense === 0 && u.uncategorized === 0 },
    { label: "Receipt inbox is empty", ok: (await one("SELECT COUNT(*)::int AS n FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM expenses x WHERE x.receipt_id = r.id AND NOT x.voided)")).n === 0 },
    { label: "Every 1099 vendor has a W-9 on file", ok: (await one("SELECT COUNT(*)::int AS n FROM vendors WHERE is_1099 AND NOT has_w9 AND NOT archived")).n === 0 },
    { label: "No invoices unpaid for more than 90 days", ok: (await arAging(tx, today)).totals.d90plus === 0 },
    { label: "No unpaid bills left from the year", ok: (await one("SELECT COUNT(*)::int AS n FROM expenses WHERE NOT voided AND paid_from_account_id IS NULL AND exp_date <= $1", [end])).n === 0 },
    { label: `Books locked through December 31, ${year}`, ok: !!s.locked_through && s.locked_through >= end },
  ];
}
