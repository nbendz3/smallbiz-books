// Shared building blocks for every screen.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, fmt, type Account, type Boot } from "./api";

export const BootCtx = createContext<{ boot: Boot; reload: () => Promise<void> }>(null as any);
export const useBoot = () => useContext(BootCtx);

/** Load data for a screen. Returns the data, any error, and a reload function. */
export function useLoad<T>(path: string | null): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(""); } }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [path, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Run a save/post action with a busy flag and an error message. */
export function useAction(): [(fn: () => Promise<unknown>) => Promise<boolean>, boolean, string, (s: string) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); return true; } catch (e: any) { setError(e.message ?? "Something went wrong."); return false; } finally { setBusy(false); }
  };
  return [run, busy, error, setError];
}

export const ErrorNote = ({ children }: { children: ReactNode }) => (children ? <div className="note bad" role="alert">{children}</div> : null);
export const Loading = () => <div className="muted pad">Loading...</div>;
export const Cpa = ({ children }: { children?: ReactNode }) => <p className="cpa">{children} Confirm with your CPA.</p>;

export function Money({ cents, sign }: { cents: number; sign?: boolean }) {
  return <span className={"num" + (sign && cents < 0 ? " neg" : "")}>{fmt(cents)}</span>;
}

const PILL: Record<string, string> = { Paid: "good", Overdue: "bad", Draft: "plain", Void: "plain", Sent: "info", "Partially paid": "warn", Unpaid: "warn", Voided: "plain" };
export const Pill = ({ children }: { children: string }) => <span className={"pill " + (PILL[children] ?? "plain")}>{children}</span>;

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">Close</button></div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([v, label]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  );
}

export function AccountSelect({ value, onChange, filter, empty, showLine }: { value: number | ""; onChange: (id: number | "") => void; filter: (a: Account) => boolean; empty?: string; showLine?: boolean }) {
  const { boot } = useBoot();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
      {empty !== undefined ? <option value="">{empty}</option> : null}
      {boot.accounts.filter((a) => (a.active || a.id === value) && filter(a)).map((a) => (
        <option key={a.id} value={a.id}>{a.number} {a.name}{showLine && a.sched_c_line ? ` (Sch C line ${a.sched_c_line})` : ""}</option>
      ))}
    </select>
  );
}
export const isPayFrom = (a: Account) => a.pay_from;
export const isSpend = (a: Account) => a.type === "expense" || a.type === "cogs" || (a.type === "asset" && ["1200", "1300", "1500"].includes(a.number));
export const isIncome = (a: Account) => a.type === "income";

export const MoneyInput = ({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) => (
  <input className="num" inputMode="decimal" placeholder="0.00" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))} />
);

/** Ledger entries a source created, so the owner can always see the debits and credits behind a screen. */
export function Entries({ type, id, tick }: { type: string; id: number; tick?: number }) {
  const { data } = useLoad<any[]>(`/entries?type=${type}&id=${id}&t=${tick ?? 0}`);
  if (!data?.length) return null;
  return (
    <details className="entries">
      <summary>Ledger entries ({data.length})</summary>
      {data.map((e) => (
        <table key={e.id} className="mini">
          <caption>{e.entry_date} · {e.memo} · <em>{e.book === "BOTH" ? "both books" : e.book.toLowerCase() + " book"}</em></caption>
          <tbody>{e.lines.map((l: any, i: number) => (
            <tr key={i}><td>{l.number} {l.name}</td><td className="num">{l.debit_cents ? fmt(l.debit_cents) : ""}</td><td className="num">{l.credit_cents ? fmt(l.credit_cents) : ""}</td></tr>
          ))}</tbody>
        </table>
      ))}
    </details>
  );
}

export function Confirm({ text, action, onDone, label = "Yes, do it" }: { text: string; action: () => Promise<unknown>; onDone: () => void; label?: string }) {
  const [run, busy, error] = useAction();
  return (
    <Modal title="Are you sure?" onClose={onDone}>
      <p>{text}</p>
      <ErrorNote>{error}</ErrorNote>
      <div className="row end"><button className="btn" onClick={onDone}>Cancel</button><button className="btn danger" disabled={busy} onClick={async () => (await run(action)) && onDone()}>{label}</button></div>
    </Modal>
  );
}

export const go = (hash: string) => { window.location.hash = hash; };
