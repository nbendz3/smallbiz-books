import { useState, type ReactNode } from "react";
import { addDays, fmt, niceDate } from "../api";
import { AccountSelect, Cpa, ErrorNote, Loading, Money, Tabs, go, useBoot, useLoad } from "../ui";
import { BasisToggle } from "./Dashboard";

type Tab = "pl" | "bs" | "tb" | "schedc" | "aging" | "salestax" | "1099" | "gl";
const TITLES: Record<Tab, string> = { pl: "Profit & Loss", bs: "Balance Sheet", tb: "Trial Balance", schedc: "Schedule C Summary", aging: "Who Owes You", salestax: "Sales Tax", "1099": "1099 Contractors", gl: "General Ledger" };
const AS_OF: Tab[] = ["bs", "tb", "aging"];
const ORDER: Tab[] = ["pl", "bs", "schedc", "aging", "salestax", "1099", "tb", "gl"];

function presets(today: string): [string, string, string][] {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const p = (n: number) => String(n).padStart(2, "0");
  const monthEnd = (yy: number, mm: number) => addDays(mm === 12 ? `${yy + 1}-01-01` : `${yy}-${p(mm + 1)}-01`, -1);
  const lm = m === 1 ? [y - 1, 12] : [y, m - 1];
  const qs = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    ["This month", `${y}-${p(m)}-01`, today], ["Last month", `${lm[0]}-${p(lm[1])}-01`, monthEnd(lm[0], lm[1])], ["This quarter", `${y}-${p(qs)}-01`, today],
    ["Year to date", `${y}-01-01`, today], ["Last year", `${y - 1}-01-01`, `${y - 1}-12-31`],
  ];
}

