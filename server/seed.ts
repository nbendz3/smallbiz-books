// Starter data: chart of accounts (with Schedule C lines), mileage rates and the settings row.
// Runs at every start and only adds what is missing.
import type { Tx } from "./db.js";

type A = [number: string, name: string, type: string, line: string | null, opts?: { pct?: number; purpose?: boolean; pay?: boolean; sys?: boolean }];

export const CHART: A[] = [
  ["1010", "Business Checking", "asset", null, { pay: true, sys: true }],
  ["1020", "Business Savings", "asset", null, { pay: true }],
  ["1050", "Cash on Hand", "asset", null, { pay: true }],
  ["1080", "Accounts Receivable", "asset", null, { sys: true }],
  ["1170", "Stripe Clearing", "asset", null, { pay: true }],
  ["1200", "Inventory", "asset", null],
  ["1300", "Prepaid Expenses", "asset", null],
  ["1500", "Equipment", "asset", null],
  ["1700", "Accumulated Depreciation", "asset", null],
  ["1900", "Suspense Clearing", "asset", null, { sys: true }],
  ["2000", "Accounts Payable", "liability", null, { sys: true }],
  ["2060", "Sales Tax Payable", "liability", null, { sys: true }],
  ["2100", "Business Credit Card", "liability", null, { pay: true, sys: true }],
  ["2200", "Customer Deposits", "liability", null, { sys: true }],
  ["2500", "Loans Payable", "liability", null],
  ["3000", "Opening Balance Equity", "equity", null, { sys: true }],
  ["3050", "Owner Contributions", "equity", null, { sys: true }],
  ["3070", "Owner Draws", "equity", null, { sys: true }],
  ["3400", "Retained Earnings", "equity", null],
  ["4000", "Service Revenue", "income", "1", { sys: true }],
  ["4010", "Product Sales", "income", "1"],
  ["4090", "Returns and Allowances", "income", "2"],
  ["4100", "Other Income", "income", "6"],
  ["4200", "Interest Income", "income", "6"],
  ["5000", "Cost of Goods Sold - Materials", "cogs", "4"],
  ["5100", "Cost of Goods Sold - Labor and Other", "cogs", "4"],
  ["6010", "Advertising", "expense", "8"],
  ["6020", "Car and Truck (Mileage)", "expense", "9", { sys: true }],
  ["6030", "Commissions and Fees", "expense", "10"],
  ["6031", "Merchant Processing Fees", "expense", "10"],
  ["6040", "Contract Labor", "expense", "11"],
  ["6050", "Depreciation", "expense", "13"],
  ["6060", "Employee Benefits", "expense", "14"],
  ["6070", "Insurance (not health)", "expense", "15"],
  ["6080", "Mortgage Interest", "expense", "16a"],
  ["6081", "Interest - Other", "expense", "16b"],
  ["6090", "Legal and Professional", "expense", "17"],
  ["6100", "Office Expense", "expense", "18"],
  ["6240", "Postage and Shipping", "expense", "18"],
  ["6110", "Retirement Plans (employees)", "expense", "19"],
  ["6120", "Rent - Vehicles and Equipment", "expense", "20a"],
  ["6125", "Rent - Business Property", "expense", "20b"],
  ["6130", "Repairs and Maintenance", "expense", "21"],
  ["6140", "Supplies", "expense", "22"],
  ["6150", "Taxes and Licenses", "expense", "23"],
  ["6160", "Travel", "expense", "24a", { purpose: true }],
  ["6170", "Meals", "expense", "24b", { pct: 50, purpose: true }],
  ["6180", "Utilities", "expense", "25"],
  ["6185", "Phone and Internet", "expense", "25"],
  ["6190", "Wages", "expense", "26"],
  ["6200", "Software and Subscriptions", "expense", "27a"],
  ["6210", "Bank Fees", "expense", "27a"],
  ["6220", "Education and Training", "expense", "27a"],
  ["6230", "Dues and Memberships", "expense", "27a"],
  ["6950", "Bad Debt", "expense", "27a"],
  ["6300", "Home Office", "expense", "30"],
  ["6990", "Uncategorized Expense", "expense", null, { sys: true }],
];

export const SCHED_C_LABELS: Record<string, string> = {
  "1": "Gross receipts or sales",
  "2": "Returns and allowances",
  "4": "Cost of goods sold",
  "6": "Other income",
  "8": "Advertising",
  "9": "Car and truck expenses",
  "10": "Commissions and fees",
  "11": "Contract labor",
  "13": "Depreciation",
  "14": "Employee benefit programs",
  "15": "Insurance (other than health)",
  "16a": "Interest - mortgage",
  "16b": "Interest - other",
  "17": "Legal and professional services",
  "18": "Office expense",
  "19": "Pension and profit-sharing plans",
  "20a": "Rent - vehicles, machinery, equipment",
  "20b": "Rent - other business property",
  "21": "Repairs and maintenance",
  "22": "Supplies",
  "23": "Taxes and licenses",
  "24a": "Travel",
  "24b": "Deductible meals",
  "25": "Utilities",
  "26": "Wages",
  "27a": "Other expenses",
  "30": "Business use of home",
};
export const SCHED_C_ORDER = Object.keys(SCHED_C_LABELS);

// IRS business standard mileage rates, in tenths of a cent. Check irs.gov each year.
export const MILEAGE_RATES: [string, number][] = [
  ["2024-01-01", 670],
  ["2025-01-01", 700],
  ["2026-01-01", 725],
  ["2026-07-01", 760],
];

export async function seed(tx: Tx): Promise<void> {
  await tx.q("INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  for (const [number, name, type, line, o] of CHART) {
    await tx.q(
      `INSERT INTO accounts (number, name, type, sched_c_line, deductible_pct, requires_purpose, pay_from, system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (number) DO NOTHING`,
      [number, name, type, line, o?.pct ?? 100, !!o?.purpose, !!o?.pay, !!o?.sys],
    );
  }
  for (const [d, r] of MILEAGE_RATES) {
    await tx.q("INSERT INTO mileage_rates (effective_date, rate_tenth_cents) VALUES ($1,$2) ON CONFLICT (effective_date) DO NOTHING", [d, r]);
  }
}
