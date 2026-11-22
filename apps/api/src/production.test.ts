import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), "brill-web-"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Brill</title>");
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "assets", "app-123.js"), "console.log(1)");
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-f-")), webDir: web, signups: "invite", secureCookies: true });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("production server", () => {
  it("serves the web app, its files, and app routes; the API keeps JSON 404s", async () => {
    const home = await app.inject({ url: "/" });
    expect(home.body).toContain("<title>Brill</title>");
    expect(home.headers["cache-control"]).toBe("no-cache");
    expect(home.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(home.headers["strict-transport-security"]).toBeTruthy();
    const deep = await app.inject({ url: "/base/bseX/tblY?x=1" });
    expect(deep.body).toContain("<title>Brill</title>");
    const asset = await app.inject({ url: "/assets/app-123.js" });
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    const api = await app.inject({ url: "/api/does-not-exist" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "Not found" });
    // No escaping the build folder.
    const sneaky = await app.inject({ url: "/assets/..%2f..%2f..%2fpackage.json" });
    expect(sneaky.body).toContain("<title>Brill</title>");
  });

  it("invite-only sign-up: the first account, then only invited emails", async () => {
    expect((await app.inject({ url: "/api/auth/config" })).json()).toEqual({ signups: "invite", firstAccount: true, emailSending: false });
    const reg = (email: string) => app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: "N", password: "test-pass-2026" } });
    const first = await reg("owner@x.test");
    expect(first.statusCode).toBe(200);
    expect((await reg("stranger@x.test")).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/auth/config" })).json().firstAccount).toBe(false);
    const sid = first.cookies.find((c) => c.name === "brill_sid")!.value;
    const ws = (await app.inject({ url: "/api/workspaces", cookies: { brill_sid: sid } })).json().workspaces[0].id;
    await app.inject({ method: "POST", url: `/api/workspaces/${ws}/invites`, cookies: { brill_sid: sid }, payload: { email: "friend@x.test", role: "editor" } });
    expect((await reg("friend@x.test")).statusCode).toBe(200);
  });
});

describe("installable app (PWA) and embedding", () => {
  it("serves the manifest and service worker fresh, and can't be framed by default", async () => {
    const web = mkdtempSync(join(tmpdir(), "brill-pwa-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Brill</title>");
    writeFileSync(join(web, "manifest.webmanifest"), JSON.stringify({ name: "Brill Tables" }));
    writeFileSync(join(web, "sw.js"), "self.addEventListener('fetch', () => {})");
    const d = await openDb("memory://");
    const a = buildApp(d, { filesDir: mkdtempSync(join(tmpdir(), "brill-f-")), webDir: web });
    await a.ready();
    const m = await a.inject({ url: "/manifest.webmanifest" });
    expect(m.headers["content-type"]).toBe("application/manifest+json");
    expect(m.headers["cache-control"]).toBe("no-cache");
    const sw = await a.inject({ url: "/sw.js" });
    expect(sw.headers["content-type"]).toContain("javascript");
    expect(sw.headers["cache-control"]).toBe("no-cache");
    const home = await a.inject({ url: "/" });
    expect(home.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(home.headers["x-frame-options"]).toBe("DENY");
    await a.close();
    await d.close();
  });

  it("EMBED_ORIGINS lets a mobile wrapper frame the app, with a cookie that works in the frame", async () => {
    const web = mkdtempSync(join(tmpdir(), "brill-emb-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Brill</title>");
    const d = await openDb("memory://");
    const a = buildApp(d, { filesDir: mkdtempSync(join(tmpdir(), "brill-f-")), webDir: web, embedOrigins: ["https://app.brillcrew.test"] });
    await a.ready();
    const home = await a.inject({ url: "/base/x" });
    expect(home.headers["content-security-policy"]).toContain("frame-ancestors 'self' https://app.brillcrew.test");
    expect(home.headers["x-frame-options"]).toBeUndefined();
    // The API itself still can't be framed.
    expect((await a.inject({ url: "/api/health" })).headers["x-frame-options"]).toBe("DENY");
    const reg = await a.inject({ method: "POST", url: "/api/auth/register", payload: { email: "e@x.test", name: "E", password: "test-pass-2026" } });
    const cookie = String(reg.headers["set-cookie"]);
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Partitioned/);
    await a.close();
    await d.close();
  });
});
