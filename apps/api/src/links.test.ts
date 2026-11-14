import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;
let call: (method: any, url: string, payload?: unknown) => Promise<any>;
let status: (method: any, url: string, payload?: unknown) => Promise<{ code: number; body: any }>;
let baseId: string;

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-test-")) });
  await app.ready();
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email: "l@example.com", name: "L", password: "test-pass-2026" },
  });
  const sid = res.cookies.find((c) => c.name === "brill_sid")!.value;
  status = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload: payload as any, cookies: { brill_sid: sid } });
    return { code: r.statusCode, body: r.json() };
  };
  call = async (method, url, payload) => {
    const r = await status(method, url, payload);
    if (r.code >= 400) throw new Error(`${method} ${url} -> ${r.code} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const ws = await call("GET", "/api/workspaces");
  baseId = (await call("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Shop" })).base.id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

/** Make a table with a clean slate: no starter records. */
async function makeTable(name: string) {
  const { table } = await call("POST", `/api/bases/${baseId}/tables`, { name });
  const detail = await call("GET", `/api/tables/${table.id}`);
  for (const r of (await call("GET", `/api/views/${detail.views[0].id}/records`)).records) {
    await call("DELETE", `/api/records/${r.id}`);
  }
  return { id: table.id as string, viewId: detail.views[0].id as string };
}
const fieldsOf = async (tableId: string) => {
  const d = await call("GET", `/api/tables/${tableId}`);
  return Object.fromEntries(d.fields.map((f: any) => [f.name, f]));
};
const addField = async (tableId: string, name: string, type: string, options: any = {}) =>
  (await call("POST", `/api/tables/${tableId}/fields`, { name, type, options })).field;
const addRecord = async (tableId: string, cells: any) => (await call("POST", `/api/tables/${tableId}/records`, { cells })).record;
const getRecord = async (viewId: string, id: string) =>
  (await call("GET", `/api/views/${viewId}/records`)).records.find((r: any) => r.id === id);

describe("linked records", () => {
  let customers: { id: string; viewId: string };
  let orders: { id: string; viewId: string };
  let link: any;
  let inverse: any;

  beforeAll(async () => {
    customers = await makeTable("Customers");
    orders = await makeTable("Orders");
    await addField(orders.id, "Amount", "number", { precision: 2 });
    link = await addField(orders.id, "Customer", "link", { linkedTableId: customers.id });
    inverse = (await fieldsOf(customers.id))["Orders"];
  });

  it("creating a link field creates the other side", () => {
    expect(inverse.type).toBe("link");
    expect(inverse.options.linkedTableId).toBe(orders.id);
    expect(inverse.options.inverseFieldId).toBe(link.id);
    expect(link.options.inverseFieldId).toBe(inverse.id);
  });

  it("linking keeps both sides in sync, with labels", async () => {
    const acme = await addRecord(customers.id, { Name: "Acme" });
    const o1 = await addRecord(orders.id, { Name: "O-1", Amount: 100, Customer: [acme.id] });
    const o2 = await addRecord(orders.id, { Name: "O-2", Amount: 50.5, Customer: [acme.id] });
    expect((await getRecord(customers.viewId, acme.id)).cells[inverse.id]).toEqual([o1.id, o2.id]);

    const { labels } = await call("GET", `/api/views/${orders.viewId}/records`);
    expect(labels[acme.id]).toBe("Acme");

    // Unlink from the other side.
    await call("PATCH", `/api/records/${acme.id}`, { cells: { [inverse.id]: [o2.id] } });
    expect((await getRecord(orders.viewId, o1.id)).cells[link.id]).toBeUndefined();
    expect((await getRecord(orders.viewId, o2.id)).cells[link.id]).toEqual([acme.id]);
  });

  it("rejects links to records that don't exist or are in another table", async () => {
    const other = await addRecord(orders.id, { Name: "not a customer" });
    const r = await status("POST", `/api/tables/${orders.id}/records`, { cells: { Customer: [other.id] } });
    expect(r.code).toBe(422);
  });

  it("lookup, rollup and count update when linked data changes", async () => {
    const lookup = await addField(customers.id, "Order names", "lookup", { linkFieldId: inverse.id, targetFieldId: (await fieldsOf(orders.id)).Name.id });
    const amountId = (await fieldsOf(orders.id)).Amount.id;
    const total = await addField(customers.id, "Total spent", "rollup", { linkFieldId: inverse.id, targetFieldId: amountId, aggregation: "sum" });
    const count = await addField(customers.id, "Order count", "count", { linkFieldId: inverse.id });

    const bob = await addRecord(customers.id, { Name: "Bob" });
    let b = await getRecord(customers.viewId, bob.id);
    expect(b.cells[count.id]).toBe(0);
    expect(b.cells[total.id]).toBe(0);

    const o = await addRecord(orders.id, { Name: "O-9", Amount: 20, Customer: [bob.id] });
    await addRecord(orders.id, { Name: "O-10", Amount: 5.25, Customer: [bob.id] });
    b = await getRecord(customers.viewId, bob.id);
    expect(b.cells[count.id]).toBe(2);
    expect(b.cells[total.id]).toBe(25.25);
    expect(b.cells[lookup.id]).toEqual(["O-9", "O-10"]);

    // Changing a value in the linked record updates the rollup.
    await call("PATCH", `/api/records/${o.id}`, { cells: { Amount: 30 } });
    expect((await getRecord(customers.viewId, bob.id)).cells[total.id]).toBe(35.25);

    // Deleting a linked record removes it everywhere.
    await call("DELETE", `/api/records/${o.id}`);
    b = await getRecord(customers.viewId, bob.id);
    expect(b.cells[count.id]).toBe(1);
    expect(b.cells[total.id]).toBe(5.25);
    expect(b.cells[lookup.id]).toEqual(["O-10"]);

    // Changing the rollup's aggregation recomputes it.
    await call("PATCH", `/api/fields/${total.id}`, { options: { aggregation: "max" } });
    expect((await getRecord(customers.viewId, bob.id)).cells[total.id]).toBe(5.25);
  });

  it("computed values can't be typed into, and can be filtered/sorted as numbers", async () => {
    const f = await fieldsOf(customers.id);
    const r = await status("PATCH", `/api/records/${(await addRecord(customers.id, { Name: "Zed" })).id}`, { cells: { "Order count": 5 } });
    expect(r.code).toBe(422);
    await call("PATCH", `/api/views/${customers.viewId}`, {
      config: {
        filters: { conditions: [{ id: "c1", fieldId: f["Order count"].id, operator: ">=", value: 1 }] },
        sorts: [{ fieldId: f["Total spent"].id, direction: "desc" }],
      },
    });
    const { records } = await call("GET", `/api/views/${customers.viewId}/records`);
    // Acme: one order of 50.5. Bob: MAX of his remaining order = 5.25. Zed: no orders (filtered out).
    expect(records.map((x: any) => x.cells[f.Name.id])).toEqual(["Acme", "Bob"]);
    await call("PATCH", `/api/views/${customers.viewId}`, { config: {} });
  });

  it("lookups follow chains (lookup of a lookup)", async () => {
    // Orders → Customer, and Customers has "Order names" (lookup). Add, on Orders, a lookup of the
    // customer's order names; then renaming an order must flow through both levels.
    const f = await fieldsOf(customers.id);
    const chain = await addField(orders.id, "Sibling orders", "lookup", { linkFieldId: link.id, targetFieldId: f["Order names"].id });
    const o = await addRecord(orders.id, { Name: "First", Customer: [(await addRecord(customers.id, { Name: "Cy" })).id] });
    expect((await getRecord(orders.viewId, o.id)).cells[chain.id]).toEqual(["First"]);
    await call("PATCH", `/api/records/${o.id}`, { cells: { Name: "Renamed" } });
    expect((await getRecord(orders.viewId, o.id)).cells[chain.id]).toEqual(["Renamed"]);
  });

  it("protects fields other fields depend on, and deletes both sides of a link", async () => {
    const r = await status("DELETE", `/api/fields/${(await fieldsOf(orders.id)).Amount.id}`);
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/Total spent/);

    const t1 = await makeTable("A");
    const t2 = await makeTable("B");
    const l = await addField(t1.id, "To B", "link", { linkedTableId: t2.id });
    await call("DELETE", `/api/fields/${l.id}`);
    expect((await fieldsOf(t2.id))["A"]).toBeUndefined();
  });

  it("can't convert link/computed fields to other types", async () => {
    const r = await status("PATCH", `/api/fields/${link.id}`, { type: "singleLineText" });
    expect(r.code).toBe(400);
  });

  it("self-links have no inverse field", async () => {
    const t = await makeTable("People");
    const l = await addField(t.id, "Manager", "link", { linkedTableId: t.id });
    expect(l.options.inverseFieldId).toBeUndefined();
    const boss = await addRecord(t.id, { Name: "Boss" });
    const emp = await addRecord(t.id, { Name: "Emp", Manager: [boss.id] });
    expect((await getRecord(t.viewId, emp.id)).cells[l.id]).toEqual([boss.id]);
    expect((await getRecord(t.viewId, boss.id)).cells[l.id]).toBeUndefined();
  });

  it("record-names search powers the link picker", async () => {
    const { records } = await call("GET", `/api/tables/${customers.id}/record-names?q=ac`);
    expect(records.map((r: any) => r.name)).toEqual(["Acme"]);
  });
});
