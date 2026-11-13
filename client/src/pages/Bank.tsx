import { useRef, useState } from "react";
import { api, fmt, niceDate, parseMoney } from "../api";
import { AccountSelect, ErrorNote, Field, isIncome, isPayFrom, isSpend, Loading, Modal, MoneyInput, Tabs, useAction, useBoot, useLoad } from "../ui";

export function Bank() {
  const [tab, setTab] = useState<"inbox" | "import" | "reconcile">("inbox");
  const inbox = useLoad<any>("/bank");
  return (
    <>
      <div className="head"><h1>Bank</h1></div>
      <Tabs value={tab} onChange={setTab} options={[["inbox", `Inbox${inbox.data?.waiting ? ` (${inbox.data.waiting})` : ""}`], ["import", "Import a statement"], ["reconcile", "Check against statement"]]} />
      {tab === "inbox" && <Inbox {...inbox} />}
      {tab === "import" && <Import onDone={() => { inbox.reload(); setTab("inbox"); }} />}
      {tab === "reconcile" && <Reconcile />}
    </>
  );
}

function Inbox({ data, error, reload }: { data: any; error: string; reload: () => void }) {
  const [sorting, setSorting] = useState<any>(null);
  const [run, busy, actionError] = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  const resolve = (id: number, body: any) => run(() => api(`/bank/${id}/resolve`, { body })).then((ok) => { if (ok) { setSorting(null); reload(); } });
  const group = (title: string, lines: any[]) => lines.length > 0 && (
    <>
      <h2 style={{ margin: "18px 0 8px" }}>{title} <span className="muted small">({lines.length})</span></h2>
      <div className="card flush">
        {lines.map((l) => (
          <div className="bankline" key={l.id}>
            <div className="top"><div><strong>{l.description || "(no description)"}</strong><div className="muted small">{niceDate(l.txn_date)} · {l.account_name}</div></div>
              <div className={"num" + (l.amount_cents < 0 ? " neg" : "")} style={{ fontWeight: 700 }}>{fmt(l.amount_cents)}</div></div>
            <div className="sugg">
              {l.suggestions.map((s: any) => (
                <button key={s.action + s.id} className="btn sm primary" disabled={busy} title={s.reason}
                  onClick={() => resolve(l.id, s.action === "invoice" ? { action: "invoice", invoiceId: s.id } : s.action === "bill" ? { action: "bill", expenseId: s.id } : { action: "link", ref: s.ref })}>{s.label}</button>
              ))}
              <button className="btn sm" onClick={() => setSorting(l)}>{l.suggestions.length ? "Something else" : "Sort this"}</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => resolve(l.id, { action: "ignore" })}>Ignore</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
  return (
    <>
      <ErrorNote>{actionError}</ErrorNote>
      <p className="muted">Imported lines post nothing by themselves. Each one waits here until you say what it is.</p>
      {data.lines.length === 0 && <div className="empty">Nothing to sort. Import a statement to check your books against the bank.</div>}
      {group("Money in", data.lines.filter((l: any) => l.amount_cents > 0))}
      {group("Money out", data.lines.filter((l: any) => l.amount_cents < 0))}
      {data.waiting > data.lines.length && <p className="muted small">Showing the first {data.lines.length} of {data.waiting}.</p>}
      {data.recent.length > 0 && (
        <details className="card" style={{ marginTop: 18 }}><summary><strong>Recently sorted</strong></summary>
          <table className="mini"><tbody>{data.recent.map((l: any) => (
            <tr key={l.id}><td>{niceDate(l.txn_date)}</td><td>{l.description}</td><td className="num">{fmt(l.amount_cents)}</td><td>{l.status === "ignored" ? "ignored" : l.resolution.replace(":", " #")}</td>
              <td>{(l.status === "ignored" || /^(payment|expense):/.test(l.resolution)) && <button className="btn sm ghost" onClick={() => resolve(l.id, { action: "reopen" })}>Put back</button>}</td></tr>
          ))}</tbody></table>
          <p className="hint">To undo a line that created an expense or payment, void that expense or payment, then put the line back.</p>
        </details>
      )}
      {sorting && <Sort line={sorting} busy={busy} error={actionError} onClose={() => setSorting(null)} onPick={(body) => resolve(sorting.id, body)} />}
    </>
  );
}

function Sort({ line, onClose, onPick, busy, error }: { line: any; onClose: () => void; onPick: (body: any) => void; busy: boolean; error: string }) {
  const { boot, reload } = useBoot();
  const isIn = line.amount_cents > 0;
  const [kind, setKind] = useState(isIn ? "income" : "expense");
  const [accountId, setAccountId] = useState<number | "">("");
  const [vendorName, setVendorName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pct, setPct] = useState("100");
  const [method, setMethod] = useState("debit_card");
  const [note, setNote] = useState(line.description);
  const bankAcct = boot.accounts.find((a) => a.id === line.account_id)!;
  const kinds: [string, string][] = isIn
    ? [["income", "Income (not from an invoice)"], ["owner_contribution", "Money I put in (not income)"], ["transfer", "Transfer from another account"]]
    : [["expense", "Business expense"], ["owner_draw", "Money I took out / personal (not an expense)"], ["transfer", bankAcct.type === "liability" ? "Card charge refund / transfer" : "Transfer or card payment"]];
  const submit = async () => {
    if (kind === "expense") {
      const v = boot.vendors.find((x) => x.name.toLowerCase() === vendorName.trim().toLowerCase());
      let vendorId = v?.id ?? null;
      if (!vendorId && vendorName.trim()) vendorId = (await api("/vendors", { body: { name: vendorName.trim(), default_account_id: accountId || null } })).id;
      if (!v && vendorId) reload();
      onPick({ action: "expense", accountId: accountId || undefined, vendorId, description: note, purpose, businessPct: Number(pct) || 0, payMethod: bankAcct.type === "liability" ? "credit_card" : method });
    } else onPick({ action: kind, accountId: accountId || undefined, description: note });
  };
  return (
    <Modal title={`${fmt(line.amount_cents)} · ${niceDate(line.txn_date)}`} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <p className="muted">{line.description} · {line.account_name}</p>
      <div className="grid">
        <Field label="What is this?" wide><select value={kind} onChange={(e) => { setKind(e.target.value); setAccountId(""); }}>{kinds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        {kind === "expense" && <>
          <Field label="Category" wide><AccountSelect value={accountId} onChange={setAccountId} filter={isSpend} empty="Choose..." showLine /></Field>
          <Field label="Vendor"><input list="bank-vendors" value={vendorName} onChange={(e) => setVendorName(e.target.value)} /><datalist id="bank-vendors">{boot.vendors.map((v) => <option key={v.id} value={v.name} />)}</datalist></Field>
          <Field label="Business use %"><input className="num" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))} /></Field>
          {bankAcct.type === "asset" && <Field label="How it was paid"><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="debit_card">Debit card</option><option value="ach">Bank transfer / ACH</option><option value="check">Check</option><option value="other">Other</option></select></Field>}
          <Field label="Business purpose" hint="Required for meals and travel" wide><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        </>}
        {kind === "income" && <Field label="Income type" wide><AccountSelect value={accountId} onChange={setAccountId} filter={(a) => isIncome(a) && a.number !== "4090"} empty="Choose..." /></Field>}
        {kind === "transfer" && <Field label={isIn ? "Came from" : "Went to"} hint="Paying the credit card bill is a transfer to the card, not an expense." wide>
          <AccountSelect value={accountId} onChange={setAccountId} filter={(a) => isPayFrom(a) && a.id !== line.account_id} empty="Choose..." /></Field>}
        <Field label="Note" wide><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {kind === "income" && <p className="hint">If this deposit pays an invoice, close this and record it as a payment on that invoice instead, so the invoice shows as paid.</p>}
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>Post it</button></div>
    </Modal>
  );
}

function Import({ onDone }: { onDone: () => void }) {
  const { boot } = useBoot();
  const [accountId, setAccountId] = useState<number | "">(boot.accounts.find((a) => a.number === "1010")!.id);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [run, busy, error] = useAction();
  const input = useRef<HTMLInputElement>(null);
  const acct = boot.accounts.find((a) => a.id === accountId);

  const load = (t: string, m: any) => run(async () => {
    const p = await api("/bank/preview", { body: { accountId, text: t, mapping: m } });
    if (!p.mapping && !m) { // columns not recognized: start from a first guess the owner can correct
      const guess = { date: 0, description: 1, amount: Math.min(2, p.header.length - 1), flip: false };
      setMapping(guess);
      setPreview({ ...(await api("/bank/preview", { body: { accountId, text: t, mapping: guess } })), mapping: null });
      return;
    }
    setPreview(p);
    setMapping(p.mapping ?? m);
  });
  const pick = async (f: File) => { const t = await f.text(); setText(t); setFileName(f.name); setResult(null); load(t, null); };
  const setMap = (patch: any) => { const m = { ...mapping, ...patch }; setMapping(m); load(text, m); };
  const cols = (preview?.header ?? []).map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>);

  return (
    <div className="card">
      <ErrorNote>{error}</ErrorNote>
      {result && <div className="note good">Imported {result.imported} line{result.imported === 1 ? "" : "s"}; skipped {result.duplicates} already imported{result.skipped ? ` and ${result.skipped} that were not transactions` : ""}. <a href="#" onClick={(e) => { e.preventDefault(); onDone(); }}>Go to the inbox</a></div>}
      <div className="grid">
        <Field label="Which account is this statement for?"><AccountSelect value={accountId} onChange={(v) => { setAccountId(v); setPreview(null); setText(""); setFileName(""); }} filter={isPayFrom} /></Field>
        <Field label="CSV file from your bank" hint="Download transactions as CSV from your bank's website. Bank logins are never stored here.">
          <button className="btn" onClick={() => input.current?.click()}>{fileName || "Choose file"}</button>
          <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { if (e.target.files?.[0]) pick(e.target.files[0]); e.target.value = ""; }} />
        </Field>
      </div>
      {preview && mapping && (
        <>
          <h3 style={{ margin: "18px 0 8px" }}>Check before importing</h3>
          {!preview.mapping && <div className="note warn">I could not tell which columns are which. Pick them below.</div>}
          <div className="grid">
            <Field label="Date column"><select value={mapping.date} onChange={(e) => setMap({ date: Number(e.target.value) })}>{cols}</select></Field>
            <Field label="Description column"><select value={mapping.description} onChange={(e) => setMap({ description: Number(e.target.value) })}>{cols}</select></Field>
            {mapping.debit === undefined ? (
              <Field label="Amount column"><select value={mapping.amount ?? 0} onChange={(e) => setMap({ amount: Number(e.target.value) })}>{cols}</select></Field>
            ) : (
              <>
                <Field label="Money out column"><select value={mapping.debit} onChange={(e) => setMap({ debit: Number(e.target.value) })}>{cols}</select></Field>
                <Field label="Money in column"><select value={mapping.credit} onChange={(e) => setMap({ credit: Number(e.target.value) })}>{cols}</select></Field>
              </>
            )}
            <label className="check field"><input type="checkbox" checked={!!mapping.flip} onChange={(e) => setMap({ flip: e.target.checked })} /> Flip the signs {acct?.type === "liability" ? "(many card exports show charges as positive)" : ""}</label>
          </div>
          <p>{preview.count} transactions: <strong>{fmt(preview.moneyIn)}</strong> in, <strong>{fmt(preview.moneyOut)}</strong> out{acct?.type === "liability" ? " (for a card, charges should be money out)" : ""}.</p>
          <table className="mini"><tbody>{preview.sample.map((l: any, i: number) => <tr key={i}><td>{niceDate(l.date)}</td><td>{l.description}</td><td className={"num" + (l.amountCents < 0 ? " neg" : "")}>{fmt(l.amountCents)}</td></tr>)}</tbody></table>
          <div className="row end"><button className="btn primary" disabled={busy || !preview.count} onClick={() => run(async () => { setResult(await api("/bank/import", { body: { accountId, text, mapping } })); setPreview(null); setText(""); setFileName(""); })}>Import {preview.count} lines</button></div>
        </>
      )}
    </div>
  );
}

