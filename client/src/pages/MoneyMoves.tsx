import { useState } from "react";
import { api, fmt, niceDate, parseMoney } from "../api";
import { AccountSelect, Confirm, Cpa, ErrorNote, Field, isIncome, isPayFrom, Loading, MoneyInput, Pill, useAction, useBoot, useLoad } from "../ui";

const KINDS: Record<string, { label: string; help: string; a: string; b?: string }> = {
  owner_contribution: { label: "I put money into the business", help: "Not income. It increases your equity.", a: "Deposited to" },
  owner_draw: { label: "I took money out for myself", help: "Not an expense and not deductible. This is how a sole proprietor gets paid.", a: "Taken from" },
  transfer: { label: "Transfer between accounts / pay the card bill", help: "Moving money between your own accounts is never income or expense.", a: "From", b: "To" },
  other_income: { label: "Deposit that is not from an invoice", help: "A cash sale, interest, or a refund of income. For invoice payments use Invoices instead.", a: "Deposited to", b: "Income type" },
  opening_balance: { label: "Opening balance", help: "The balance an account already had on the day you started using this app.", a: "Account" },
  sales_tax_remit: { label: "Paid sales tax to the state", help: "Clears Sales Tax Payable (2060).", a: "Paid from" },
  adjustment: { label: "Adjustment from my CPA", help: "For year-end entries such as depreciation (debit 6050, credit 1700). Only use this when your CPA gives you the entry.", a: "Debit", b: "Credit" },
};

export function MoneyMoves() {
  const { boot } = useBoot();
  const { data, error, reload } = useLoad<any[]>("/moves");
  const [kind, setKind] = useState("owner_draw");
  const [date, setDate] = useState(boot.today);
  const [amount, setAmount] = useState("");
  const [a, setA] = useState<number | "">(boot.accounts.find((x) => x.number === "1010")!.id);
  const [b, setB] = useState<number | "">("");
  const [memo, setMemo] = useState("");
  const [voiding, setVoiding] = useState<any>(null);
  const [run, busy, saveError] = useAction();
  const k = KINDS[kind];
  const any = () => true;
  const filterA = kind === "adjustment" ? any : isPayFrom;
  const filterB = kind === "other_income" ? isIncome : kind === "adjustment" ? any : isPayFrom;

  const save = () => run(async () => {
    const cents = parseMoney(amount);
    if (!cents) throw new Error("Enter an amount.");
    if (a === "" || (k.b && b === "")) throw new Error("Pick the account" + (k.b ? "s." : "."));
    await api("/moves", { body: { kind, date, amountCents: cents, memo, accountId: a, otherAccountId: k.b ? b : undefined } });
    setAmount(""); setMemo(""); reload();
  });

  return (
    <>
      <div className="head"><h1>Owner & Transfers</h1></div>
      <div className="card">
        <ErrorNote>{saveError}</ErrorNote>
        <div className="grid">
          <Field label="What happened?" hint={k.help} wide><select value={kind} onChange={(e) => { setKind(e.target.value); setB(""); if (e.target.value === "adjustment") setA(""); }}>{Object.entries(KINDS).map(([v, x]) => <option key={v} value={v}>{x.label}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
          <Field label={k.a}><AccountSelect value={a} onChange={setA} filter={filterA} empty="Choose..." /></Field>
          {k.b && <Field label={k.b}><AccountSelect value={b} onChange={setB} filter={(x) => filterB(x) && x.id !== a} empty="Choose..." /></Field>}
          <Field label={kind === "adjustment" ? "Why (required)" : "Note"} wide><input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        </div>
        <div className="row end"><button className="btn primary" disabled={busy} onClick={save}>Post</button></div>
        {kind === "sales_tax_remit" || kind === "adjustment" || kind === "owner_draw" ? <Cpa /> : null}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <Loading /> : (
        <div className="card flush scroll"><table>
          <thead><tr><th>Date</th><th>What</th><th className="hide-sm">Debit</th><th className="hide-sm">Credit</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id} className={m.voided ? "off" : ""}><td>{niceDate(m.move_date)}</td><td>{KINDS[m.kind]?.label ?? m.kind}{m.memo ? <div className="muted small">{m.memo}</div> : null}</td>
                <td className="hide-sm">{m.debit_name}</td><td className="hide-sm">{m.credit_name}</td><td className="num">{fmt(m.amount_cents)}</td>
                <td className="num">{m.voided ? <Pill>Voided</Pill> : <button className="btn sm ghost" onClick={() => setVoiding(m)}>Void</button>}</td></tr>
            ))}
            {data.length === 0 && <tr><td colSpan={6} className="empty">Nothing here yet. Start by entering each bank account's opening balance.</td></tr>}
          </tbody>
        </table></div>
      )}
      {voiding && <Confirm text={`Void this ${fmt(voiding.amount_cents)} entry? A reversing entry is posted.`} label="Void" action={() => api(`/moves/${voiding.id}/void`, { method: "POST" })} onDone={() => { setVoiding(null); reload(); }} />}
    </>
  );
}
