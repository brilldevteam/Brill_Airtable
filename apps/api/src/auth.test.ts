import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-test-")) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const register = (email: string, password = "test-pass-2026") =>
  app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: "Ann", password } });
const login = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const sid = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find((c) => c.name === "brill_sid")!.value;

describe("auth hardening", () => {
  it("rejects weak passwords", async () => {
    expect((await register("weak1@brill.test", "short")).statusCode).toBe(400);
    expect((await register("weak2@brill.test", "password123")).statusCode).toBe(400);
    expect((await register("weak3@brill.test", "aaaaaaaaaaaa")).statusCode).toBe(400);
  });

  it("stores only a hash of the session id", async () => {
    const r = await register("hash@brill.test");
    const rows = await db.query<{ id: string }>(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='hash@brill.test'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(sid(r));
  });

  it("locks an account after repeated wrong passwords, with Retry-After", async () => {
    await register("brute@brill.test");
    let last;
    for (let i = 0; i < 11; i++) last = await login("brute@brill.test", "wrong-password-" + i);
    expect(last!.statusCode).toBe(429);
    expect(last!.headers["retry-after"]).toBeTruthy();
    // Even the right password is refused while locked.
    expect((await login("brute@brill.test", "test-pass-2026")).statusCode).toBe(429);
  });

  it("changing the password signs out other devices", async () => {
    const a = sid(await register("change@brill.test"));
    const b = sid(await login("change@brill.test", "test-pass-2026"));
    const me = (s: string) => app.inject({ method: "GET", url: "/api/auth/me", cookies: { brill_sid: s } });
    expect((await me(b)).json().user.email).toBe("change@brill.test");

    const bad = await app.inject({ method: "POST", url: "/api/auth/password", cookies: { brill_sid: a }, payload: { currentPassword: "nope", newPassword: "new-pass-2026!" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/auth/password", cookies: { brill_sid: a }, payload: { currentPassword: "test-pass-2026", newPassword: "new-pass-2026!" } });
    expect(ok.statusCode).toBe(200);
    expect((await me(a)).json().user.email).toBe("change@brill.test");
    expect((await me(b)).json().user).toBeNull();
    expect((await login("change@brill.test", "new-pass-2026!")).statusCode).toBe(200);
  });

  it("can rename the account and sign out other sessions", async () => {
    const a = sid(await register("acct@brill.test"));
    const b = sid(await login("acct@brill.test", "test-pass-2026"));
    const r = await app.inject({ method: "PATCH", url: "/api/auth/me", cookies: { brill_sid: a }, payload: { name: "Ann Lee" } });
    expect(r.json().user.name).toBe("Ann Lee");
    expect((await app.inject({ method: "GET", url: "/api/auth/sessions", cookies: { brill_sid: a } })).json().active).toBe(2);
    await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", cookies: { brill_sid: a }, payload: {} });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { brill_sid: b } })).json().user).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { brill_sid: a } })).json().user.name).toBe("Ann Lee");
  });

  it("sends security headers and a working health check", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json()).toEqual({ ok: true });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-request-id"]).toBeTruthy();
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});
