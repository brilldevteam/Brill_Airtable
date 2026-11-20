import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;
type Res = { code: number; body: any };
let sid: string;
const call = async (m: string, u: string, p?: unknown, cookie = sid): Promise<Res> => {
  const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: cookie } });
  return { code: res.statusCode, body: res.json() };
};
let baseId: string;
let tableId: string;
let viewId: string;
const F: Record<string, any> = {};

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-dash-")) });
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "d@studio.test", name: "Dee", password: "test-pass-2026" } });
  sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
  const b = (await call("POST", `/api/workspaces/${ws}/bases`, { name: "Sales" })).body;
  baseId = b.base.id;
  tableId = b.firstTableId;
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Amount", type: "currency", options: { symbol: "₹", precision: 0 } });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Due", type: "date" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Tags", type: "multipleSelect", options: { choices: [{ name: "Print" }, { name: "Web" }] } });
  const t = (await call("GET", `/api/tables/${tableId}`)).body;
  for (const f of t.fields) F[f.name] = f;
  viewId = t.views[0].id;
  for (const rec of (await call("GET", `/api/views/${viewId}/records`)).body.records) await call("DELETE", `/api/records/${rec.id}`);
  const rows = [
    { Name: "A", Status: "Todo", Amount: 100, Due: "2026-01-10", Tags: ["Print"] },
    { Name: "B", Status: "Done", Amount: 300, Due: "2026-01-20", Tags: ["Print", "Web"] },
    { Name: "C", Status: "Done", Amount: 600, Due: "2026-02-05", Tags: ["Web"] },
    { Name: "D", Status: "In progress", Due: "2026-02-15" },
  ];
  for (const cells of rows) await call("POST", `/api/tables/${tableId}/records`, { cells });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("dashboards", () => {
  let dashId: string;
  const doneView = async () => {
    const v = (await call("POST", `/api/tables/${tableId}/views`, { name: "Done only", type: "grid" })).body.view;
    const done = F.Status.options.choices.find((c: any) => c.name === "Done").id;
    await call("PATCH", `/api/views/${v.id}`, { config: { ...v.config, filters: { conjunction: "and", conditions: [{ id: "c", fieldId: F.Status.id, operator: "is", value: done }] } } });
    return v.id as string;
  };

  it("creates a dashboard and works out numbers, charts and lists", async () => {
    const done = await doneView();
    const widgets = [
      { type: "number", id: "w1", title: "Total", tableId, metric: { kind: "sum", fieldId: F.Amount.id } },
      { type: "number", id: "w2", title: "Done", tableId, viewId: done },
      { type: "number", id: "w3", title: "Average", tableId, metric: { kind: "avg", fieldId: F.Amount.id } },
      { type: "chart", id: "w4", title: "By status", tableId, groupFieldId: F.Status.id },
      { type: "chart", id: "w5", title: "By month", tableId, chartType: "column", groupFieldId: F.Due.id, metric: { kind: "sum", fieldId: F.Amount.id } },
      { type: "chart", id: "w6", title: "Tags", tableId, chartType: "donut", groupFieldId: F.Tags.id },
      { type: "list", id: "w7", title: "Latest", tableId, fieldIds: [F.Name.id, F.Amount.id], limit: 2 },
      { type: "text", id: "w8", title: "Note", text: "Hello" },
    ];
    const r = await call("POST", `/api/bases/${baseId}/dashboards`, { name: "Overview", widgets });
    expect(r.code).toBe(200);
    dashId = r.body.dashboard.id;
    expect(r.body.dashboard.widgets[3]).toMatchObject({ chartType: "bar", limit: 8, width: 2 });

    const { data } = (await call("GET", `/api/dashboards/${dashId}/data`)).body;
    expect(data.w1).toMatchObject({ type: "number", value: 1000, display: "₹1,000" });
    expect(data.w2.value).toBe(2);
    // Average ignores the empty amount.
    expect(data.w3.display).toBe("₹333"); // shown like the field: whole rupees
    // Single selects keep their option order and colours.
    expect(data.w4.groups.map((g: any) => [g.label, g.value])).toEqual([["Todo", 1], ["In progress", 1], ["Done", 2]]);
    expect(data.w4.groups[0].color).toBeTruthy();
    // Dates by month, in time order.
    expect(data.w5.groups.map((g: any) => g.value)).toEqual([400, 600]);
    expect(data.w5.groups[0].display).toBe("₹400");
    // Multiple selects count a record once per option.
    expect(Object.fromEntries(data.w6.groups.map((g: any) => [g.label, g.value]))).toEqual({ Print: 2, Web: 2, "(Empty)": 1 });
    expect(data.w7.records).toHaveLength(2);
    expect(data.w7.more).toBe(2);
    expect(data.w7.fields.map((f: any) => f.name)).toEqual(["Name", "Amount"]);
    expect(data.w8.type).toBe("text");
  });

  it("folds small groups into Other, and reports broken widgets without failing the rest", async () => {
    for (let i = 0; i < 6; i++) await call("POST", `/api/tables/${tableId}/records`, { cells: { Name: `N${i}` } });
    await call("PATCH", `/api/dashboards/${dashId}`, {
      widgets: [
        { type: "chart", id: "x1", tableId, groupFieldId: F.Name.id, limit: 3 },
        { type: "chart", id: "x2", tableId, groupFieldId: "fldGone00000000000" },
        { type: "number", id: "x3", tableId },
      ],
    });
    const { data } = (await call("GET", `/api/dashboards/${dashId}/data`)).body;
    expect(data.x1.groups).toHaveLength(3);
    expect(data.x1.groups[2].label).toMatch(/^Other \(/);
    expect(data.x1.total).toBe(10);
    expect(data.x2).toEqual({ type: "error", message: "Choose a field to group by" });
    expect(data.x3.value).toBe(10);
  });

  it("shows empty months as zero so a timeline has no gaps", async () => {
    await call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "April", Amount: 50, Due: "2026-04-02" } });
    await call("PATCH", `/api/dashboards/${dashId}`, {
      widgets: [{ type: "chart", id: "m", tableId, chartType: "column", groupFieldId: F.Due.id, metric: { kind: "sum", fieldId: F.Amount.id } }],
    });
    const { data } = (await call("GET", `/api/dashboards/${dashId}/data`)).body;
    const dated = data.m.groups.filter((g: any) => g.key !== "");
    expect(dated.map((g: any) => [g.key, g.value])).toEqual([["2026-01", 400], ["2026-02", 600], ["2026-03", 0], ["2026-04", 50]]);
  });

  it("only uses this base's tables; anyone in the base can look, creators arrange", async () => {
    const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
    const other = (await call("POST", `/api/workspaces/${ws}/bases`, { name: "Other" })).body.firstTableId;
    expect((await call("PATCH", `/api/dashboards/${dashId}`, { widgets: [{ type: "number", id: "z", tableId: other }] })).code).toBe(400);

    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "v@client.test", name: "Viv", password: "test-pass-2026" } });
    const viv = r.cookies.find((c) => c.name === "brill_sid")!.value;
    await db.query(`UPDATE users SET email_verified_at=now() WHERE email='v@client.test'`);
    const inv = (await call("POST", `/api/bases/${baseId}/invites`, { email: "v@client.test", role: "read" })).body.invite;
    await call("POST", `/api/invites/${inv.token}/accept`, {}, viv);
    expect((await call("GET", `/api/bases/${baseId}/dashboards`, undefined, viv)).body.dashboards).toHaveLength(1);
    expect((await call("GET", `/api/dashboards/${dashId}/data`, undefined, viv)).code).toBe(200);
    expect((await call("PATCH", `/api/dashboards/${dashId}`, { name: "Mine" }, viv)).code).toBe(403);
    expect((await call("DELETE", `/api/dashboards/${dashId}`)).code).toBe(200);
  });
});
