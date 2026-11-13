// CSV versions of every report, the accountant package ZIP, and the full backup ZIP.
import { zipSync, strToU8 } from "fflate";
import type { Tx } from "./db.js";
import { csvMoney } from "./money.js";
import * as R from "./reports.js";

type Cell = string | number | boolean | null | undefined;
export function toCsv(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s; // stop spreadsheet formula tricks
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
const m = csvMoney;

/** One report as CSV rows. Used by the Reports screen downloads and by the accountant package. */
export async function reportRows(tx: Tx, name: string, p: { basis: R.Basis; from: string; to: string; year: number; accountId?: number }): Promise<Cell[][]> {
  switch (name) {
    case "pl": {
      const r = await R.profitAndLoss(tx, p.basis, p.from, p.to);
      const sec = (title: string, rows: any[], total: number) => [[title], ...rows.map((x) => [x.number, x.name, m(x.amount)]), ["", "Total " + title, m(total)], []];
      return [[`Profit and Loss (${p.basis})`, `${p.from} to ${p.to}`], [], ...sec("Income", r.income, r.totalIncome), ...sec("Cost of goods sold", r.cogs, r.totalCogs),
        ["", "Gross profit", m(r.grossProfit)], [], ...sec("Expenses", r.expenses, r.totalExpenses), ["", "Net profit", m(r.net)]];
    }
    case "tb": {
      const r = await R.trialBalance(tx, p.basis, p.to);
      return [[`Trial Balance (${p.basis})`, `as of ${p.to}`], ["Account", "Name", "Debit", "Credit"], ...r.rows.map((x) => [x.number, x.name, m(x.debit), m(x.credit)]), ["", "Total", m(r.totalDebit), m(r.totalCredit)]];
    }
    case "bs": {
      const r = await R.balanceSheet(tx, p.basis, p.to);
      const sec = (title: string, rows: any[]) => [[title], ...rows.map((x) => [x.number, x.name, m(x.amount)])];
      return [[`Balance Sheet (${p.basis})`, `as of ${p.to}`], [], ...sec("Assets", r.assets), ["", "Total assets", m(r.totalAssets)], [], ...sec("Liabilities", r.liabilities), ["", "Total liabilities", m(r.totalLiabilities)], [],
        ...sec("Equity", r.equity), ["", "Prior years' earnings", m(r.priorEarnings)], ["", "Net income, current year", m(r.currentYearNet)], ["", "Total equity", m(r.totalEquity)], [], ["", "Liabilities + equity", m(r.totalLiabilities + r.totalEquity)]];
    }
    case "schedc": {
      const r = await R.scheduleC(tx, p.basis, p.from, p.to);
      return [[`Schedule C Summary (${p.basis})`, `${p.from} to ${p.to}`], ["Line", "Description", "Ledger amount", "Reportable amount", "Accounts"],
        ...r.rows.map((x) => [x.line, x.label, m(x.ledger), m(x.reportable), x.accounts.join("; ")]), [],
        ["7", "Gross income", "", m(r.grossIncome)], ["28", "Total expenses", "", m(r.totalExpenses)], ["30", "Business use of home", "", m(r.homeOffice)], ["31", "Net profit", "", m(r.netProfit)], [],
        ["", "Not deductible (for example half of meals)", "", m(r.nonDeductible)], ["", "Not assigned to a line (Uncategorized)", "", m(r.unassigned)], ["", "Net profit per books", "", m(r.bookNet)], [],
        ["Estimates for organizing your records. Confirm with your CPA."]];
    }
    case "aging": {
      const r = await R.arAging(tx, p.to);
      return [["AR Aging", `as of ${p.to}`], ["Customer", "Invoice", "Due", "Days late", "Balance", "Bucket"], ...r.rows.map((x: any) => [x.customer_name, x.number, x.due_date, x.days_late, m(x.balance), x.bucket]), ["", "", "", "Total", m(r.totals.total)]];
    }
    case "salestax": {
      const r = await R.salesTax(tx, p.from, p.to);
      return [["Sales Tax", `${p.from} to ${p.to}`], ["Rate %", "Invoices", "Taxable sales", "Nontaxable sales", "Tax"], ...r.rows.map((x: any) => [x.rate / 1000, x.invoices, m(x.taxable), m(x.nontaxable), m(x.tax)]), [],
        ["Sales tax payable (2060) balance today", m(r.liability)], ["Confirm filing basis and rates with your CPA."]];
    }
    case "1099": {
      const r = await R.report1099(tx, p.year);
      const row = (x: any, over: boolean) => [x.name, m(x.reportable), m(x.by_card), x.has_w9 ? "yes" : "NO", x.tax_id_last4, over ? "at or over threshold" : "under threshold"];
      return [[`1099 contractors ${p.year}`, `threshold ${m(r.threshold)}`], ["Vendor", "Paid by check/ACH/cash", "Paid by card (excluded)", "W-9 on file", "Tax ID last 4", "Status"],
        ...r.over.map((x) => row(x, true)), ...r.under.map((x) => row(x, false)), [], ["Card payments are excluded because the card processor reports them. Confirm filing rules with your CPA."]];
    }
    case "gl": {
      const r = await R.generalLedger(tx, p.basis, p.from, p.to, p.accountId);
      return [["Date", "Entry", "Memo", "Book", "Account", "Name", "Debit", "Credit", "Source", "Source id"],
        ...r.map((x: any) => [x.entry_date, x.entry_id, x.memo, x.book, x.number, x.name, m(x.debit_cents), m(x.credit_cents), x.source_type, x.source_id])];
    }
    case "mileage": {
      const r = await tx.q("SELECT * FROM mileage_trips WHERE NOT voided AND trip_date BETWEEN $1::date AND $2::date ORDER BY trip_date, id", [p.from, p.to]);
      return [["Date", "Miles", "From", "To", "Purpose", "Odometer", "Rate (cents)", "Deduction"], ...r.map((x) => [x.trip_date, (x.miles_x10 / 10).toFixed(1), x.from_place, x.to_place, x.purpose, x.odometer, x.rate_tenth_cents / 10, m(x.deduction_cents)])];
    }
    default:
      throw new Error("Unknown report " + name);
  }
}

async function tableCsv(tx: Tx, sql: string, params: any[] = []): Promise<string> {
  const rows = await tx.q(sql, params);
  if (!rows.length) return "(no rows)\r\n";
  const cols = Object.keys(rows[0]);
  return toCsv([cols, ...rows.map((r) => cols.map((c) => (r[c] instanceof Date ? r[c].toISOString() : r[c])))]);
}

const slug = (s: string) => (s || "receipt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "receipt";
const ext = (mime: string, name: string) => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? (mime === "application/pdf" ? "pdf" : mime.split("/")[1] ?? "bin")).toLowerCase();

/** Accountant package for one year, or (full = true) a backup of every table plus every receipt. */
export async function buildZip(tx: Tx, year: number, full: boolean): Promise<Uint8Array> {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, text: string) => { files[name] = strToU8(text); };
  const rep = async (file: string, name: string, basis: R.Basis) => add(file, toCsv(await reportRows(tx, name, { basis, from, to, year })));
  const basis = (await tx.q("SELECT basis FROM settings WHERE id = 1"))[0].basis as R.Basis;

  if (!full) {
    await rep("profit_and_loss_cash.csv", "pl", "CASH");
    await rep("profit_and_loss_accrual.csv", "pl", "ACCRUAL");
    await rep("balance_sheet.csv", "bs", basis);
    await rep("trial_balance.csv", "tb", basis);
    await rep("general_ledger_cash.csv", "gl", "CASH");
    await rep("general_ledger_accrual.csv", "gl", "ACCRUAL");
    await rep("schedule_c_summary.csv", "schedc", basis);
    await rep("sales_tax.csv", "salestax", basis);
    await rep("1099.csv", "1099", basis);
    await rep("mileage_log.csv", "mileage", basis);
    await rep("ar_aging.csv", "aging", basis);
    add("invoices.csv", await tableCsv(tx, `SELECT i.number, c.name AS customer, i.status, i.issue_date, i.due_date, i.subtotal_cents, i.tax_cents, i.total_cents FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.issue_date BETWEEN $1::date AND $2::date ORDER BY i.id`, [from, to]));
    add("payments.csv", await tableCsv(tx, `SELECT p.id, c.name AS customer, p.pay_date, p.amount_cents, p.method, p.reference, p.voided FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.pay_date BETWEEN $1::date AND $2::date ORDER BY p.id`, [from, to]));
    add("expenses.csv", await tableCsv(tx,
      `SELECT x.id, x.exp_date, v.name AS vendor, x.description, x.purpose, a.number AS account, a.name AS category, l.amount_cents, x.business_pct, pf.name AS paid_from, x.paid_date, x.pay_method, x.voided
         FROM expenses x JOIN expense_lines l ON l.expense_id = x.id JOIN accounts a ON a.id = l.account_id LEFT JOIN vendors v ON v.id = x.vendor_id LEFT JOIN accounts pf ON pf.id = x.paid_from_account_id
        WHERE x.exp_date BETWEEN $1::date AND $2::date ORDER BY x.exp_date, x.id`, [from, to]));
    add("bank_transactions.csv", await tableCsv(tx, `SELECT b.txn_date, a.name AS account, b.description, b.amount_cents, b.status, b.resolution FROM bank_transactions b JOIN accounts a ON a.id = b.account_id WHERE b.txn_date BETWEEN $1::date AND $2::date ORDER BY b.txn_date, b.id`, [from, to]));
    add("chart_of_accounts.csv", await tableCsv(tx, "SELECT number, name, type, sched_c_line, deductible_pct, active FROM accounts ORDER BY number"));
    add("README.txt", [
      `Accountant package for ${year}. Prepared for review by a tax professional.`, "",
      "profit_and_loss_cash.csv / _accrual.csv   Income and expenses for the year on each basis",
      "balance_sheet.csv, trial_balance.csv      As of December 31, on the basis chosen in Settings (" + basis + ")",
      "general_ledger_*.csv                      Every ledger line for the year",
      "schedule_c_summary.csv                    Totals by Schedule C line (meals at the deductible percent)",
      "sales_tax.csv, 1099.csv, mileage_log.csv  Year-end support",
      "ar_aging.csv                              Unpaid invoices at year end",
      "invoices, payments, expenses, bank_transactions, chart_of_accounts   Source lists. Columns ending in _cents are cents.",
      "receipts/                                 Receipt files by month: date_vendor_amount", "",
      "These are estimates for organizing records, not tax advice.",
    ].join("\r\n"));
  } else {
    for (const t of ["settings", "accounts", "customers", "vendors", "invoices", "invoice_lines", "payments", "payment_applications", "expenses", "expense_lines",
      "bank_transactions", "mileage_rates", "mileage_trips", "money_moves", "journal_entries", "journal_lines", "audit_log"]) {
      add(`tables/${t}.csv`, await tableCsv(tx, `SELECT * FROM ${t} ORDER BY 1`));
    }
    add("tables/receipts.csv", await tableCsv(tx, "SELECT id, filename, mime, size_bytes, sha256, uploaded_at FROM receipts ORDER BY id"));
    add("README.txt", "Full backup: every table as CSV plus every receipt file. Columns ending in _cents are cents. Keep this somewhere safe outside Replit.\r\n");
  }

  const receipts = await tx.q(
    `SELECT r.id, r.filename, r.mime, r.data, x.exp_date, x.total_cents, v.name AS vendor FROM receipts r
       LEFT JOIN expenses x ON x.receipt_id = r.id AND NOT x.voided LEFT JOIN vendors v ON v.id = x.vendor_id
      WHERE $1::boolean OR x.exp_date BETWEEN $2::date AND $3::date ORDER BY r.id`, [full, from, to]);
  for (const r of receipts) {
    const date = r.exp_date ?? "unfiled";
    const name = r.exp_date ? `${r.exp_date}_${slug(r.vendor)}_${m(r.total_cents)}_${r.id}.${ext(r.mime, r.filename)}` : `${r.id}_${slug(r.filename)}.${ext(r.mime, r.filename)}`;
    files[`receipts/${String(date).slice(0, 7)}/${name}`] = new Uint8Array(r.data);
  }
  return zipSync(files, { level: 6 });
}
