// Bank CSV import: parsing, duplicate-proof fingerprints, and match suggestions.
// Imported lines post NOTHING. They wait in the inbox until the owner picks what each one is.
import { createHash } from "node:crypto";
import { UserError, type Tx } from "./db.js";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface Mapping { date: number; description: number; amount?: number; debit?: number; credit?: number; flip?: boolean }

export function detectMapping(header: string[]): Mapping | null {
  const h = header.map((x) => x.trim().toLowerCase());
  const find = (...pats: RegExp[]) => { for (const p of pats) { const i = h.findIndex((x) => p.test(x)); if (i >= 0) return i; } return -1; };
  const date = find(/^(transaction |trans\.? |posting |posted |post )?date$/, /date/);
  const description = find(/^description$/, /description|memo|payee|name|details/);
  const amount = find(/^amount$/, /amount/);
  const debit = find(/^debit$/, /debit|withdrawal|money out/);
  const credit = find(/^credit$/, /credit|deposit|money in/);
  if (date < 0 || description < 0) return null;
  if (debit >= 0 && credit >= 0) return { date, description, debit, credit };
  if (amount >= 0) return { date, description, amount };
  return null;
}

export function parseDate(v: string): string | null {
  const t = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "$1,234.56", "(45.10)", "-45.1" -> integer cents. Works on the digits, never on floats. */
export function parseAmount(v: string): number | null {
  let t = v.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$,\s]/g, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); } else if (t.startsWith("+")) t = t.slice(1);
  const m = /^(\d*)(?:\.(\d{0,2})\d*)?$/.exec(t);
  if (!m || (m[1] === "" && !m[2])) return null;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] || "").padEnd(2, "0"));
  return neg ? -cents : cents;
}

export interface BankLine { date: string; description: string; amountCents: number }

export function parseBankCsv(text: string, mapping?: Mapping | null): { header: string[]; mapping: Mapping | null; lines: BankLine[]; skipped: number } {
  const rows = parseCsv(text);
  if (!rows.length) throw new UserError("That file is empty.");
  const header = rows[0];
  const map = mapping ?? detectMapping(header);
  if (!map) return { header, mapping: null, lines: [], skipped: 0 };
  const lines: BankLine[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const date = parseDate(r[map.date] ?? "");
    let amt: number | null;
    if (map.amount !== undefined) amt = parseAmount(r[map.amount] ?? "");
    else {
      const out = parseAmount(r[map.debit!] ?? ""), inn = parseAmount(r[map.credit!] ?? "");
      amt = out === null && inn === null ? null : Math.abs(inn ?? 0) - Math.abs(out ?? 0);
    }
    if (!date || amt === null || amt === 0) { skipped++; continue; }
    lines.push({ date, description: (r[map.description] ?? "").trim().replace(/\s+/g, " "), amountCents: map.flip ? -amt : amt });
  }
  return { header, mapping: map, lines, skipped };
}

/** Same account + date + amount + text + "nth identical line in the file" => same fingerprint, so re-imports are skipped. */
export function fingerprints(accountId: number, lines: BankLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = `${accountId}|${l.date}|${l.amountCents}|${l.description.toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(base + "|" + n).digest("hex");
  });
}

export async function importLines(tx: Tx, accountId: number, lines: BankLine[]): Promise<{ imported: number; duplicates: number }> {
  const fps = fingerprints(accountId, lines);
  let imported = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const r = await tx.q(
      `INSERT INTO bank_transactions (account_id, txn_date, description, amount_cents, fingerprint) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fingerprint) DO NOTHING RETURNING id`, [accountId, l.date, l.description, l.amountCents, fps[i]]);
    if (r[0]) imported++;
  }
  return { imported, duplicates: lines.length - imported };
}

export interface Suggestion { action: "invoice" | "bill" | "link"; id: number; ref?: string; label: string; score: number; reason: string }

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const nameHit = (desc: string, name: string) => { const d = new Set(words(desc)); return words(name).some((w) => d.has(w)); };
const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/** Up to three guesses for one bank line. Suggestions never post anything by themselves. */
export async function suggest(tx: Tx, t: { id: number; account_id: number; txn_date: string; description: string; amount_cents: number }, today: string): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const used = new Set((await tx.q<{ resolution: string }>("SELECT resolution FROM bank_transactions WHERE status = 'matched'")).map((r) => r.resolution));
  if (t.amount_cents > 0) {
    const pays = await tx.q(`SELECT p.id, p.pay_date, p.reference, c.name FROM payments p JOIN customers c ON c.id = p.customer_id
                              WHERE NOT p.voided AND p.deposit_account_id = $1 AND p.amount_cents = $2`, [t.account_id, t.amount_cents]);
    for (const p of pays) if (!used.has("payment:" + p.id) && dayGap(p.pay_date, t.txn_date) <= 10)
      out.push({ action: "link", id: p.id, ref: "payment:" + p.id, label: `Already recorded: payment from ${p.name} on ${p.pay_date}`, score: 95, reason: "Same amount, same account" });
    const invs = await tx.q(
      `SELECT i.id, i.number, c.name, i.total_cents - COALESCE((SELECT SUM(pa.amount_cents) FROM payment_applications pa JOIN payments pm ON pm.id = pa.payment_id AND NOT pm.voided WHERE pa.invoice_id = i.id),0)::bigint AS balance
         FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status = 'sent'`);
    for (const i of invs) {
      if (i.balance <= 0) continue;
      const hit = nameHit(t.description, i.name) || t.description.toLowerCase().includes(String(i.number).toLowerCase());
      if (i.balance === t.amount_cents) out.push({ action: "invoice", id: i.id, label: `Payment for ${i.number} (${i.name})`, score: hit ? 92 : 80, reason: hit ? "Exact amount and the name matches" : "Exact amount" });
      else if (hit && i.balance > t.amount_cents) out.push({ action: "invoice", id: i.id, label: `Part payment for ${i.number} (${i.name})`, score: 55, reason: "Name matches; amount is less than the balance" });
    }
  } else {
    const amt = -t.amount_cents;
    const exps = await tx.q(`SELECT x.id, x.exp_date, x.paid_date, x.paid_from_account_id, x.description, v.name FROM expenses x LEFT JOIN vendors v ON v.id = x.vendor_id
                              WHERE NOT x.voided AND x.total_cents = $1 AND (x.paid_from_account_id IS NULL OR x.paid_from_account_id = $2)`, [amt, t.account_id]);
    for (const x of exps) {
      const who = x.name || x.description || "expense";
      if (x.paid_from_account_id) {
        if (!used.has("expense:" + x.id) && dayGap(x.paid_date, t.txn_date) <= 10)
          out.push({ action: "link", id: x.id, ref: "expense:" + x.id, label: `Already recorded: ${who} on ${x.paid_date}`, score: 95, reason: "Same amount, same account" });
      } else out.push({ action: "bill", id: x.id, label: `Pays the bill from ${who} (${x.exp_date})`, score: nameHit(t.description, who) ? 92 : 80, reason: "Exact amount of an unpaid bill" });
    }
  }
  void today;
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
