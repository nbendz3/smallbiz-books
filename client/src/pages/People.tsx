import { useState } from "react";
import { api } from "../api";
import { AccountSelect, Cpa, ErrorNote, Field, isSpend, Modal, Pill, Tabs, useAction, useBoot } from "../ui";

export function People() {
  const { boot, reload } = useBoot();
  const [tab, setTab] = useState<"customers" | "vendors">("customers");
  const [editing, setEditing] = useState<any>(null);
  const rows = tab === "customers" ? boot.customers : boot.vendors;
  const blank = tab === "customers" ? { name: "", email: "", phone: "", address: "", tax_exempt: false, notes: "", archived: false }
    : { name: "", email: "", address: "", is_1099: false, has_w9: false, tax_id_last4: "", default_account_id: null, archived: false };
  return (
    <>
      <div className="head"><h1>Customers & Vendors</h1><button className="btn primary" onClick={() => setEditing(blank)}>{tab === "customers" ? "New customer" : "New vendor"}</button></div>
      <Tabs value={tab} onChange={setTab} options={[["customers", "Customers (you bill them)"], ["vendors", "Vendors (you pay them)"]]} />
      <div className="card flush scroll"><table>
        <thead><tr><th>Name</th><th>Email</th>{tab === "customers" ? <th className="hide-sm">Phone</th> : <th>1099</th>}<th /></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="click" onClick={() => setEditing(p)}>
              <td>{p.name} {p.archived && <Pill>Archived</Pill>}</td><td>{p.email}</td>
              {tab === "customers" ? <td className="hide-sm">{p.phone}</td> : <td>{p.is_1099 ? (p.has_w9 ? <Pill>W-9 on file</Pill> : <span className="pill warn">Needs W-9</span>) : ""}</td>}
              <td className="num"><button className="btn sm ghost">Edit</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="empty">None yet.</td></tr>}
        </tbody>
      </table></div>
      {editing && <PersonForm kind={tab} person={editing} onClose={() => setEditing(null)} onSaved={async () => { await reload(); setEditing(null); }} />}
    </>
  );
}

function PersonForm({ kind, person, onClose, onSaved }: { kind: "customers" | "vendors"; person: any; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState({ ...person });
  const [run, busy, error] = useAction();
  const set = (k: string, v: any) => setP({ ...p, [k]: v });
  const save = () => run(async () => {
    if (!p.name.trim()) throw new Error("Enter a name.");
    await api(person.id ? `/${kind}/${person.id}` : `/${kind}`, { method: person.id ? "PUT" : "POST", body: p });
    onSaved();
  });
  return (
    <Modal title={(person.id ? "Edit " : "New ") + (kind === "customers" ? "customer" : "vendor")} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid">
        <Field label="Name" wide><input autoFocus value={p.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Email"><input type="email" value={p.email} onChange={(e) => set("email", e.target.value)} /></Field>
        {kind === "customers" && <Field label="Phone"><input value={p.phone} onChange={(e) => set("phone", e.target.value)} /></Field>}
        <Field label="Address" wide><textarea value={p.address} onChange={(e) => set("address", e.target.value)} /></Field>
        {kind === "customers" ? (
          <>
            <label className="check field wide"><input type="checkbox" checked={p.tax_exempt} onChange={(e) => set("tax_exempt", e.target.checked)} /> Exempt from sales tax (keep their certificate on file)</label>
            <Field label="Private notes" wide><textarea value={p.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="Usual category" wide><AccountSelect value={p.default_account_id ?? ""} onChange={(v) => set("default_account_id", v === "" ? null : v)} filter={isSpend} empty="None" /></Field>
            <label className="check field wide"><input type="checkbox" checked={p.is_1099} onChange={(e) => set("is_1099", e.target.checked)} /> Contractor who may need a 1099</label>
            {p.is_1099 && <>
              <label className="check field"><input type="checkbox" checked={p.has_w9} onChange={(e) => set("has_w9", e.target.checked)} /> I have their W-9 on file</label>
              <Field label="Tax ID, last 4 digits only"><input inputMode="numeric" maxLength={4} value={p.tax_id_last4} onChange={(e) => set("tax_id_last4", e.target.value.replace(/\D/g, ""))} /></Field>
              <div className="field wide"><Cpa>Never type a full SSN or EIN here. Keep the W-9 itself somewhere private.</Cpa></div>
            </>}
          </>
        )}
        {person.id && <label className="check field wide"><input type="checkbox" checked={p.archived} onChange={(e) => set("archived", e.target.checked)} /> Archived (hidden from pick lists)</label>}
      </div>
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
    </Modal>
  );
}
