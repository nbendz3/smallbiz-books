import { useState } from "react";
import { api, fmt, niceDate, parseScaled } from "../api";
import { Confirm, Cpa, ErrorNote, Field, Loading, useAction, useBoot, useLoad } from "../ui";

export function Mileage() {
  const { boot } = useBoot();
  const { data, error, reload } = useLoad<any[]>("/mileage");
  const [date, setDate] = useState(boot.today);
  const [miles, setMiles] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [purpose, setPurpose] = useState("");
  const [odometer, setOdometer] = useState("");
  const [removing, setRemoving] = useState<any>(null);
  const [run, busy, saveError] = useAction();
  const rate = boot.mileageRates.find((r) => r.effective_date <= date);
  const year = boot.today.slice(0, 4);
  const thisYear = (data ?? []).filter((t) => t.trip_date.startsWith(year));

  const save = () => run(async () => {
    const m = parseScaled(miles, 10);
    if (!m) throw new Error("Enter the miles driven, like 12.4");
    await api("/mileage", { body: { date, milesX10: m, from, to, purpose, odometer: odometer ? Number(odometer) : null } });
    setMiles(""); setPurpose(""); setFrom(""); setTo(""); setOdometer(""); reload();
  });

  return (
    <>
      <div className="head"><h1>Mileage</h1></div>
      <div className="cards">
        <div className="stat"><div className="k">Miles in {year}</div><div className="v">{(thisYear.reduce((a, t) => a + t.miles_x10, 0) / 10).toFixed(1)}</div></div>
        <div className="stat"><div className="k">Deduction in {year}</div><div className="v">{fmt(thisYear.reduce((a, t) => a + t.deduction_cents, 0))}</div></div>
        <div className="stat"><div className="k">Rate on {niceDate(date)}</div><div className="v">{rate ? rate.rate_tenth_cents / 10 + "¢" : "none"}</div><div className="s">per mile</div></div>
      </div>
      <div className="card">
        <h2>Log a business trip</h2>
        <ErrorNote>{saveError}</ErrorNote>
        <div className="grid" style={{ marginTop: 10 }}>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Miles"><input className="num" inputMode="decimal" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="12.4" /></Field>
          <Field label="From"><input value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Business purpose (required)" wide><input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Client meeting, supply run..." /></Field>
          <Field label="Odometer (optional)"><input inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
        <div className="row end"><button className="btn primary" disabled={busy} onClick={save}>Save trip</button></div>
        <Cpa>Uses the IRS standard mileage rate for the trip date. Commuting from home to your regular workplace does not count. Standard mileage versus actual car expenses is a choice to make with your CPA.</Cpa>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <Loading /> : (
        <div className="card flush scroll"><table>
          <thead><tr><th>Date</th><th>Trip</th><th>Purpose</th><th className="num">Miles</th><th className="num">Deduction</th><th /></tr></thead>
          <tbody>
            {data.map((t) => <tr key={t.id}><td>{niceDate(t.trip_date)}</td><td>{[t.from_place, t.to_place].filter(Boolean).join(" to ")}</td><td>{t.purpose}</td><td className="num">{(t.miles_x10 / 10).toFixed(1)}</td><td className="num">{fmt(t.deduction_cents)}</td>
              <td className="num"><button className="btn sm ghost" onClick={() => setRemoving(t)}>Remove</button></td></tr>)}
            {data.length === 0 && <tr><td colSpan={6} className="empty">No trips logged yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      {removing && <Confirm text="Remove this trip? A reversing entry is posted." label="Remove trip" action={() => api(`/mileage/${removing.id}/void`, { method: "POST" })} onDone={() => { setRemoving(null); reload(); }} />}
    </>
  );
}
