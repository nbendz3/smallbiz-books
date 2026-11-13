import { useMemo, useRef, useState } from "react";
import { api, fmt, niceDate, parseMoney } from "../api";
import { AccountSelect, Confirm, Entries, ErrorNote, Field, isPayFrom, isSpend, Loading, Modal, MoneyInput, Pill, Tabs, useAction, useBoot, useLoad } from "../ui";

export function Expenses() {
  const { boot } = useBoot();
  const [tab, setTab] = useState<"inbox" | "list" | "bills">("inbox");
  const year = boot.today.slice(0, 4);
  const [from, setFrom] = useState(year + "-01-01");
  const [to, setTo] = useState(year + "-12-31");
  const receipts = useLoad<any[]>("/receipts");
  const expenses = useLoad<any[]>(`/expenses?from=${from}&to=${to}`);
  const bills = useLoad<any[]>("/expenses");
  const [form, setForm] = useState<{ receipt?: any } | null>(null);
  const [paying, setPaying] = useState<any>(null);
  const [voiding, setVoiding] = useState<any>(null);
  const [viewing, setViewing] = useState<any>(null);
  const [q, setQ] = useState("");
  const reloadAll = () => { receipts.reload(); expenses.reload(); bills.reload(); };

  const unpaid = (bills.data ?? []).filter((x) => !x.voided && !x.paid_from_account_id);
  const shown = (expenses.data ?? []).filter((x) => !q || `${x.vendor_name ?? ""} ${x.description} ${x.categories}`.toLowerCase().includes(q.toLowerCase()));
  const byCategory = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of shown) if (!x.voided) for (const l of x.lines ?? []) m.set(l.account_id, (m.get(l.account_id) ?? 0) + l.amount_cents);
    return [...m.entries()].map(([id, cents]) => ({ a: boot.accounts.find((a) => a.id === id)!, cents })).sort((a, b) => b.cents - a.cents);
  }, [shown, boot.accounts]);

  return (
    <>
      <div className="head"><h1>Expenses & Receipts</h1><button className="btn primary" onClick={() => setForm({})}>Add expense</button></div>
      <Tabs value={tab} onChange={setTab} options={[["inbox", `Receipt inbox${receipts.data?.length ? ` (${receipts.data.length})` : ""}`], ["list", "Expenses"], ["bills", `Unpaid bills${unpaid.length ? ` (${unpaid.length})` : ""}`]]} />

      {tab === "inbox" && <Inbox receipts={receipts.data} error={receipts.error} reload={receipts.reload} onOpen={(r) => setForm({ receipt: r })} />}

      {tab === "list" && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <input type="date" style={{ width: "auto" }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input type="date" style={{ width: "auto" }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <input className="grow" placeholder="Search vendor, note or category" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ErrorNote>{expenses.error}</ErrorNote>
          {!expenses.data ? <Loading /> : (
            <>
              {byCategory.length > 0 && (
                <details className="card"><summary><strong>Totals by category</strong> <span className="muted">({fmt(byCategory.reduce((a, c) => a + c.cents, 0))})</span></summary>
                  <table className="mini"><tbody>{byCategory.map((c) => <tr key={c.a.id}><td>{c.a.number} {c.a.name}</td><td className="muted">{c.a.sched_c_line ? "Sch C line " + c.a.sched_c_line : ""}</td><td className="num">{fmt(c.cents)}</td></tr>)}</tbody></table>
                </details>
              )}
              <div className="card flush scroll"><table>
                <thead><tr><th>Date</th><th>Vendor / note</th><th className="hide-sm">Category</th><th className="hide-sm">Paid from</th><th className="num">Amount</th><th /></tr></thead>
                <tbody>
                  {shown.map((x) => (
                    <tr key={x.id} className={(x.voided ? "off " : "") + "click"} onClick={() => setViewing(x)}>
                      <td>{niceDate(x.exp_date)}</td><td>{x.vendor_name ?? ""}{x.vendor_name && x.description ? " · " : ""}{x.description}{x.receipt_id ? <span className="muted small"> (receipt)</span> : null}</td>
                      <td className="hide-sm">{x.categories}{x.business_pct < 100 ? ` (${x.business_pct}% business)` : ""}</td>
                      <td className="hide-sm">{x.paid_from_name ?? <Pill>Unpaid</Pill>}</td><td className="num">{fmt(x.total_cents)}</td>
                      <td className="num">{x.voided ? <Pill>Voided</Pill> : <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); setVoiding(x); }}>Void</button>}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={6} className="empty">No expenses in this period.</td></tr>}
                </tbody>
              </table></div>
            </>
          )}
        </>
      )}

      {tab === "bills" && (
        <div className="card flush scroll"><table>
          <thead><tr><th>Bill date</th><th>Vendor / note</th><th>Due</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {unpaid.map((x) => (
              <tr key={x.id}><td>{niceDate(x.exp_date)}</td><td>{x.vendor_name ?? ""} {x.description}</td><td>{x.due_date ? niceDate(x.due_date) : ""}{x.due_date && x.due_date < boot.today ? <> <Pill>Overdue</Pill></> : null}</td>
                <td className="num">{fmt(x.total_cents)}</td><td className="num"><button className="btn sm primary" onClick={() => setPaying(x)}>Mark paid</button></td></tr>
            ))}
            {unpaid.length === 0 && <tr><td colSpan={5} className="empty">No unpaid bills.</td></tr>}
          </tbody>
        </table></div>
      )}

      {form && <ExpenseForm receipt={form.receipt} onClose={() => setForm(null)} onSaved={() => { setForm(null); reloadAll(); }} />}
      {paying && <PayBill bill={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reloadAll(); }} />}
      {voiding && <Confirm text={`Void this ${fmt(voiding.total_cents)} expense? A reversing entry is posted${voiding.receipt_id ? " and its receipt goes back to the inbox" : ""}.`} label="Void expense"
        action={() => api(`/expenses/${voiding.id}/void`, { method: "POST" })} onDone={() => { setVoiding(null); reloadAll(); }} />}
      {viewing && (
        <Modal title={`${viewing.vendor_name ?? "Expense"} · ${fmt(viewing.total_cents)}`} onClose={() => setViewing(null)} wide={!!viewing.receipt_id}>
          <div className={viewing.receipt_id ? "split" : ""}>
            {viewing.receipt_id && <ReceiptView id={viewing.receipt_id} />}
            <div>
              <p>{niceDate(viewing.exp_date)} · {viewing.categories}{viewing.business_pct < 100 ? ` · ${viewing.business_pct}% business use` : ""}</p>
              {viewing.description && <p>{viewing.description}</p>}
              {viewing.purpose && <p><span className="label">Business purpose</span><br />{viewing.purpose}</p>}
              <p className="muted">{viewing.paid_from_name ? `Paid ${niceDate(viewing.paid_date)} from ${viewing.paid_from_name} (${viewing.pay_method.replace("_", " ")})` : "Not paid yet"}</p>
              <Entries type="expense" id={viewing.id} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ReceiptView({ id, mime }: { id: number; mime?: string }) {
  const url = `/api/receipts/${id}/file`;
  const [asPdf, setAsPdf] = useState(mime === "application/pdf");
  return (
    <div className="preview">
      {asPdf ? <iframe src={url} title="Receipt" /> : <img src={url} alt="Receipt" onError={() => setAsPdf(true)} />}
    </div>
  );
}

function Inbox({ receipts, error, reload, onOpen }: { receipts: any[] | null; error: string; reload: () => void; onOpen: (r: any) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [msgs, setMsgs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    const out: string[] = [];
    for (const f of Array.from(files)) {
      const type = f.type || (/\.heic$/i.test(f.name) ? "image/heic" : /\.pdf$/i.test(f.name) ? "application/pdf" : "");
      try { await api("/receipts", { raw: f, headers: { "Content-Type": type, "X-Filename": encodeURIComponent(f.name) } }); }
      catch (e: any) { out.push(`${f.name}: ${e.message}`); }
    }
    setMsgs(out); setBusy(false); reload();
  };
  return (
    <>
      <div className={"drop" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
        <p style={{ margin: "0 0 10px" }}>{busy ? "Uploading..." : "Drop receipt photos or PDFs here, or"}</p>
        <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>Take or choose a photo</button>
        <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ""; }} />
        <p className="hint" style={{ margin: "10px 0 0" }}>Each file is kept privately with its expense. Uploading the same file twice is refused.</p>
      </div>
      {msgs.map((m) => <ErrorNote key={m}>{m}</ErrorNote>)}
      <ErrorNote>{error}</ErrorNote>
      {!receipts ? <Loading /> : receipts.length === 0 ? <div className="empty">Inbox is empty. Every receipt has been filed.</div> : (
        <div className="thumbs">
          {receipts.map((r) => (
            <button key={r.id} className="thumb" onClick={() => onOpen(r)}>
              {r.mime === "application/pdf" || /heic|heif/.test(r.mime) ? <div className="pic">{r.mime === "application/pdf" ? "PDF" : "PHOTO"}</div> : <img src={`/api/receipts/${r.id}/file`} alt="" loading="lazy" />}
              <div className="cap">{r.filename}</div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const METHODS: [string, string][] = [["ach", "Bank transfer / ACH / online bill pay"], ["check", "Check"], ["debit_card", "Debit card"], ["cash", "Cash"], ["other", "Other"]];

function ExpenseForm({ receipt, onClose, onSaved }: { receipt?: any; onClose: () => void; onSaved: () => void }) {
  const { boot, reload } = useBoot();
  const checking = boot.accounts.find((a) => a.number === "1010")!.id;
  const [vendorName, setVendorName] = useState("");
  const [date, setDate] = useState(boot.today);
  const [lines, setLines] = useState<{ accountId: number | ""; amount: string }[]>([{ accountId: "", amount: "" }]);
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pct, setPct] = useState("100");
  const [paidFrom, setPaidFrom] = useState<number | "">(checking);
  const [paidDate, setPaidDate] = useState("");
  const [method, setMethod] = useState("ach");
  const [dueDate, setDueDate] = useState("");
  const [run, busy, error] = useAction();

  const vendor = boot.vendors.find((v) => v.name.toLowerCase() === vendorName.trim().toLowerCase());
  const paidAcct = boot.accounts.find((a) => a.id === paidFrom);
  const needsPurpose = lines.some((l) => boot.accounts.find((a) => a.id === l.accountId)?.requires_purpose);
  const total = lines.reduce((a, l) => a + (parseMoney(l.amount) ?? 0), 0);
  const setLine = (i: number, patch: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickVendor = (name: string) => {
    setVendorName(name);
    const v = boot.vendors.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (v?.default_account_id && lines.length === 1 && lines[0].accountId === "") setLine(0, { accountId: v.default_account_id });
  };

  const save = () => run(async () => {
    const used = lines.filter((l) => l.amount.trim() || l.accountId !== "");
    if (!used.length || used.some((l) => l.accountId === "" || !parseMoney(l.amount))) throw new Error("Enter an amount and pick a category.");
    const businessPct = Number(pct);
    if (!Number.isInteger(businessPct) || businessPct < 0 || businessPct > 100) throw new Error("Business use must be a whole number from 0 to 100.");
    let vendorId = vendor?.id ?? null;
    if (!vendorId && vendorName.trim()) { vendorId = (await api("/vendors", { body: { name: vendorName.trim(), default_account_id: used[0].accountId } })).id; await reload(); }
    await api("/expenses", { body: {
      vendorId, date, description, purpose, businessPct, lines: used.map((l) => ({ accountId: l.accountId, amountCents: parseMoney(l.amount) })),
      paidFromAccountId: paidFrom === "" ? null : paidFrom, paidDate: paidFrom === "" ? null : paidDate || date,
      payMethod: paidFrom === "" ? "" : paidAcct?.type === "liability" ? "credit_card" : paidAcct?.number === "1050" ? "cash" : method,
      dueDate: paidFrom === "" && dueDate ? dueDate : null, receiptId: receipt?.id ?? null } });
    onSaved();
  });

  const formBody = (
    <div>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid">
        <Field label="Vendor" hint={vendorName.trim() && !vendor ? "New vendor: it will be added for you" : undefined}>
          <input list="vendor-list" value={vendorName} onChange={(e) => pickVendor(e.target.value)} placeholder="Who you paid" autoFocus={!receipt} />
          <datalist id="vendor-list">{boot.vendors.filter((v) => !v.archived).map((v) => <option key={v.id} value={v.name} />)}</datalist>
        </Field>
        <Field label="Date on the receipt"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {lines.map((l, i) => (
          <div className="field wide" key={i}>
            <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
              <div style={{ width: 120, flex: "none" }}><Field label={lines.length > 1 ? "Amount " + (i + 1) : "Total"}><MoneyInput value={l.amount} onChange={(v) => setLine(i, { amount: v })} /></Field></div>
              <div className="grow" style={{ minWidth: 0 }}><Field label="Category"><AccountSelect value={l.accountId} onChange={(v) => setLine(i, { accountId: v })} filter={isSpend} empty="Choose..." showLine /></Field></div>
              {lines.length > 1 && <button className="btn sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          </div>
        ))}
        <div className="field wide row"><button className="btn sm" onClick={() => setLines([...lines, { accountId: "", amount: "" }])}>Split across categories</button>{lines.length > 1 && <span className="muted">Total {fmt(total)}</span>}</div>
        <Field label="Note" wide><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it was" /></Field>
        <Field label={needsPurpose ? "Business purpose (required)" : "Business purpose"} hint={needsPurpose ? "Meals and travel: who was there and what business was discussed" : undefined} wide>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <Field label="Business use %" hint="Under 100? The personal part is booked as an owner draw."><input className="num" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label="Paid from"><AccountSelect value={paidFrom} onChange={setPaidFrom} filter={(a) => isPayFrom(a) && a.number !== "1170"} empty="Not paid yet - it's a bill" /></Field>
        {paidFrom === "" ? <Field label="Bill due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field> : (
          <>
            <Field label="Date paid" hint="Leave blank if same as receipt date"><input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} /></Field>
            {paidAcct?.type === "asset" && paidAcct.number !== "1050" && <Field label="How it was paid" hint="Matters for 1099s: card payments are left off"><select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
          </>
        )}
      </div>
      <div className="row end">
        {receipt && <button className="btn ghost" disabled={busy} onClick={() => run(async () => { await api(`/receipts/${receipt.id}`, { method: "DELETE" }); onSaved(); })}>Delete this receipt</button>}
        <span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save expense</button>
      </div>
    </div>
  );
  return (
    <Modal title={receipt ? "File this receipt" : "Add expense"} onClose={onClose} wide={!!receipt}>
      {receipt ? <div className="split"><ReceiptView id={receipt.id} mime={receipt.mime} />{formBody}</div> : formBody}
    </Modal>
  );
}

function PayBill({ bill, onClose, onSaved }: { bill: any; onClose: () => void; onSaved: () => void }) {
  const { boot } = useBoot();
  const [accountId, setAccountId] = useState<number | "">(boot.accounts.find((a) => a.number === "1010")!.id);
  const [date, setDate] = useState(boot.today);
  const [method, setMethod] = useState("ach");
  const [run, busy, error] = useAction();
  const acct = boot.accounts.find((a) => a.id === accountId);
  return (
    <Modal title={`Pay bill · ${fmt(bill.total_cents)}`} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <p className="muted">{bill.vendor_name} {bill.description}</p>
      <div className="grid">
        <Field label="Paid from"><AccountSelect value={accountId} onChange={setAccountId} filter={(a) => isPayFrom(a) && a.number !== "1170"} /></Field>
        <Field label="Date paid"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {acct?.type === "asset" && acct.number !== "1050" && <Field label="How it was paid"><select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
      </div>
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || accountId === ""} onClick={() => run(async () => {
          await api(`/expenses/${bill.id}/pay`, { body: { accountId, date, method: acct?.type === "liability" ? "credit_card" : acct?.number === "1050" ? "cash" : method } }); onSaved();
        })}>Mark paid</button></div>
    </Modal>
  );
}

