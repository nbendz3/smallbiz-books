// Invoice PDF (pdfkit) and the public read-only invoice page.
import PDFDocument from "pdfkit";
import type { Tx } from "./db.js";
import { dollars } from "./money.js";
import { INVOICE_LIST_SQL } from "./reports.js";

export async function loadInvoice(tx: Tx, where: { id?: number; token?: string }, today: string) {
  const inv = (await tx.q(`SELECT * FROM (${INVOICE_LIST_SQL}) x WHERE ($2::int IS NOT NULL AND id = $2::int) OR ($3::text IS NOT NULL AND public_token = $3::text)`,
    [today, where.id ?? null, where.token ?? null]))[0];
  if (!inv) return null;
  const lines = await tx.q(`SELECT l.*, a.number AS account_number, a.name AS account_name FROM invoice_lines l JOIN accounts a ON a.id = l.account_id WHERE l.invoice_id = $1 ORDER BY l.position, l.id`, [inv.id]);
  const cust = (await tx.q("SELECT * FROM customers WHERE id = $1", [inv.customer_id]))[0];
  const settings = (await tx.q("SELECT * FROM settings WHERE id = 1"))[0];
  return { inv, lines, cust, settings };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadInvoice>>>;

const qty = (x100: number) => (x100 % 100 === 0 ? String(x100 / 100) : (x100 / 100).toFixed(2));
const rate = (x1000: number) => (x1000 / 1000).toString() + "%";
const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export function invoicePdf({ inv, lines, cust, settings }: Loaded): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const L = 54, R = 558, W = R - L;
    const ink = "#1c2430", soft = "#667085";

    doc.fillColor(ink).font("Helvetica-Bold").fontSize(16).text(settings.business_name, L, 54, { width: 300 });
    doc.font("Helvetica").fontSize(9).fillColor(soft).text([settings.address, settings.phone, settings.email].filter(Boolean).join("\n"), { width: 300 });
    doc.font("Helvetica-Bold").fontSize(22).fillColor(ink).text(inv.status === "draft" ? "DRAFT" : "INVOICE", L, 54, { width: W, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(soft).text(inv.number ?? "not yet issued", L, 82, { width: W, align: "right" });
    if (inv.status === "void") doc.font("Helvetica-Bold").fontSize(12).fillColor("#b42318").text("VOID", L, 98, { width: W, align: "right" });

    let y = Math.max(doc.y, 130) + 16;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(soft).text("BILL TO", L, y);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(ink).text(cust.name, L, y + 12, { width: 280 });
    doc.font("Helvetica").fontSize(9).fillColor(soft).text([cust.address, cust.email].filter(Boolean).join("\n"), { width: 280 });
    const afterBill = doc.y;
    const meta: [string, string][] = [["Invoice date", longDate(inv.issue_date)], ["Due date", longDate(inv.due_date)], ["Balance due", dollars(inv.balance_cents)]];
    meta.forEach(([k, v], i) => {
      doc.font("Helvetica").fontSize(9).fillColor(soft).text(k, 360, y + i * 15, { width: 90 });
      doc.font("Helvetica-Bold").fillColor(ink).text(v, 450, y + i * 15, { width: R - 450, align: "right" });
    });

    y = Math.max(afterBill, y + 50) + 22;
    const cols = { desc: L, qty: 330, price: 390, amt: 475 };
    const head = () => {
      doc.rect(L, y, W, 20).fill("#f2f4f7");
      doc.font("Helvetica-Bold").fontSize(8).fillColor(soft);
      doc.text("DESCRIPTION", cols.desc + 6, y + 6);
      doc.text("QTY", cols.qty, y + 6, { width: 50, align: "right" });
      doc.text("PRICE", cols.price, y + 6, { width: 75, align: "right" });
      doc.text("AMOUNT", cols.amt, y + 6, { width: R - cols.amt - 6, align: "right" });
      y += 26;
    };
    head();
    for (const l of lines) {
      doc.font("Helvetica").fontSize(10);
      const h = Math.max(doc.heightOfString(l.description || " ", { width: 260 }), 12);
      if (y + h > 700) { doc.addPage(); y = 54; head(); }
      doc.fillColor(ink).font("Helvetica").fontSize(10).text(l.description || " ", cols.desc + 6, y, { width: 260 });
      doc.text(qty(l.qty_x100), cols.qty, y, { width: 50, align: "right" });
      doc.text(dollars(l.unit_price_cents), cols.price, y, { width: 75, align: "right" });
      doc.text(dollars(l.amount_cents), cols.amt, y, { width: R - cols.amt - 6, align: "right" });
      y += h + 8;
      doc.moveTo(L, y - 4).lineTo(R, y - 4).strokeColor("#e4e7ec").lineWidth(0.5).stroke();
    }
    if (y > 620) { doc.addPage(); y = 54; }
    y += 8;
    const total = (k: string, v: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10).fillColor(bold ? ink : soft).text(k, 360, y, { width: 110 });
      doc.fillColor(ink).text(v, 450, y, { width: R - 456, align: "right" });
      y += bold ? 20 : 16;
    };
    total("Subtotal", dollars(inv.subtotal_cents));
    if (inv.tax_cents > 0) total(`Sales tax (${rate(inv.tax_rate_x1000)})`, dollars(inv.tax_cents));
    total("Total", dollars(inv.total_cents), true);
    if (inv.paid_cents > 0) total("Amount paid", "-" + dollars(inv.paid_cents));
    doc.rect(354, y - 2, R - 354, 26).fill("#1c2430");
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff").text("Balance due", 360, y + 6, { width: 110 });
    doc.text(dollars(inv.balance_cents), 450, y + 6, { width: R - 456, align: "right" });
    y += 44;
    const block = (title: string, body: string) => {
      if (!body) return;
      if (y > 680) { doc.addPage(); y = 54; }
      doc.font("Helvetica-Bold").fontSize(8).fillColor(soft).text(title, L, y);
      doc.font("Helvetica").fontSize(9).fillColor(ink).text(body, L, y + 12, { width: W });
      y = doc.y + 14;
    };
    block("NOTES", inv.notes);
    block("HOW TO PAY", settings.invoice_footer);
    doc.end();
  });
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page a customer sees at /i/<token>. Shows only that one invoice. */
export function publicInvoiceHtml({ inv, lines, cust, settings }: Loaded): string {
  const row = (l: any) => `<tr><td>${esc(l.description)}</td><td class="n">${qty(l.qty_x100)}</td><td class="n">${dollars(l.unit_price_cents)}</td><td class="n">${dollars(l.amount_cents)}</td></tr>`;
  const paid = inv.display_status === "Paid";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Invoice ${esc(inv.number)} from ${esc(settings.business_name)}</title>
<style>
body{margin:0;background:#f2f4f7;color:#1c2430;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:24px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(16,24,40,.12)}
h1{font-size:20px;margin:0}.soft{color:#667085;font-size:13px;white-space:pre-line}.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;background:${paid ? "#d1fadf" : inv.display_status === "Overdue" ? "#fee4e2" : "#e0eaff"};color:${paid ? "#05603a" : inv.display_status === "Overdue" ? "#b42318" : "#2d3fa8"}}
table{width:100%;border-collapse:collapse;margin:22px 0 8px}th{font-size:11px;letter-spacing:.05em;color:#667085;text-align:left;background:#f2f4f7;padding:8px}td{padding:10px 8px;border-bottom:1px solid #e4e7ec;vertical-align:top}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.tot{margin-left:auto;max-width:300px}.tot div{display:flex;justify-content:space-between;padding:4px 8px}
.due{background:#1c2430;color:#fff;border-radius:6px;font-weight:700;padding:9px 8px!important;margin-top:6px}
.btn{display:inline-block;margin-top:18px;padding:10px 16px;border-radius:8px;background:#1c2430;color:#fff;text-decoration:none;font-weight:600}
@media print{body{background:#fff}main{box-shadow:none;margin:0}.btn{display:none}}
</style></head><body><main>
<div class="top"><div><h1>${esc(settings.business_name)}</h1><div class="soft">${esc([settings.address, settings.phone, settings.email].filter(Boolean).join("\n"))}</div></div>
<div style="text-align:right"><h1>Invoice ${esc(inv.number)}</h1><span class="pill">${esc(inv.display_status)}</span></div></div>
<div class="top" style="margin-top:22px"><div><div class="soft">BILL TO</div><strong>${esc(cust.name)}</strong><div class="soft">${esc(cust.address)}</div></div>
<div class="soft" style="text-align:right">Invoice date: ${longDate(inv.issue_date)}\nDue date: ${longDate(inv.due_date)}</div></div>
<table><thead><tr><th>DESCRIPTION</th><th class="n">QTY</th><th class="n">PRICE</th><th class="n">AMOUNT</th></tr></thead><tbody>${lines.map(row).join("")}</tbody></table>
<div class="tot"><div><span>Subtotal</span><span class="n">${dollars(inv.subtotal_cents)}</span></div>
${inv.tax_cents > 0 ? `<div><span>Sales tax (${rate(inv.tax_rate_x1000)})</span><span class="n">${dollars(inv.tax_cents)}</span></div>` : ""}
<div><strong>Total</strong><strong class="n">${dollars(inv.total_cents)}</strong></div>
${inv.paid_cents > 0 ? `<div><span>Paid</span><span class="n">-${dollars(inv.paid_cents)}</span></div>` : ""}
<div class="due"><span>Balance due</span><span class="n">${dollars(inv.balance_cents)}</span></div></div>
${inv.notes ? `<p class="soft"><strong>Notes</strong>\n${esc(inv.notes)}</p>` : ""}
${settings.invoice_footer ? `<p class="soft"><strong>How to pay</strong>\n${esc(settings.invoice_footer)}</p>` : ""}
<a class="btn" href="/i/${esc(inv.public_token)}/pdf">Download PDF</a>
</main></body></html>`;
}
