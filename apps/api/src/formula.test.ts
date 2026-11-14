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
    method: "POST", url: "/api/auth/register", payload: { email: "f@example.com", name: "F", password: "test-pass-2026" },
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

async function makeTable(name: string) {
  const { table } = await call("POST", `/api/bases/${baseId}/tables`, { name });
  const d = await call("GET", `/api/tables/${table.id}`);
  for (const r of (await call("GET", `/api/views/${d.views[0].id}/records`)).records) await call("DELETE", `/api/records/${r.id}`);
  return { id: table.id as string, viewId: d.views[0].id as string };
}
const addField = async (tableId: string, name: string, type: string, options: any = {}) =>
  (await call("POST", `/api/tables/${tableId}/fields`, { name, type, options })).field;
const addRecord = async (tableId: string, cells: any) => (await call("POST", `/api/tables/${tableId}/records`, { cells })).record;
const records = async (viewId: string) => (await call("GET", `/api/views/${viewId}/records`)).records;
const get = async (viewId: string, id: string) => (await records(viewId)).find((r: any) => r.id === id);

describe("formula fields", () => {
  let t: { id: string; viewId: string };
  let qty: any, price: any, total: any, label: any;

  beforeAll(async () => {
    t = await makeTable("Items");
    qty = await addField(t.id, "Qty", "number");
    price = await addField(t.id, "Price", "number", { precision: 2 });
  });

  it("creates a formula, stores ids, infers type, computes for existing and new records", async () => {
    const existing = await addRecord(t.id, { Name: "Old", Qty: 2, Price: 5 });
    total = await addField(t.id, "Total", "formula", { formula: "{Qty} * {Price}", precision: 2 });
    expect(total.options.formula).toBe(`{${qty.id}} * {${price.id}}`);
    expect(total.options.resultType).toBe("number");
    expect((await get(t.viewId, existing.id)).cells[total.id]).toBe(10);

    const r = await addRecord(t.id, { Name: "New", Qty: 3, Price: 2.5 });
    expect(r.cells[total.id]).toBe(7.5);
  });

  it("recomputes when inputs change, and chains formula → formula", async () => {
    label = await addField(t.id, "Label", "formula", { formula: `{Name} & ": " & {Total}` });
    expect(label.options.resultType).toBe("text");
    const r = await addRecord(t.id, { Name: "Chair", Qty: 1, Price: 40 });
    expect((await get(t.viewId, r.id)).cells[label.id]).toBe("Chair: 40");
    await call("PATCH", `/api/records/${r.id}`, { cells: { Qty: 3 } });
    const after = await get(t.viewId, r.id);
    expect(after.cells[total.id]).toBe(120);
    expect(after.cells[label.id]).toBe("Chair: 120");
  });

  it("filters and sorts numeric formula results as numbers", async () => {
    await call("PATCH", `/api/views/${t.viewId}`, {
      config: {
        filters: { conditions: [{ id: "c", fieldId: total.id, operator: ">", value: 9 }] },
        sorts: [{ fieldId: total.id, direction: "desc" }],
      },
    });
    const rs = await records(t.viewId);
    expect(rs.map((r: any) => r.cells[total.id])).toEqual([120, 10]);
    await call("PATCH", `/api/views/${t.viewId}`, { config: {} });
  });

  it("rejects bad formulas, self references and loops", async () => {
    let r = await status("POST", `/api/tables/${t.id}/fields`, { name: "Bad", type: "formula", options: { formula: "{Nope} + 1" } });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/Unknown field \{Nope\}/);
    r = await status("POST", `/api/tables/${t.id}/fields`, { name: "Bad2", type: "formula", options: { formula: "SUMM(1)" } });
    expect(r.body.error).toMatch(/Unknown function SUMM/);
    // Total uses Qty/Price; making Total use Label (which uses Total) is a loop.
    r = await status("PATCH", `/api/fields/${total.id}`, { options: { formula: "LEN({Label})" } });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/loop/);
  });

  it("can't delete a field a formula uses; renaming a field keeps formulas working", async () => {
    const r = await status("DELETE", `/api/fields/${qty.id}`);
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/Total/);
    await call("PATCH", `/api/fields/${qty.id}`, { name: "Quantity" });
    const rec = await addRecord(t.id, { Name: "Desk", Quantity: 2, Price: 100 });
    expect(rec.cells[total.id]).toBe(200);
  });

  it("changing an input field's type re-infers the formula's type", async () => {
    const t2 = await makeTable("Types");
    const code = await addField(t2.id, "Code", "number");
    const f = await addField(t2.id, "Double", "formula", { formula: "{Code} * 2" });
    const r = await addRecord(t2.id, { Name: "x", Code: 21 });
    expect((await get(t2.viewId, r.id)).cells[f.id]).toBe(42);
    const echo = await addField(t2.id, "Echo", "formula", { formula: "{Code}" });
    expect(echo.options.resultType).toBe("number");
    await call("PATCH", `/api/fields/${code.id}`, { type: "singleLineText" });
    const fields = (await call("GET", `/api/tables/${t2.id}`)).fields;
    expect(fields.find((x: any) => x.id === echo.id).options.resultType).toBe("text");
    expect((await get(t2.viewId, r.id)).cells[echo.id]).toBe("21");
  });

  it("formulas can use lookups and rollups through links", async () => {
    const cust = await makeTable("Customers");
    const ord = await makeTable("Orders");
    await addField(ord.id, "Amount", "number");
    const link = await addField(ord.id, "Customer", "link", { linkedTableId: cust.id });
    const inv = (await call("GET", `/api/tables/${cust.id}`)).fields.find((f: any) => f.type === "link");
    const amountId = (await call("GET", `/api/tables/${ord.id}`)).fields.find((f: any) => f.name === "Amount").id;
    await addField(cust.id, "Spent", "rollup", { linkFieldId: inv.id, targetFieldId: amountId, aggregation: "sum" });
    const tier = await addField(cust.id, "Tier", "formula", { formula: `IF({Spent} >= 100, "Gold", "Standard")` });
    const who = await addField(ord.id, "Who", "formula", { formula: `"Order for " & {Customer}` });

    const acme = await addRecord(cust.id, { Name: "Acme" });
    expect((await get(cust.viewId, acme.id)).cells[tier.id]).toBe("Standard");
    const o = await addRecord(ord.id, { Name: "O1", Amount: 150, [link.id]: [acme.id] });
    expect((await get(cust.viewId, acme.id)).cells[tier.id]).toBe("Gold");
    expect((await get(ord.viewId, o.id)).cells[who.id]).toBe("Order for Acme");
  });

  it("dates, record info and errors", async () => {
    const t3 = await makeTable("Dates");
    await addField(t3.id, "Due", "date");
    const plus = await addField(t3.id, "Plus7", "formula", { formula: "DATEADD({Due}, 7, 'days')" });
    const id = await addField(t3.id, "Id", "formula", { formula: "RECORD_ID()" });
    const err = await addField(t3.id, "Err", "formula", { formula: `"x" & (1/0)` });
    const left = await addField(t3.id, "DaysLeft", "formula", { formula: "DATETIME_DIFF({Due}, TODAY(), 'days')" });
    expect(plus.options.resultType).toBe("date");
    expect(left.options.volatile).toBe(true);
    const r = await addRecord(t3.id, { Name: "a", Due: "2026-11-20" });
    const got = await get(t3.viewId, r.id);
    expect(got.cells[plus.id]).toBe("2026-11-27");
    expect(got.cells[id.id]).toBe(r.id);
    expect(got.cells[err.id]).toBe("#ERROR!");
    expect(typeof got.cells[left.id]).toBe("number");
  });

  it("formula cells can't be typed into", async () => {
    const r = await addRecord(t.id, { Name: "z" });
    const res = await status("PATCH", `/api/records/${r.id}`, { cells: { [total.id]: 5 } });
    expect(res.code).toBe(422);
  });
});
