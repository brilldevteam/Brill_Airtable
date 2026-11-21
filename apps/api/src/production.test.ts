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
    expect((await app.inject({ url: "/api/auth/config" })).json()).toEqual({ signups: "invite", firstAccount: true });
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
