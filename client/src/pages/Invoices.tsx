import { useEffect, useMemo, useState } from "react";
import { addDays, api, fmt, lineAmount, moneyText, niceDate, parseMoney, parseScaled, taxFor } from "../api";
import { AccountSelect, Confirm, Entries, ErrorNote, Field, isIncome, isPayFrom, Loading, Modal, Money, MoneyInput, Pill, Tabs, go, useAction, useBoot, useLoad } from "../ui";

export function Invoices({ parts }: { parts: string[] }) {
  if (parts[0] === "new") return <Editor />;
  if (parts[0] && parts[1] === "edit") return <Editor id={Number(parts[0])} />;
  if (parts[0] && parts[0] !== "payments") return <Detail id={Number(parts[0])} />;
  return <List tab={parts[0] === "payments" ? "payments" : "invoices"} />;
}

function List({ tab }: { tab: "invoices" | "payments" }) {
  const { data, error } = useLoad<any[]>("/invoices");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const rows = (data ?? []).filter((i) => (!status || (status === "Open" ? i.status === "sent" && i.balance_cents > 0 : i.display_status === status))
    && (!q || `${i.number ?? ""} ${i.customer_name}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="head"><h1>Invoices</h1>
        <div className="row"><button className="btn" onClick={() => setPaying(true)}>Record payment</button><a className="btn primary" href="#/invoices/new">New invoice</a></div></div>
      <Tabs value={tab} onChange={(t) => go(t === "payments" ? "#/invoices/payments" : "#/invoices")} options={[["invoices", "Invoices"], ["payments", "Payments received"]]} />
      <ErrorNote>{error}</ErrorNote>
      {tab === "payments" ? <Payments /> : !data ? <Loading /> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All statuses</option>{["Open", "Draft", "Sent", "Partially paid", "Overdue", "Paid", "Void"].map((s) => <option key={s}>{s}</option>)}
            </select>
            <input className="grow" placeholder="Search number or customer" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="card flush scroll"><table>
            <thead><tr><th>Number</th><th>Customer</th><th className="hide-sm">Issued</th><th>Due</th><th className="num hide-sm">Total</th><th className="num">Balance</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="click" onClick={() => go("#/invoices/" + i.id)}>
                  <td><a href={"#/invoices/" + i.id}>{i.number ?? "Draft"}</a></td><td>{i.customer_name}</td><td className="hide-sm">{niceDate(i.issue_date)}</td><td>{niceDate(i.due_date)}</td>
                  <td className="num hide-sm">{fmt(i.total_cents)}</td><td className="num">{i.status === "sent" ? fmt(i.balance_cents) : ""}</td><td><Pill>{i.display_status}</Pill></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="empty">{data.length ? "No invoices match." : "No invoices yet. Create your first one."}</td></tr>}
            </tbody>
          </table></div>
        </>
      )}
      {paying && <PaymentModal onClose={() => setPaying(false)} onSaved={() => { setPaying(false); go("#/invoices/payments"); }} />}
    </>
  );
}

function Payments() {
  const { data, error, reload } = useLoad<any[]>("/payments");
  const [voiding, setVoiding] = useState<any>(null);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  return (
    <>
      <div className="card flush scroll"><table>
        <thead><tr><th>Date</th><th>Customer</th><th className="hide-sm">Method</th><th className="hide-sm">Deposited to</th><th>Invoices</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.id} className={p.voided ? "off" : ""}>
              <td>{niceDate(p.pay_date)}</td><td>{p.customer_name}</td><td className="hide-sm">{p.method}{p.reference ? " · " + p.reference : ""}</td><td className="hide-sm">{p.account_name}</td>
              <td>{p.invoices ?? "Customer deposit"}{!p.voided && p.applied_cents < p.amount_cents ? <span className="muted small"> ({fmt(p.amount_cents - p.applied_cents)} held as credit)</span> : null}</td>
              <td className="num">{fmt(p.amount_cents)}</td><td className="num">{p.voided ? <Pill>Voided</Pill> : <button className="btn sm ghost" onClick={() => setVoiding(p)}>Void</button>}</td>
            </tr>
          ))}
          {data.length === 0 && <tr><td colSpan={7} className="empty">No payments recorded yet.</td></tr>}
        </tbody>
      </table></div>
      {voiding && <Confirm text={`Void the ${fmt(voiding.amount_cents)} payment from ${voiding.customer_name}? A reversing entry is posted and the invoices become unpaid again.`} label="Void payment"
        action={() => api(`/payments/${voiding.id}/void`, { method: "POST" })} onDone={() => { setVoiding(null); reload(); }} />}
    </>
  );
}

interface LineForm { description: string; qty: string; price: string; accountId: number | ""; taxable: boolean }

function Editor({ id }: { id?: number }) {
  const { boot, reload } = useBoot();
  const s = boot.settings;
  const defaultAccount = boot.accounts.find((a) => a.number === "4000")?.id ?? "";
  const blank = (): LineForm => ({ description: "", qty: "1", price: "", accountId: defaultAccount, taxable: false });
  const [customerId, setCustomerId] = useState<number | "">("");
  const [issueDate, setIssueDate] = useState(boot.today);
  const [dueDate, setDueDate] = useState(addDays(boot.today, s.terms_days));
  const [notes, setNotes] = useState("");
  const [rate, setRate] = useState((s.tax_rate_x1000 / 1000).toString());
  const [lines, setLines] = useState<LineForm[]>([blank()]);
  const [newCustomer, setNewCustomer] = useState("");
  const [loaded, setLoaded] = useState(!id);
  const [run, busy, error, setError] = useAction();

  useEffect(() => {
    if (!id) return;
    api(`/invoices/${id}`).then((d) => {
      if (d.invoice.status !== "draft") return go("#/invoices/" + id);
      setCustomerId(d.invoice.customer_id); setIssueDate(d.invoice.issue_date); setDueDate(d.invoice.due_date); setNotes(d.invoice.notes);
      if (d.invoice.tax_rate_x1000) setRate((d.invoice.tax_rate_x1000 / 1000).toString());
      setLines(d.lines.map((l: any) => ({ description: l.description, qty: (l.qty_x100 / 100).toString(), price: moneyText(l.unit_price_cents), accountId: l.account_id, taxable: l.taxable })));
      setLoaded(true);
    }).catch((e) => setError(e.message));
  }, [id]);

  const customer = boot.customers.find((c) => c.id === customerId);
  const taxOn = s.sales_tax_on && !customer?.tax_exempt;
  const rateX1000 = taxOn ? parseScaled(rate, 1000) ?? 0 : 0;
  const calc = useMemo(() => {
    const amounts = lines.map((l) => { const q = parseScaled(l.qty, 100), p = parseMoney(l.price); return q === null || p === null ? 0 : lineAmount(q, p); });
    const subtotal = amounts.reduce((a, b) => a + b, 0);
    const tax = lines.reduce((a, l, i) => a + (taxOn && l.taxable ? taxFor(amounts[i], rateX1000) : 0), 0);
    return { amounts, subtotal, tax, total: subtotal + tax };
  }, [lines, taxOn, rateX1000]);
  const setLine = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = (issue: boolean) => run(async () => {
    let cid = customerId;
    if (cid === "" && newCustomer.trim()) { cid = (await api("/customers", { body: { name: newCustomer.trim() } })).id; await reload(); setCustomerId(cid as number); setNewCustomer(""); }
    if (cid === "") throw new Error("Pick a customer, or type a new customer's name.");
    const used = lines.filter((l) => l.description.trim() || l.price.trim());
    if (!used.length) throw new Error("Add at least one line.");
    const body = {
      customerId: cid, issueDate, dueDate, notes, taxRateX1000: rateX1000,
      lines: used.map((l) => {
        const q = parseScaled(l.qty, 100), p = parseMoney(l.price);
        if (q === null || p === null || l.accountId === "") throw new Error("Check the quantity, price and income type on each line.");
        return { description: l.description, qtyX100: q, unitPriceCents: p, accountId: l.accountId, taxable: taxOn && l.taxable };
      }),
    };
    const saved = id ? await api(`/invoices/${id}`, { method: "PUT", body }) : await api("/invoices", { body });
    if (issue) await api(`/invoices/${saved.id}/issue`, { method: "POST" });
    go("#/invoices/" + saved.id);
  });

  if (!loaded) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  return (
    <>
      <div className="head"><h1>{id ? "Edit draft invoice" : "New invoice"}</h1><a className="btn ghost" href={id ? "#/invoices/" + id : "#/invoices"}>Cancel</a></div>
      <ErrorNote>{error}</ErrorNote>
      <div className="card">
        <div className="grid">
          <Field label="Customer">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">New customer...</option>{boot.customers.filter((c) => !c.archived || c.id === customerId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          {customerId === "" && <Field label="New customer name"><input value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} placeholder="Add details later under Customers" /></Field>}
          <Field label="Invoice date"><input type="date" value={issueDate} onChange={(e) => { setIssueDate(e.target.value); if (e.target.value) setDueDate(addDays(e.target.value, s.terms_days)); }} /></Field>
          <Field label="Due date" hint={`Your terms: ${s.terms_days} days`}><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          {taxOn && <Field label="Sales tax rate %" hint="Rate for where this sale is taxed"><input className="num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>}
        </div>
      </div>
      <div className="card">
        <h2>Lines</h2>
        <div className="scroll"><table className="lines-edit" style={{ minWidth: 640 }}>
          <thead><tr><th>Description</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 110 }}>Price</th><th style={{ width: 190 }}>Income type</th>{taxOn && <th>Tax</th>}<th className="num" style={{ width: 100 }}>Amount</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="What you did or sold" aria-label="Description" /></td>
                <td><input className="num" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Quantity" /></td>
                <td><MoneyInput value={l.price} onChange={(v) => setLine(i, { price: v })} /></td>
                <td><AccountSelect value={l.accountId} onChange={(v) => setLine(i, { accountId: v })} filter={(a) => isIncome(a) && a.number !== "4090"} /></td>
                {taxOn && <td><input type="checkbox" checked={l.taxable} onChange={(e) => setLine(i, { taxable: e.target.checked })} aria-label="Taxable" /></td>}
                <td className="num" style={{ paddingTop: 14 }}>{fmt(calc.amounts[i])}</td>
                <td>{lines.length > 1 && <button className="btn sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <button className="btn sm" onClick={() => setLines([...lines, blank()])}>Add a line</button>
        <div className="totals">
          <div><span>Subtotal</span><Money cents={calc.subtotal} /></div>
          {taxOn && <div><span>Sales tax</span><Money cents={calc.tax} /></div>}
          <div className="big"><span>Total</span><Money cents={calc.total} /></div>
        </div>
      </div>
      <div className="card"><Field label="Notes shown on the invoice"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>
      <div className="row end">
        <button className="btn" disabled={busy} onClick={() => save(false)}>Save as draft</button>
        <button className="btn primary" disabled={busy} onClick={() => save(true)}>Save and issue</button>
      </div>
      <p className="hint" style={{ textAlign: "right" }}>A draft posts nothing. Issuing gives it a number and locks it; after that, mistakes are fixed by voiding.</p>
    </>
  );
}

function Detail({ id }: { id: number }) {
  const { boot } = useBoot();
  const { data, error, reload } = useLoad<any>(`/invoices/${id}`);
  const [modal, setModal] = useState<"" | "pay" | "void" | "delete" | "voidpay">("");
  const [target, setTarget] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(0);
  const [run, busy, actionError] = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  const inv = data.invoice, link = `${window.location.origin}/i/${inv.public_token}`;
  const refresh = () => { setModal(""); reload(); setTick((t) => t + 1); };
  const mail = `mailto:${encodeURIComponent(inv.customer_email ?? "")}?subject=${encodeURIComponent(`Invoice ${inv.number} from ${boot.settings.business_name}`)}&body=${encodeURIComponent(
    `Hello,\n\nHere is invoice ${inv.number} for ${fmt(inv.total_cents)}, due ${niceDate(inv.due_date)}.\n\nView or download it here:\n${link}\n\nThank you,\n${boot.settings.business_name}`)}`;
  return (
    <>
      <div className="head">
        <div><a className="small" href="#/invoices">All invoices</a><h1>{inv.number ?? "Draft invoice"} <Pill>{inv.display_status}</Pill></h1><div className="muted">{inv.customer_name}</div></div>
        <div className="row no-print">
          {inv.status === "draft" && <><a className="btn" href={`#/invoices/${id}/edit`}>Edit</a>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/invoices/${id}/issue`, { method: "POST" })).then(refresh)}>Issue invoice</button></>}
          {inv.status === "sent" && inv.balance_cents > 0 && <button className="btn primary" onClick={() => setModal("pay")}>Record payment</button>}
          <a className="btn" href={`/api/invoices/${id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
          {inv.status === "sent" && <>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? "Copied" : "Copy link"}</button>
            <a className="btn" href={mail}>Email</a></>}
          <button className="btn" disabled={busy} onClick={() => run(async () => go("#/invoices/" + (await api(`/invoices/${id}/duplicate`, { method: "POST" })).id + "/edit"))}>Duplicate</button>
          {inv.status === "sent" && <button className="btn ghost" onClick={() => setModal("void")}>Void</button>}
          {inv.status === "draft" && <button className="btn ghost" onClick={() => setModal("delete")}>Delete</button>}
        </div>
      </div>
      <ErrorNote>{actionError}</ErrorNote>
      <div className="cards">
        <div className="stat"><div className="k">Total</div><div className="v">{fmt(inv.total_cents)}</div><div className="s">Issued {niceDate(inv.issue_date)}</div></div>
        <div className="stat"><div className="k">Paid</div><div className="v">{fmt(inv.paid_cents)}</div></div>
        <div className="stat"><div className="k">Balance due</div><div className="v">{fmt(inv.status === "sent" ? inv.balance_cents : 0)}</div><div className="s">Due {niceDate(inv.due_date)}</div></div>
      </div>
      <div className="card flush scroll"><table>
        <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Price</th><th className="hide-sm">Income type</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {data.lines.map((l: any) => <tr key={l.id}><td>{l.description}{l.taxable ? <span className="muted small"> (taxable)</span> : null}</td><td className="num">{l.qty_x100 / 100}</td><td className="num">{fmt(l.unit_price_cents)}</td><td className="hide-sm">{l.account_number} {l.account_name}</td><td className="num">{fmt(l.amount_cents)}</td></tr>)}
          {inv.tax_cents > 0 && <tr><td colSpan={3}>Sales tax ({inv.tax_rate_x1000 / 1000}%)</td><td className="hide-sm" /><td className="num">{fmt(inv.tax_cents)}</td></tr>}
          <tr className="total"><td colSpan={3}>Total</td><td className="hide-sm" /><td className="num">{fmt(inv.total_cents)}</td></tr>
        </tbody>
      </table></div>
      {inv.notes && <div className="card"><div className="label">Notes</div><div style={{ whiteSpace: "pre-line" }}>{inv.notes}</div></div>}
      {data.payments.length > 0 && (
        <div className="card flush scroll"><table>
          <thead><tr><th>Payment</th><th>Method</th><th className="num">Applied here</th><th /></tr></thead>
          <tbody>{data.payments.map((p: any) => (
            <tr key={p.id} className={p.voided ? "off" : ""}><td>{niceDate(p.pay_date)}</td><td>{p.method}{p.reference ? " · " + p.reference : ""} to {p.account_name}</td><td className="num">{fmt(p.applied_cents)}</td>
              <td className="num">{p.voided ? <Pill>Voided</Pill> : <button className="btn sm ghost" onClick={() => { setTarget(p); setModal("voidpay"); }}>Void</button>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <Entries type="invoice" id={id} tick={tick} />
      {modal === "pay" && <PaymentModal invoice={inv} onClose={() => setModal("")} onSaved={refresh} />}
      {modal === "void" && <Confirm text={`Void ${inv.number}? A reversing entry is posted. The number is never reused.`} label="Void invoice" action={() => api(`/invoices/${id}/void`, { method: "POST" })} onDone={refresh} />}
      {modal === "delete" && <Confirm text="Delete this draft? Drafts were never posted, so nothing else changes." label="Delete draft" action={async () => { await api(`/invoices/${id}`, { method: "DELETE" }); go("#/invoices"); }} onDone={() => setModal("")} />}
      {modal === "voidpay" && <Confirm text={`Void this ${fmt(target.amount_cents)} payment? A reversing entry is posted.`} label="Void payment" action={() => api(`/payments/${target.id}/void`, { method: "POST" })} onDone={refresh} />}
    </>
  );
}

/** Record money received and apply it to one or more open invoices. Anything left over is held as customer credit. */
export function PaymentModal({ invoice, onClose, onSaved }: { invoice?: any; onClose: () => void; onSaved: () => void }) {
  const { boot } = useBoot();
  const { data: all } = useLoad<any[]>("/invoices");
  const [customerId, setCustomerId] = useState<number | "">(invoice?.customer_id ?? "");
  const [date, setDate] = useState(boot.today);
  const [amount, setAmount] = useState(invoice ? moneyText(invoice.balance_cents) : "");
  const [method, setMethod] = useState("check");
  const checking = boot.accounts.find((a) => a.number === "1010")!.id;
  const [accountId, setAccountId] = useState<number | "">(checking);
  const [reference, setReference] = useState("");
  const [applied, setApplied] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState(false);
  const [run, busy, error] = useAction();

  const open = useMemo(() => (all ?? []).filter((i) => i.customer_id === customerId && i.status === "sent" && i.balance_cents > 0)
    .sort((a, b) => (invoice && a.id === invoice.id ? -1 : invoice && b.id === invoice.id ? 1 : a.due_date < b.due_date ? -1 : 1)), [all, customerId, invoice]);
  const cents = parseMoney(amount) ?? 0;
  // Until the owner edits the boxes, fill invoices oldest first.
  const auto = useMemo(() => { let left = cents; const out: Record<number, string> = {}; for (const i of open) { const a = Math.min(left, i.balance_cents); if (a > 0) out[i.id] = moneyText(a); left -= a; } return out; }, [open, cents]);
  const boxes = touched ? applied : auto;
  const appliedTotal = open.reduce((a, i) => a + (parseMoney(boxes[i.id] ?? "") ?? 0), 0);
  const customers = boot.customers.filter((c) => !c.archived);

  const save = () => run(async () => {
    if (customerId === "" || accountId === "") throw new Error("Pick a customer and a deposit account.");
    if (!cents) throw new Error("Enter the amount received.");
    await api("/payments", { body: { customerId, date, amountCents: cents, method, depositAccountId: accountId, reference,
      applications: open.map((i) => ({ invoiceId: i.id, amountCents: parseMoney(boxes[i.id] ?? "") ?? 0 })).filter((a) => a.amountCents > 0) } });
    onSaved();
  });

  return (
    <Modal title="Record payment" onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid">
        <Field label="Customer" wide>
          <select value={customerId} disabled={!!invoice} onChange={(e) => { setCustomerId(e.target.value ? Number(e.target.value) : ""); setTouched(false); }}>
            <option value="">Choose...</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Date received"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
        <Field label="Method"><select value={method} onChange={(e) => setMethod(e.target.value)}>{["check", "ach", "wire", "card", "cash", "zelle", "venmo", "other"].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Deposited to"><AccountSelect value={accountId} onChange={setAccountId} filter={(a) => (isPayFrom(a) && a.type === "asset") || a.number === "2200"} /></Field>
        <Field label="Reference" hint="Check number, etc." wide><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      {boot.accounts.find((a) => a.id === accountId)?.number === "2200" && <div className="note info" style={{ marginTop: 12 }}>This uses credit the customer already paid you (Customer Deposits). No new money is recorded.</div>}
      {customerId !== "" && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Open invoice</th><th className="num">Balance</th><th className="num" style={{ width: 120 }}>Apply</th></tr></thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.id}><td>{i.number} <span className="muted small">due {niceDate(i.due_date)}</span></td><td className="num">{fmt(i.balance_cents)}</td>
                <td><MoneyInput value={boxes[i.id] ?? ""} onChange={(v) => { setApplied({ ...boxes, [i.id]: v }); setTouched(true); }} /></td></tr>
            ))}
            {open.length === 0 && <tr><td colSpan={3} className="muted">No open invoices. The whole amount will be held as customer credit.</td></tr>}
          </tbody>
        </table>
      )}
      {cents > appliedTotal && customerId !== "" && <p className="small muted">{fmt(cents - appliedTotal)} is not applied and will be held as customer credit (2200 Customer Deposits).</p>}
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save payment</button></div>
    </Modal>
  );
}