function Reconcile() {
  const { boot } = useBoot();
  const [accountId, setAccountId] = useState<number | "">(boot.accounts.find((a) => a.number === "1010")!.id);
  const [asOf, setAsOf] = useState(boot.today);
  const [ending, setEnding] = useState("");
  const { data, error } = useLoad<any>(accountId === "" || !asOf ? null : `/bank/reconcile?accountId=${accountId}&asOf=${asOf}`);
  const stmt = parseMoney(ending);
  const diff = data && stmt !== null ? stmt - data.booksBalance : null;
  return (
    <div className="card">
      <p className="muted">Once a month, compare the books to the statement. The goal is a difference of $0.00.</p>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid">
        <Field label="Account"><AccountSelect value={accountId} onChange={setAccountId} filter={isPayFrom} /></Field>
        <Field label="Statement end date"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label={data?.type === "liability" ? "Statement balance owed" : "Statement ending balance"}><MoneyInput value={ending} onChange={setEnding} /></Field>
      </div>
      {data && (
        <table style={{ marginTop: 14, maxWidth: 460 }}><tbody>
          <tr><td>Balance per the books on {niceDate(data.asOf)}</td><td className="num">{fmt(data.booksBalance)}</td></tr>
          {stmt !== null && <tr><td>Statement balance</td><td className="num">{fmt(stmt)}</td></tr>}
          {diff !== null && <tr className="total"><td>Difference</td><td className={"num" + (diff ? " neg" : "")}>{fmt(diff)}</td></tr>}
        </tbody></table>
      )}
      {diff === 0 && <div className="note good" style={{ marginTop: 12 }}>The books agree with the statement.</div>}
      {diff !== null && diff !== 0 && <div className="note warn" style={{ marginTop: 12 }}>Off by {fmt(Math.abs(diff))}. {data.unsortedCount ? `There are ${data.unsortedCount} unsorted bank lines up to this date (net ${fmt(data.unsortedTotal)}); sort those first.` : "Look for a missing or doubled entry, a wrong date, or an opening balance that was never entered (Owner & Transfers)."}</div>}
    </div>
  );
}
