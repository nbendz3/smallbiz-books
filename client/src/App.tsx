import { useCallback, useEffect, useState } from "react";
import { api, type Boot } from "./api";
import { BootCtx, ErrorNote, Field, Loading, useAction } from "./ui";
import { Dashboard } from "./pages/Dashboard";
import { Invoices } from "./pages/Invoices";
import { People } from "./pages/People";
import { Expenses } from "./pages/Expenses";
import { Bank } from "./pages/Bank";
import { Mileage } from "./pages/Mileage";
import { MoneyMoves } from "./pages/MoneyMoves";
import { Reports } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";

const NAV: [string, string][] = [
  ["dashboard", "Dashboard"], ["invoices", "Invoices"], ["expenses", "Expenses & Receipts"], ["bank", "Bank"], ["mileage", "Mileage"],
  ["money", "Owner & Transfers"], ["people", "Customers & Vendors"], ["reports", "Reports"], ["settings", "Settings & Year End"],
];

function useHash(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => { setParts(read()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function App() {
  const [session, setSession] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const parts = useHash();
  const page = parts[0] ?? "dashboard";

  const check = useCallback(() => api("/session").then(setSession).catch((e) => setError(e.message)), []);
  const reload = useCallback(async () => { setBoot(await api<Boot>("/bootstrap")); }, []);
  useEffect(() => { check(); const out = () => { setBoot(null); check(); }; window.addEventListener("signed-out", out); return () => window.removeEventListener("signed-out", out); }, [check]);
  useEffect(() => { if (session?.signedIn) reload().catch((e) => setError(e.message)); }, [session, reload]);
  useEffect(() => {
    setMenu(false);
    if (!session?.signedIn) return;
    api("/dashboard").then((d) => setCounts({ invoices: d.invoices.overdue_count, expenses: d.receiptsWaiting, bank: d.bankUnsorted })).catch(() => {});
  }, [parts.join("/"), session]);

  if (error && !session) return <div className="login"><ErrorNote>{error}</ErrorNote></div>;
  if (!session) return <Loading />;
  if (!session.configured) return <Setup />;
  if (!session.signedIn) return <Login onDone={check} />;
  if (!boot) return <Loading />;

  return (
    <BootCtx.Provider value={{ boot, reload }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">{boot.settings.business_name}<small>Small Business Books</small></div>
          <button className="menu-btn" onClick={() => setMenu(!menu)} aria-expanded={menu}>Menu</button>
          <nav className={"nav" + (menu ? " open" : "")}>
            {NAV.map(([key, label]) => (
              <a key={key} href={"#/" + key} className={page === key ? "on" : ""}>{label}{counts[key] ? <span className="badge">{counts[key]}</span> : null}</a>
            ))}
            <a href="#" onClick={(e) => { e.preventDefault(); api("/logout", { method: "POST" }).then(() => { setBoot(null); check(); }); }}>Sign out</a>
          </nav>
        </aside>
        <main className="main">
          {page === "dashboard" && <Dashboard />}
          {page === "invoices" && <Invoices parts={parts.slice(1)} />}
          {page === "expenses" && <Expenses />}
          {page === "bank" && <Bank />}
          {page === "mileage" && <Mileage />}
          {page === "money" && <MoneyMoves />}
          {page === "people" && <People />}
          {page === "reports" && <Reports parts={parts.slice(1)} />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
    </BootCtx.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [run, busy, error] = useAction();
  return (
    <form className="login card" onSubmit={(e) => { e.preventDefault(); run(() => api("/login", { body: { password } })).then((ok) => ok && onDone()); }}>
      <h1>Small Business Books</h1>
      <p className="muted">Sign in to your books.</p>
      <ErrorNote>{error}</ErrorNote>
      <Field label="Password"><input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <div className="row end"><button className="btn primary" disabled={busy || !password}>Sign in</button></div>
      <p className="hint">If signing in does not stick inside the Replit preview pane, open the app in its own browser tab.</p>
    </form>
  );
}

function Setup() {
  return (
    <div className="login card">
      <h1>One step to finish</h1>
      <p>This app is private to you, so it needs a password before it will open.</p>
      <ol>
        <li>In Replit, open <strong>Secrets</strong> (the lock icon).</li>
        <li>Add a secret named <strong>APP_PASSWORD</strong> with a long password only you know.</li>
        <li>Press <strong>Stop</strong>, then <strong>Run</strong>, and reload this page.</li>
      </ol>
    </div>
  );
}