export function Reports({ parts }: { parts: string[] }) {
  const { boot } = useBoot();
  const tab = (parts[0] && parts[0] in TITLES ? parts[0] : "pl") as Tab;
  const [basis, setBasis] = useState(boot.settings.basis);
  const [from, setFrom] = useState(boot.today.slice(0, 4) + "-01-01");
  const [to, setTo] = useState(boot.today);
  const [year, setYear] = useState(Number(boot.today.slice(0, 4)));
  const [accountId, setAccountId] = useState<number | "">(parts[1] ? Number(parts[1]) : "");
  const tabs = ORDER.filter((t) => t !== "salestax" || boot.settings.sales_tax_on).map((t) => [t, TITLES[t]] as [Tab, string]);
  const query = `basis=${basis}&from=${from}&to=${to}&year=${year}${accountId !== "" && tab === "gl" ? "&accountId=" + accountId : ""}`;
  const { data, error } = useLoad<any>(from && to ? `/reports/${tab}?${query}` : null);
  const usesBasis = !["aging", "salestax", "1099"].includes(tab);
  const drill = (id: number) => { setAccountId(id); go("#/reports/gl/" + id); };

  return (
    <>
      <div className="head"><h1>{TITLES[tab]}</h1>
        <div className="row no-print">{usesBasis && <BasisToggle value={basis} onChange={setBasis} />}
          <a className="btn" href={`/api/reports/${tab}?${query}&format=csv`}>CSV</a><button className="btn" onClick={() => window.print()}>Print / PDF</button></div></div>
      <Tabs value={tab} onChange={(t) => go("#/reports/" + t)} options={tabs} />
      <div className="row no-print" style={{ marginBottom: 14 }}>
        {tab === "1099" ? (
          <select style={{ width: "auto" }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">{[0, 1, 2, 3].map((n) => { const y = Number(boot.today.slice(0, 4)) - n; return <option key={y}>{y}</option>; })}</select>
        ) : (
          <>
            {!AS_OF.includes(tab) && <input type="date" style={{ width: "auto" }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />}
            <input type="date" style={{ width: "auto" }} value={to} onChange={(e) => setTo(e.target.value)} aria-label={AS_OF.includes(tab) ? "As of" : "To"} />
            {!AS_OF.includes(tab) && presets(boot.today).map(([label, f, t]) => <button key={label} className={"btn sm" + (from === f && to === t ? " primary" : "")} onClick={() => { setFrom(f); setTo(t); }}>{label}</button>)}
            {tab === "gl" && <div style={{ minWidth: 220 }}><AccountSelect value={accountId} onChange={setAccountId} filter={() => true} empty="All accounts" /></div>}
          </>
        )}
      </div>
      <p className="muted small">{boot.settings.business_name} · {AS_OF.includes(tab) ? `as of ${niceDate(to)}` : tab === "1099" ? year : `${niceDate(from)} to ${niceDate(to)}`}{usesBasis ? ` · ${basis === "CASH" ? "cash" : "accrual"} basis` : ""}</p>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <Loading /> : (
        <>
          {tab === "pl" && <PL d={data} drill={drill} />}
          {tab === "bs" && <BS d={data} drill={drill} />}
          {tab === "tb" && <TB d={data} drill={drill} />}
          {tab === "schedc" && <SchedC d={data} />}
          {tab === "aging" && <Aging d={data} />}
          {tab === "salestax" && <SalesTax d={data} />}
          {tab === "1099" && <R1099 d={data} />}
          {tab === "gl" && <GL rows={data} />}
        </>
      )}
    </>
  );
}

const Wrap = ({ children }: { children: ReactNode }) => <div className="card flush scroll"><table>{children}</table></div>;
const Section = ({ title, cols = 2 }: { title: string; cols?: number }) => <tr className="section"><td colSpan={cols}>{title}</td></tr>;
const AcctRows = ({ rows, drill }: { rows: any[]; drill: (id: number) => void }) => <>{rows.map((r) => (
  <tr key={r.id} className="click" onClick={() => drill(r.id)} title="See the entries"><td>{r.number} {r.name}</td><td className="num"><Money cents={r.amount} sign /></td></tr>))}</>;
const Total = ({ label, cents, cls = "sub" }: { label: string; cents: number; cls?: string }) => <tr className={cls}><td>{label}</td><td className="num"><Money cents={cents} sign /></td></tr>;

function PL({ d, drill }: { d: any; drill: (id: number) => void }) {
  return (
    <Wrap><tbody>
      <Section title="Income" /><AcctRows rows={d.income} drill={drill} /><Total label="Total income" cents={d.totalIncome} />
      {d.cogs.length > 0 && <><Section title="Cost of goods sold" /><AcctRows rows={d.cogs} drill={drill} /><Total label="Gross profit" cents={d.grossProfit} /></>}
      <Section title="Expenses" /><AcctRows rows={d.expenses} drill={drill} /><Total label="Total expenses" cents={d.totalExpenses} />
      <Total label="Net profit" cents={d.net} cls="total" />
    </tbody></Wrap>
  );
}

function BS({ d, drill }: { d: any; drill: (id: number) => void }) {
  return (
    <>
      <div className={"note " + (d.balanced ? "good" : "bad")}>{d.balanced ? "Assets equal liabilities plus equity." : "Out of balance. This should never happen; export a backup and check the ledger."}</div>
      <Wrap><tbody>
        <Section title="Assets" /><AcctRows rows={d.assets} drill={drill} /><Total label="Total assets" cents={d.totalAssets} />
        <Section title="Liabilities" /><AcctRows rows={d.liabilities} drill={drill} /><Total label="Total liabilities" cents={d.totalLiabilities} />
        <Section title="Equity" /><AcctRows rows={d.equity} drill={drill} />
        <tr><td>Prior years' earnings</td><td className="num"><Money cents={d.priorEarnings} sign /></td></tr>
        <tr><td>Net income, current year</td><td className="num"><Money cents={d.currentYearNet} sign /></td></tr>
        <Total label="Total equity" cents={d.totalEquity} />
        <Total label="Liabilities + equity" cents={d.totalLiabilities + d.totalEquity} cls="total" />
      </tbody></Wrap>
    </>
  );
}

function TB({ d, drill }: { d: any; drill: (id: number) => void }) {
  return (
    <>
      <div className={"note " + (d.balanced ? "good" : "bad")}>{d.balanced ? "Debits equal credits." : "Debits do not equal credits."}</div>
      <Wrap>
        <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {d.rows.map((r: any) => <tr key={r.id} className="click" onClick={() => drill(r.id)}><td>{r.number} {r.name}</td><td className="num">{r.debit ? fmt(r.debit) : ""}</td><td className="num">{r.credit ? fmt(r.credit) : ""}</td></tr>)}
          <tr className="total"><td>Total</td><td className="num">{fmt(d.totalDebit)}</td><td className="num">{fmt(d.totalCredit)}</td></tr>
        </tbody>
      </Wrap>
    </>
  );
}

function SchedC({ d }: { d: any }) {
  const sum = (label: string, cents: number, line = "", cls = "sub") => <tr className={cls}><td>{line}</td><td>{label}</td><td /><td className="num"><Money cents={cents} sign /></td></tr>;
  return (
    <>
      {(d.unsorted.suspense !== 0 || d.unsorted.uncategorized !== 0) && <div className="note warn">Not ready for taxes yet: {d.unsorted.uncategorized ? `${fmt(d.unsorted.uncategorized)} is Uncategorized (6990). ` : ""}{d.unsorted.suspense ? `${fmt(d.unsorted.suspense)} is in Suspense (1900). ` : ""}Give that money a real category first.</div>}
      <Wrap>
        <thead><tr><th>Line</th><th>Description</th><th className="num">In the books</th><th className="num">For the form</th></tr></thead>
        <tbody>
          {d.rows.map((r: any) => <tr key={r.line} title={r.accounts.join(", ")}><td>{r.line}</td><td>{r.label}{r.line === "2" ? " (subtracted)" : ""}</td><td className="num">{fmt(r.ledger)}</td><td className="num">{fmt(r.reportable)}</td></tr>)}
          {d.rows.length === 0 && <tr><td colSpan={4} className="empty">Nothing recorded in this period.</td></tr>}
          {sum("Gross income", d.grossIncome, "7")}{sum("Total expenses", d.totalExpenses, "28")}
          {d.homeOffice !== 0 && sum("Business use of home", d.homeOffice, "30")}{sum("Net profit", d.netProfit, "31", "total")}
        </tbody>
      </Wrap>
      <div className="card">
        <h3>How this ties to your Profit & Loss</h3>
        <table className="mini"><tbody>
          <tr><td>Net profit for the form</td><td className="num">{fmt(d.netProfit)}</td></tr>
          <tr><td>Less: not deductible (for example the other half of meals)</td><td className="num">{fmt(-d.nonDeductible)}</td></tr>
          {d.unassigned !== 0 && <tr><td>Less: not assigned to a line (Uncategorized)</td><td className="num">{fmt(-d.unassigned)}</td></tr>}
          <tr><td><strong>Net profit per the books</strong> {d.ties ? "(matches the P&L)" : "(does NOT match the P&L)"}</td><td className="num"><strong>{fmt(d.bookNet)}</strong></td></tr>
        </tbody></table>
        <Cpa>Estimates for organizing your records. Line numbers follow the current Schedule C and can change. Self-employment tax, your own health insurance and retirement, depreciation choices and the home office calculation are not in here.</Cpa>
      </div>
    </>
  );
}

function Aging({ d }: { d: any }) {
  const B: [string, string][] = [["current", "Not due yet"], ["d30", "1-30 days late"], ["d60", "31-60"], ["d90", "61-90"], ["d90plus", "Over 90"]];
  return (
    <>
      <div className="cards">{B.map(([k, label]) => <div className="stat" key={k}><div className="k">{label}</div><div className="v">{fmt(d.totals[k])}</div></div>)}</div>
      <Wrap>
        <thead><tr><th>Customer</th><th>Invoice</th><th>Due</th><th className="num">Days late</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {d.rows.map((r: any) => <tr key={r.id} className="click" onClick={() => go("#/invoices/" + r.id)}><td>{r.customer_name}</td><td>{r.number}</td><td>{niceDate(r.due_date)}</td><td className="num">{r.days_late > 0 ? r.days_late : ""}</td><td className="num">{fmt(r.balance)}</td></tr>)}
          {d.rows.length === 0 && <tr><td colSpan={5} className="empty">Nobody owes you anything.</td></tr>}
          <tr className="total"><td colSpan={4}>Total owed to you</td><td className="num">{fmt(d.totals.total)}</td></tr>
        </tbody>
      </Wrap>
    </>
  );
}

function SalesTax({ d }: { d: any }) {
  return (
    <>
      <Wrap>
        <thead><tr><th>Rate</th><th className="num">Invoices</th><th className="num">Taxable sales</th><th className="num">Nontaxable sales</th><th className="num">Tax charged</th></tr></thead>
        <tbody>
          {d.rows.map((r: any) => <tr key={r.rate}><td>{r.rate / 1000}%</td><td className="num">{r.invoices}</td><td className="num">{fmt(r.taxable)}</td><td className="num">{fmt(r.nontaxable)}</td><td className="num">{fmt(r.tax)}</td></tr>)}
          {d.rows.length === 0 && <tr><td colSpan={5} className="empty">No invoices issued in this period.</td></tr>}
        </tbody>
      </Wrap>
      <div className="card"><strong>Sales tax you currently owe (account 2060): {fmt(d.liability)}</strong>
        <p className="muted small">By invoice date. When you pay the state, record it under Owner & Transfers, "Paid sales tax to the state".</p>
        <Cpa>Confirm filing basis and rates with your CPA. Rates vary by location and this app does not look them up.</Cpa></div>
    </>
  );
}

function R1099({ d }: { d: any }) {
  const table = (rows: any[], empty: string) => (
    <Wrap>
      <thead><tr><th>Contractor</th><th className="num">Paid by check, ACH or cash</th><th className="num hide-sm">Paid by card (left out)</th><th>W-9</th><th className="hide-sm">Tax ID</th></tr></thead>
      <tbody>
        {rows.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num">{fmt(r.reportable)}</td><td className="num hide-sm">{fmt(r.by_card)}</td><td>{r.has_w9 ? "On file" : <span className="pill warn">Missing</span>}</td><td className="hide-sm">{r.tax_id_last4 ? "..." + r.tax_id_last4 : ""}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={5} className="empty">{empty}</td></tr>}
      </tbody>
    </Wrap>
  );
  return (
    <>
      <h2 style={{ marginBottom: 8 }}>At or over {fmt(d.threshold)}: likely need a 1099-NEC</h2>{table(d.over, "No contractors reached the threshold.")}
      <h2 style={{ margin: "18px 0 8px" }}>Under the threshold</h2>{table(d.under, "None.")}
      <Cpa>Only vendors marked as 1099 contractors are listed. Card payments are left out because the card processor reports them. The threshold is a setting (it is $2,000 for payments made in 2026). Forms are generally due January 31. Confirm filing rules with your CPA.</Cpa>
    </>
  );
}

function GL({ rows }: { rows: any[] }) {
  let d = 0, c = 0;
  for (const r of rows) { d += r.debit_cents; c += r.credit_cents; }
  return (
    <Wrap>
      <thead><tr><th>Date</th><th>Memo</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i}><td>{niceDate(r.entry_date)}</td><td>{r.memo}{r.book !== "BOTH" ? <span className="muted small"> ({r.book.toLowerCase()} book)</span> : null}</td><td>{r.number} {r.name}</td><td className="num">{r.debit_cents ? fmt(r.debit_cents) : ""}</td><td className="num">{r.credit_cents ? fmt(r.credit_cents) : ""}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={5} className="empty">No entries in this period.</td></tr>}
        <tr className="total"><td colSpan={3}>Total</td><td className="num">{fmt(d)}</td><td className="num">{fmt(c)}</td></tr>
      </tbody>
    </Wrap>
  );
}
