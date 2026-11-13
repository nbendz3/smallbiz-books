// Talking to the server, plus money and date helpers. Money is integer cents everywhere.

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch("/api" + path, {
    method: opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET"),
    credentials: "same-origin",
    headers: opts.raw ? opts.headers : opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("signed-out"));
    throw new ApiError(data.error ?? "Something went wrong.", res.status);
  }
  return data as T;
}

export function fmt(cents: number | null | undefined): string {
  const c = cents ?? 0, abs = Math.abs(c);
  const s = "$" + Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
  return c < 0 ? "-" + s : s;
}

/** "1,234.5" -> 123450. Works on the digits; returns null if it is not a money amount. */
export function parseMoney(v: string): number | null {
  const t = v.replace(/[$,\s]/g, "");
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[1] === "" && !m[2])) return null;
  return Number(m[1] || "0") * 100 + Number((m[2] || "").padEnd(2, "0"));
}
export const moneyText = (cents: number) => (cents / 100).toFixed(2);

/** Same integer math the server uses. */
export const roundDiv = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));
export const lineAmount = (qtyX100: number, unitCents: number) => roundDiv(qtyX100 * unitCents, 100);
export const taxFor = (cents: number, rateX1000: number) => roundDiv(cents * rateX1000, 100000);

/** "1.5" -> 150 (two decimals), "12.4" with scale 10 -> 124. */
export function parseScaled(v: string, scale: 10 | 100 | 1000): number | null {
  const digits = String(scale).length - 1;
  const m = new RegExp(`^(\\d*)(?:\\.(\\d{0,${digits}}))?$`).exec(v.trim());
  if (!m || (m[1] === "" && !m[2])) return null;
  return Number(m[1] || "0") * scale + Number((m[2] || "").padEnd(digits, "0"));
}

export const addDays = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
export const niceDate = (d: string | null | undefined) =>
  d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";

export interface Account { id: number; number: string; name: string; type: string; sched_c_line: string | null; deductible_pct: number; requires_purpose: boolean; pay_from: boolean; system: boolean; active: boolean }
export interface Settings { [k: string]: any; business_name: string; basis: "CASH" | "ACCRUAL"; sales_tax_on: boolean; tax_rate_x1000: number; terms_days: number }
export interface Boot { today: string; settings: Settings; accounts: Account[]; customers: any[]; vendors: any[]; mileageRates: any[]; database: string }
