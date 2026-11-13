import { useState } from "react";
import { api, moneyText, niceDate, parseMoney, parseScaled, type Account } from "../api";
import { Cpa, ErrorNote, Field, Loading, Modal, MoneyInput, Tabs, useAction, useBoot, useLoad } from "../ui";

const SCHED_C = ["1", "2", "4", "6", "8", "9", "10", "11", "13", "14", "15", "16a", "16b", "17", "18", "19", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27a", "30"];
const TYPES: [string, string][] = [["asset", "Asset"], ["liability", "Liability"], ["equity", "Equity"], ["income", "Income"], ["cogs", "Cost of goods sold"], ["expense", "Expense"]];

export function SettingsPage() {
  const [tab, setTab] = useState<"business" | "yearend" | "accounts" | "rates" | "log">("business");
  return (
    <>
      <div className="head"><h1>Settings & Year End</h1></div>
      <Tabs value={tab} onChange={setTab} options={[["business", "Business"], ["yearend", "Year end & backups"], ["accounts", "Chart of accounts"], ["rates", "Mileage rates"], ["log", "Activity log"]]} />
      {tab === "business" && <Business />}
      {tab === "yearend" && <YearEnd />}
      {tab === "accounts" && <Accounts />}
      {tab === "rates" && <Rates />}
      {tab === "log" && <Log />}
    </>
  );
}

function Business() {
  const { boot, reload } = useBoot();
  const [s, setS] = useState({ ...boot.settings });
  const [rate, setRate] = useState((boot.settings.tax_rate_x1000 / 1000).toString());
  const [threshold, setThreshold] = useState(moneyText(boot.settings.threshold_1099_cents));
  const [saved, setSaved] = useState(false);
  const [run, busy, error] = useAction();
  const set = (k: string, v: any) => { setS({ ...s, [k]: v }); setSaved(false); };
  const num = (k: string) => (e: any) => set(k, Number(e.target.value.replace(/\D/g, "")) || 0);
  const save = () => run(async () => {
    const r = parseScaled(rate || "0", 1000), t = parseMoney(threshold);
    if (r === null || t === null) throw new Error("Check the sales tax rate and the 1099 threshold.");
    await api("/settings", { method: "PUT", body: { ...s, tax_rate_x1000: r, threshold_1099_cents: t } });
    await reload(); setSaved(true);
  });
  return (
    <>
      <ErrorNote>{error}</ErrorNote>
      {saved && <div className="note good">Saved.</div>}
      <div className="card"><h2>Your business</h2>
        <div className="grid" style={{ marginTop: 10 }}>
          <Field label="Business name" wide><input value={s.business_name} onChange={(e) => set("business_name", e.target.value)} /></Field>
          <Field label="Entity type" hint="Reports are built for Schedule C filers. Other types still work for bookkeeping.">
            <select value={s.entity_type} onChange={(e) => set("entity_type", e.target.value)}>
              <option value="sole_prop">Sole proprietor (Schedule C)</option><option value="smllc">Single-member LLC (Schedule C)</option><option value="s_corp">S corporation</option><option value="partnership">Partnership / multi-member LLC</option><option value="c_corp">C corporation</option>
            </select></Field>
          <Field label="Reports default to" hint="Most small service businesses file on the cash basis.">
            <select value={s.basis} onChange={(e) => set("basis", e.target.value)}><option value="CASH">Cash basis</option><option value="ACCRUAL">Accrual basis</option></select></Field>
          <Field label="Email"><input value={s.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Phone"><input value={s.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Address (shown on invoices)" wide><textarea value={s.address} onChange={(e) => set("address", e.target.value)} /></Field>
        </div>
        {s.entity_type !== "sole_prop" && s.entity_type !== "smllc" && <Cpa>S corporations need owner pay to go through payroll, and partnerships need per-partner capital accounts. Neither is handled here.</Cpa>}
      </div>
      <div className="card"><h2>Invoices</h2>
        <div className="grid" style={{ marginTop: 10 }}>
          <Field label="Number prefix"><input value={s.invoice_prefix} onChange={(e) => set("invoice_prefix", e.target.value)} /></Field>
          <Field label="Next number" hint="Can only go up; numbers are never reused."><input inputMode="numeric" value={s.next_invoice_number} onChange={num("next_invoice_number")} /></Field>
          <Field label="Payment terms (days)"><input inputMode="numeric" value={s.terms_days} onChange={num("terms_days")} /></Field>
          <Field label="How to pay (printed at the bottom of every invoice)" wide><textarea value={s.invoice_footer} onChange={(e) => set("invoice_footer", e.target.value)} placeholder="Make checks payable to... / Zelle to... Do not put bank account numbers here." /></Field>
        </div>
      </div>
      <div className="card"><h2>Taxes</h2>
        <div className="grid" style={{ marginTop: 10 }}>
          <label className="check field wide"><input type="checkbox" checked={s.sales_tax_on} onChange={(e) => set("sales_tax_on", e.target.checked)} /> I charge sales tax (usually only when selling physical goods)</label>
          {s.sales_tax_on && <Field label="Usual sales tax rate %" hint="You can change it on each invoice."><input className="num" inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); setSaved(false); }} /></Field>}
          <Field label="Set aside for taxes (% of profit)" hint="Drives the meter on the dashboard."><input inputMode="numeric" value={s.tax_set_aside_pct} onChange={num("tax_set_aside_pct")} /></Field>
          <Field label="1099 threshold" hint="$2,000 for payments made in 2026; indexed for inflation after that."><MoneyInput value={threshold} onChange={(v) => { setThreshold(v); setSaved(false); }} /></Field>
        </div>
        <Cpa>Sales tax rules, the set-aside percentage and 1099 thresholds are yours to set.</Cpa>
      </div>
      <div className="row end"><button className="btn primary" disabled={busy} onClick={save}>Save settings</button></div>
    </>
  );
}

