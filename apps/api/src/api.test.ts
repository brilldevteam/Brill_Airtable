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

async function signUp(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: "Test", password: "test-pass-2026" } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "brill_sid")!;
  const call = (method: any, url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, cookies: { brill_sid: cookie.value } });
  return call;
}

describe("api", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(res.statusCode).toBe(401);
  });

  it("full flow: base → table → field → records → type change", async () => {
    const call = await signUp("a@example.com");
    const ws = (await call("GET", "/api/workspaces")).json();
    expect(ws.workspaces).toHaveLength(1);

    const created = (await call("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Orders" })).json();
    const tableId = created.firstTableId;
    const detail = (await call("GET", `/api/tables/${tableId}`)).json();
    expect(detail.fields.map((f: any) => f.name)).toEqual(["Name", "Notes", "Status"]);
    expect(detail.views).toHaveLength(1);
    const records = async () => (await call("GET", `/api/views/${detail.views[0].id}/records`)).json().records;
    expect(await records()).toHaveLength(3);

    const qty = (await call("POST", `/api/tables/${tableId}/fields`, { name: "Qty", type: "number", options: { precision: 1 } })).json().field;
    const rec = (await call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "Chair", Qty: "2.26", Status: "Done" } })).json().record;
    expect(rec.cells[qty.id]).toBe(2.3);
    const status = detail.fields.find((f: any) => f.name === "Status");
    expect(rec.cells[status.id]).toBe(status.options.choices[2].id);

    const bad = await call("PATCH", `/api/records/${rec.id}`, { cells: { Qty: "lots" } });
    expect(bad.statusCode).toBe(422);

    // Clearing a value removes it from the record.
    const cleared = (await call("PATCH", `/api/records/${rec.id}`, { cells: { Qty: null } })).json().record;
    expect(cleared.cells[qty.id]).toBeUndefined();

    // Converting single select → text keeps the label.
    await call("PATCH", `/api/fields/${status.id}`, { type: "singleLineText" });
    expect((await records()).find((r: any) => r.id === rec.id).cells[status.id]).toBe("Done");

    // Deleting a record hides it.
    await call("DELETE", `/api/records/${rec.id}`);
    expect((await records()).find((r: any) => r.id === rec.id)).toBeUndefined();
  });

  it("users can't see other users' tables", async () => {
    const alice = await signUp("alice@example.com");
    const ws = (await alice("GET", "/api/workspaces")).json();
    const { firstTableId } = (await alice("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Secret" })).json();
    const bob = await signUp("bob@example.com");
    expect((await bob("GET", `/api/tables/${firstTableId}`)).statusCode).toBe(404);
    expect((await bob("POST", `/api/tables/${firstTableId}/records`, { cells: {} })).statusCode).toBe(404);
  });
});
