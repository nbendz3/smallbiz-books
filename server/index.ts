// Web server: sign-in, the owner-only API, public invoice links, and the built client.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { openDb, type Db } from "./db.js";
import { apiRoutes, sendError, sendFile, today } from "./routes.js";
import { invoicePdf, loadInvoice, publicInvoiceHtml } from "./pdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = "sbb_session";
const SESSION_DAYS = 30;

const password = () => process.env.APP_PASSWORD ?? "";
const secret = () => process.env.SESSION_SECRET || crypto.createHash("sha256").update("smallbiz-books|" + password()).digest("hex");
const sign = (v: string) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");
const safeEqual = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

function signedIn(req: Request): boolean {
  if (!password()) return false;
  const raw = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}

/** Small in-memory limiter for sign-in attempts and public links. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "?", now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return res.status(429).json({ error: "Too many tries. Wait a few minutes and try again." });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

export function createApp(db: Db) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  // Public, read-only invoice links. A long random token shows exactly one invoice.
  const publicLimit = limiter(60, 5 * 60_000);
  const byToken = async (req: Request) => {
    const token = req.params.token;
    if (!/^[\w-]{24,64}$/.test(token)) return null;
    const d = await db.inTx((tx) => loadInvoice(tx, { token }, today()));
    return d && d.inv.status !== "draft" ? d : null;
  };
  app.get("/i/:token", publicLimit, (req, res) => {
    byToken(req).then((d) => (d ? res.type("html").send(publicInvoiceHtml(d)) : res.status(404).type("text").send("Invoice not found."))).catch((e) => sendError(res, e));
  });
  app.get("/i/:token/pdf", publicLimit, (req, res) => {
    byToken(req).then(async (d) => (d ? sendFile(res, await invoicePdf(d), "application/pdf", `${d.inv.number}.pdf`, true) : res.status(404).type("text").send("Invoice not found."))).catch((e) => sendError(res, e));
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: "6mb" }));
  // Changes must come from this site itself (blocks cross-site form tricks).
  api.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Request blocked." }); }
      catch { return res.status(403).json({ error: "Request blocked." }); }
    }
    next();
  });
  api.get("/session", (req, res) => res.json({ configured: !!password(), signedIn: signedIn(req) }));
  api.post("/login", limiter(10, 15 * 60_000), (req, res) => {
    if (!password()) return res.status(503).json({ error: "Set APP_PASSWORD in Secrets first." });
    if (typeof req.body?.password !== "string" || !safeEqual(req.body.password, password())) return res.status(401).json({ error: "Wrong password." });
    const exp = String(Date.now() + SESSION_DAYS * 86400_000);
    // SameSite=None lets the Replit preview pane (an embedded frame) keep you signed in; it requires Secure.
    const https = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Max-Age=${SESSION_DAYS * 86400}; ${https ? "SameSite=None; Secure" : "SameSite=Lax"}`);
    res.json({ ok: true });
  });
  api.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });
  // Everything below this line requires the owner to be signed in.
  api.use((req, res, next) => {
    if (!password()) return res.status(503).json({ error: "Set APP_PASSWORD in Secrets first." });
    if (!signedIn(req)) return res.status(401).json({ error: "Please sign in." });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use(apiRoutes(db));
  api.use((_req, res) => res.status(404).json({ error: "Not found." }));
  app.use("/api", api);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, err));

  const dist = path.join(here, "..", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(dist, "index.html")); });
  } else {
    app.get("*", (_req, res) => res.type("text").send("The screens have not been built yet. Run: npm run build"));
  }
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env.REPLIT_DEPLOYMENT && !process.env.DATABASE_URL) {
    // A published app has no lasting disk, so the built-in file database would lose your records.
    console.error("DATABASE_URL is not set. Add a PostgreSQL database to this Replit App (Database tool), then publish again.");
    process.exit(1);
  }
  const db = await openDb();
  const port = Number(process.env.PORT) || 5000;
  createApp(db).listen(port, "0.0.0.0", () => {
    console.log(`Small Business Books is running on port ${port} (${db.kind === "postgres" ? "PostgreSQL" : "built-in file database - set DATABASE_URL before publishing"}).`);
    if (!password()) console.log("APP_PASSWORD is not set. Add it in Secrets, then restart, to sign in.");
  });
}