function YearEnd() {
  const { boot, reload } = useBoot();
  const thisYear = Number(boot.today.slice(0, 4));
  const [year, setYear] = useState(thisYear - (boot.today.slice(5, 7) <= "04" ? 1 : 0));
  const { data: checks } = useLoad<any[]>(`/checklist?year=${year}`);
  const [lockDate, setLockDate] = useState(`${year}-12-31`);
  const [confirm, setConfirm] = useState("");
  const [run, busy, error] = useAction();
  const locked = boot.settings.locked_through as string | null;
  const lock = (date: string | null) => run(async () => { await api("/settings/lock", { body: { date, confirm } }); setConfirm(""); await reload(); });
  return (
    <>
      <div className="card">
        <div className="head" style={{ marginBottom: 8 }}><h2>Year-end checklist</h2>
          <select style={{ width: "auto" }} value={year} onChange={(e) => { setYear(Number(e.target.value)); setLockDate(`${e.target.value}-12-31`); }} aria-label="Year">{[0, 1, 2, 3].map((n) => <option key={n}>{thisYear - n}</option>)}</select></div>
        {!checks ? <Loading /> : <ul className="todo">{checks.map((c) => <li key={c.label}><span>{c.label}</span>{c.ok ? <span className="pill good">Done</span> : <span className="pill warn">To do</span>}</li>)}</ul>}
        <p className="small muted">Also do by hand: agree each bank account to its December statement (Bank, Check against statement), finish the mileage log, and ask your CPA about depreciation and the home office.</p>
      </div>
      <div className="card">
        <h2>Downloads</h2>
        <p className="muted">The accountant package is one ZIP with the year's reports, lists and receipts, ready to send to your CPA. The full backup is every record and every receipt; download one each month and keep it outside Replit.</p>
        <div className="row"><a className="btn primary" href={`/api/export?year=${year}`}>Accountant package for {year}</a><a className="btn" href="/api/export?full=1" onClick={() => setTimeout(reload, 4000)}>Full backup (everything)</a></div>
        <p className="small muted">Last full backup: {boot.settings.last_export_at ? niceDate(String(boot.settings.last_export_at).slice(0, 10)) : "never"}.</p>
      </div>
      <div className="card">
        <h2>Lock the books</h2>
        <p className="muted">{locked ? `Locked through ${niceDate(locked)}. Nothing can be posted, voided or changed on or before that date.` : "Not locked. After your taxes are filed, lock the year so it cannot change by accident."}</p>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid">
          <Field label="Lock through"><input type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></Field>
          <Field label={`Type LOCK${locked ? " or UNLOCK" : ""} to confirm`}><input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} /></Field>
        </div>
        <div className="row end">
          {locked && <button className="btn" disabled={busy || confirm !== "UNLOCK"} onClick={() => lock(null)}>Unlock</button>}
          <button className="btn primary" disabled={busy || confirm !== "LOCK" || !lockDate} onClick={() => lock(lockDate)}>Lock</button>
        </div>
      </div>
    </>
  );
}

