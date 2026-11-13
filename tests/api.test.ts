// Every API route must refuse a visitor who is not signed in.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../server/db.js";
import { createApp } from "../server/index.js";
import { apiRoutes } from "../server/routes.js";

let db: Db, base = "", close = () => {};
beforeAll(async () => {
  process.env.APP_PASSWORD = "example-password-for-tests";
  db = await openDb({ memory: true });
  const server = createApp(db).listen(0);
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  close = () => server.close();
});
afterAll(() => close());

describe("sign-in guard", () => {
  it("refuses every API route without a session", async () => {
    const routes = (apiRoutes(db) as any).stack.filter((l: any) => l.route).flatMap((l: any) => Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route.path as string]));
    expect(routes.length).toBeGreaterThan(40);
    for (const [method, path] of routes) {
      const res = await fetch(base + "/api" + path.replace(/:\w+/g, "1"), { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });
  it("signs in with the password, rejects a wrong one and a forged cookie", async () => {
    expect((await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status).toBe(401);
    expect((await fetch(base + "/api/bootstrap", { headers: { cookie: `sbb_session=${Date.now() + 1e9}.forged` } })).status).toBe(401);
    const ok = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "example-password-for-tests" }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect((await fetch(base + "/api/bootstrap", { headers: { cookie } })).status).toBe(200);
    expect((await fetch(base + "/api/moves", { method: "POST", headers: { cookie, origin: "https://elsewhere.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });
  it("public invoice links show only issued invoices and nothing else", async () => {
    expect((await fetch(base + "/i/" + "a".repeat(32))).status).toBe(404);
    expect((await fetch(base + "/i/short")).status).toBe(404);
  });
});
