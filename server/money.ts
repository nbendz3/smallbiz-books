// Money helpers. Everything is integer cents; there is no floating point money anywhere.

/** Divide two non-negative integers, rounding half up. */
export function roundDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0 || n < 0) throw new Error("roundDiv: bad input");
  return Math.floor((2 * n + d) / (2 * d));
}

/** quantity is stored x100 (1.5 hours = 150). */
export function lineAmount(qtyX100: number, unitPriceCents: number): number {
  return roundDiv(qtyX100 * unitPriceCents, 100);
}

/** rate is stored x1000 (7.25% = 7250). */
export function taxFor(amountCents: number, rateX1000: number): number {
  return roundDiv(amountCents * rateX1000, 100000);
}

export function pctOf(amountCents: number, pct: number): number {
  return roundDiv(amountCents * pct, 100);
}

/** miles x10 (12.4 miles = 124), rate in tenths of a cent (72.5 cents = 725). */
export function mileageDeduction(milesX10: number, rateTenthCents: number): number {
  return roundDiv(milesX10 * rateTenthCents, 100);
}

/**
 * Split `total` across `weights` in proportion, to the exact cent (largest remainder).
 * The parts always add up to `total`, and no part exceeds its weight when total <= sum(weights).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total < 0 || weights.some((w) => w < 0)) throw new Error("allocate: negative input");
  if (sum === 0) {
    if (total !== 0) throw new Error("allocate: nothing to allocate against");
    return weights.map(() => 0);
  }
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i, rem } of order) {
    if (left <= 0) break;
    if (rem === 0) continue;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

export function dollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
  return (neg ? "-$" : "$") + s;
}

/** Plain number for CSV files: 1234.50 */
export function csvMoney(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return (neg ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}