function Accounts() {
  const { boot, reload } = useBoot();
  const [editing, setEditing] = useState<Partial<Account> | null>(null);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><p className="muted grow" style={{ margin: 0 }}>Categories everything is sorted into, each tied to its Schedule C line. Rename freely; add your own when you need more detail.</p>
        <button className="btn primary" onClick={() => setEditing({ number: "", name: "", type: "expense", sched_c_line: "27a", deductible_pct: 100, requires_purpose: false, pay_from: false, active: true })}>Add account</button></div>
      <div className="card flush scroll"><table>
        <thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Sch C line</th><th /></tr></thead>
        <tbody>{boot.accounts.map((a) => (
          <tr key={a.id} className={"click" + (a.active ? "" : " off")} onClick={() => setEditing(a)}>
            <td>{a.number}</td><td>{a.name}{a.deductible_pct < 100 ? <span className="muted small"> ({a.deductible_pct}% deductible)</span> : null}</td><td>{TYPES.find((t) => t[0] === a.type)?.[1]}</td><td>{a.sched_c_line ?? ""}</td><td className="num"><button className="btn sm ghost">Edit</button></td>
          </tr>))}</tbody>
      </table></div>
      <Cpa>Schedule C line assignments are a starting point.</Cpa>
      {editing && <AccountForm account={editing} onClose={() => setEditing(null)} onSaved={async () => { await reload(); setEditing(null); }} />}
    </>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: Partial<Account>; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<any>({ ...account });
  const [run, busy, error] = useAction();
  const set = (k: string, v: any) => setA({ ...a, [k]: v });
  const isNew = !account.id, pl = ["income", "cogs", "expense"].includes(a.type), balance = a.type === "asset" || a.type === "liability";
  const save = () => run(async () => {
    await api(isNew ? "/accounts" : `/accounts/${account.id}`, { method: isNew ? "POST" : "PUT", body: { ...a, sched_c_line: pl ? a.sched_c_line || null : null, deductible_pct: Number(a.deductible_pct) || 0 } });
    onSaved();
  });
  return (
    <Modal title={isNew ? "Add account" : `${account.number} ${account.name}`} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid">
        <Field label="Number" hint={isNew ? "4 digits. 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx cost of goods, 6xxx expenses." : "Cannot change"}><input disabled={!isNew} inputMode="numeric" maxLength={4} value={a.number} onChange={(e) => set("number", e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label="Type" hint={isNew ? undefined : "Cannot change"}><select disabled={!isNew} value={a.type} onChange={(e) => set("type", e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Name" wide><input value={a.name} onChange={(e) => set("name", e.target.value)} /></Field>
        {pl && <Field label="Schedule C line"><select value={a.sched_c_line ?? ""} onChange={(e) => set("sched_c_line", e.target.value)}><option value="">None</option>{SCHED_C.map((l) => <option key={l}>{l}</option>)}</select></Field>}
        {a.type === "expense" && <Field label="Deductible %" hint="Meals are usually 50."><input inputMode="numeric" value={a.deductible_pct} onChange={(e) => set("deductible_pct", e.target.value.replace(/\D/g, ""))} /></Field>}
        {a.type === "expense" && <label className="check field wide"><input type="checkbox" checked={a.requires_purpose} onChange={(e) => set("requires_purpose", e.target.checked)} /> Require a business purpose (meals, travel, gifts)</label>}
        {balance && <label className="check field wide"><input type="checkbox" disabled={!!account.system} checked={a.pay_from} onChange={(e) => set("pay_from", e.target.checked)} /> This is a bank account, card or cash I pay from</label>}
        {!isNew && <label className="check field wide"><input type="checkbox" disabled={!!account.system} checked={a.active} onChange={(e) => set("active", e.target.checked)} /> Active (shown in pick lists){account.system ? " - the app uses this account itself" : ""}</label>}
      </div>
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
    </Modal>
  );
}

function Rates() {
  const { boot, reload } = useBoot();
  const [date, setDate] = useState(`${Number(boot.today.slice(0, 4)) + 1}-01-01`);
  const [cents, setCents] = useState("");
  const [run, busy, error] = useAction();
  return (
    <div className="card">
      <p className="muted">IRS business standard mileage rates by the date they took effect. The IRS announces the new rate each December (and sometimes mid-year); add it here from irs.gov.</p>
      <table className="mini" style={{ maxWidth: 360 }}><tbody>{boot.mileageRates.map((r) => <tr key={r.effective_date}><td>From {niceDate(r.effective_date)}</td><td className="num">{r.rate_tenth_cents / 10}¢ per mile</td></tr>)}</tbody></table>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid" style={{ maxWidth: 460 }}>
        <Field label="Effective date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Cents per mile"><input className="num" inputMode="decimal" value={cents} onChange={(e) => setCents(e.target.value)} placeholder="72.5" /></Field>
      </div>
      <div className="row end" style={{ maxWidth: 460 }}><button className="btn primary" disabled={busy} onClick={() => run(async () => {
        const r = parseScaled(cents, 10);
        if (!r) throw new Error("Enter the rate in cents, like 72.5");
        await api("/mileage-rates", { body: { effective_date: date, rate_tenth_cents: r } }); setCents(""); await reload();
      })}>Add or update rate</button></div>
      <Cpa>Trips already logged keep the rate they were saved with.</Cpa>
    </div>
  );
}

function Log() {
  const { data, error } = useLoad<any[]>("/audit");
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  return (
    <div className="card flush scroll"><table>
      <thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead>
      <tbody>
        {data.map((r) => <tr key={r.id}><td>{new Date(r.at).toLocaleString()}</td><td>{r.action.replace(/_/g, " ")}</td><td>{r.detail}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={3} className="empty">Issues, voids, payments, exports and lock changes will be listed here.</td></tr>}
      </tbody>
    </table></div>
  );
}
