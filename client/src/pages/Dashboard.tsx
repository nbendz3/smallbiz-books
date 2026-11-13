import { useState } from "react";
import { fmt, niceDate } from "../api";
import { Cpa, ErrorNote, Loading, Money, useBoot, useLoad } from "../ui";

// Federal estimated tax due dates. Weekends and holidays move them to the next business day.
function nextEstimates(today: string) {
  const y = Number(today.slice(0, 4));
  return [`${y}-01-15`, `${y}-04-15`, `${y}-06-15`, `${y}-09-15`, `${y + 1}-01-15`].filter((d) => d >= today).slice(0, 2);
}

export function BasisToggle({ value, onChange }: { value: string; onChange: (b: "CASH" | "ACCRUAL") => void }) {
  return (
    <div className="seg no-print" role="group" aria-label="Cash or accrual">
      <button className={value === "CASH" ? "on" : ""} onClick={() => onChange("CASH")}>Cash</button>
      <button className={value === "ACCRUAL" ? "on" : ""} onClick={() => onChange("ACCRUAL")}>Accrual</button>
    </div>
  );
}

export function Dashboard() {
  const { boot } = useBoot();
  const [basis, setBasis] = useState(boot.settings.basis);
  const { data: d, error } = useLoad<any>(`/dashboard?basis=${basis}`);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!d) return <Loading />;

  const max = Math.max(1, ...d.chart.map((m: any) => Math.max(m.money_in, m.money_out)));
  const daysSinceExport = d.lastExportAt ? Math.floor((Date.now() - Date.parse(d.lastExportAt)) / 86400000) : null;
  const todo: [string, string, string][] = [];
  if (d.invoices.overdue_count) todo.push([`${d.invoices.overdue_count} overdue invoice${d.invoices.overdue_count > 1 ? "s" : ""}`, fmt(d.invoices.overdue), "#/invoices"]);
  if (d.receiptsWaiting) todo.push([`${d.receiptsWaiting} receipt${d.receiptsWaiting > 1 ? "s" : ""} waiting to be filed`, "", "#/expenses"]);
  if (d.bankUnsorted) todo.push([`${d.bankUnsorted} bank line${d.bankUnsorted > 1 ? "s" : ""} to sort`, "", "#/bank"]);
  if (d.bills.n) todo.push([`${d.bills.n} unpaid bill${d.bills.n > 1 ? "s" : ""}`, fmt(d.bills.total), "#/expenses"]);
  if (d.unsorted.uncategorized) todo.push(["Uncategorized expenses need a category", fmt(d.unsorted.uncategorized), "#/reports/gl"]);
  if (d.unsorted.suspense) todo.push(["Money sitting in Suspense (1900)", fmt(d.unsorted.suspense), "#/reports/gl"]);
  if (daysSinceExport === null || daysSinceExport >= 30) todo.push([daysSinceExport === null ? "You have never downloaded a backup" : `Last backup was ${daysSinceExport} days ago`, "", "#/settings"]);

  return (
    <>
      <div className="head"><h1>Dashboard</h1><BasisToggle value={basis} onChange={setBasis} /></div>
      {boot.database !== "postgres" && <div className="note warn">Running on the built-in file database. That is fine for trying things out, but add a PostgreSQL database in Replit before you publish or enter real records.</div>}
      <div className="cards">
        <div className="stat"><div className="k">Money in, this month</div><div className="v">{fmt(d.month.in)}</div><div className="s">{fmt(d.ytd.in)} this year</div></div>
        <div className="stat"><div className="k">Money out, this month</div><div className="v">{fmt(d.month.out)}</div><div className="s">{fmt(d.ytd.out)} this year</div></div>
        <div className="stat"><div className="k">Profit, this month</div><div className={"v" + (d.month.net < 0 ? " neg" : "")}>{fmt(d.month.net)}</div><div className="s">{fmt(d.ytd.net)} this year</div></div>
        <div className="stat"><div className="k">Customers owe you</div><div className="v">{fmt(d.invoices.unpaid)}</div><div className="s">{d.invoices.unpaid_count} open invoice{d.invoices.unpaid_count === 1 ? "" : "s"}</div></div>
      </div>

      <div className="split">
        <div className="card">
          <h2>To do</h2>
          {todo.length === 0 ? <p className="muted">Nothing waiting. The books are tidy.</p> : (
            <ul className="todo">{todo.map(([label, amount, href]) => <li key={label}><a href={href}>{label}</a><span className="num">{amount}</span></li>)}</ul>
          )}
        </div>
        <div className="card">
          <h2>Set aside for taxes</h2>
          <div className="stat" style={{ border: 0, padding: "8px 0 0" }}><div className="v">{fmt(d.setAside)}</div></div>
          <div className="meter" aria-hidden="true"><i style={{ width: (d.setAside > 0 ? Math.min(100, d.setAsidePct) : 0) + "%" }} /></div>
          <div className="small muted">{d.setAsidePct}% of this year's profit of {fmt(Math.max(0, d.ytd.net))}. Next federal estimated tax due: {nextEstimates(boot.today).map(niceDate).join(", then ")}.</div>
          <Cpa>Your CPA sets the real amounts.</Cpa>
        </div>
      </div>

      <div className="card">
        <div className="head" style={{ marginBottom: 4 }}><h2>Income and spending, last 12 months</h2>
          <div className="legend"><span><i style={{ background: "var(--green-2)" }} />In</span><span><i style={{ background: "#c9a14a" }} />Out</span></div></div>
        {d.chart.length === 0 ? <p className="muted">Nothing recorded yet. Start with an invoice or a receipt.</p> : (
          <div className="bars" role="img" aria-label="Monthly money in and out">
            {d.chart.map((m: any) => (
              <div className="m" key={m.ym} title={`${m.ym}: in ${fmt(m.money_in)}, out ${fmt(m.money_out)}`}>
                <div className="pair"><i className="in" style={{ height: (Math.max(0, m.money_in) / max) * 100 + "%" }} /><i className="out" style={{ height: (Math.max(0, m.money_out) / max) * 100 + "%" }} /></div>
                <div className="lbl">{new Date(m.ym + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {d.accounts.length > 0 && (
        <div className="card flush"><table>
          <thead><tr><th>Account balances per the books</th><th className="num">Balance</th></tr></thead>
          <tbody>{d.accounts.map((a: any) => <tr key={a.number}><td>{a.number} {a.name}{a.type === "liability" ? " (owed)" : ""}</td><td className="num"><Money cents={a.amount} sign /></td></tr>)}</tbody>
        </table></div>
      )}
      {d.lockedThrough && <p className="small muted">Books are locked through {niceDate(d.lockedThrough)}.</p>}
    </>
  );
}
