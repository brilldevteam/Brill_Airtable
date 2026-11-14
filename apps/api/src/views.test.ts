import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { resolveDate } from "./viewQuery";

let db: Db;
let app: ReturnType<typeof buildApp>;
let call: (method: any, url: string, payload?: unknown) => Promise<any>;
let tableId: string;
let viewId: string;
const F: Record<string, any> = {};

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-test-")) });
  await app.ready();
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email: "v@example.com", name: "V", password: "test-pass-2026" },
  });
  const sid = res.cookies.find((c) => c.name === "brill_sid")!.value;
  call = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload: payload as any, cookies: { brill_sid: sid } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const ws = await call("GET", "/api/workspaces");
  tableId = (await call("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Shop" })).firstTableId;
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Price", type: "number", options: { precision: 2 } });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Due", type: "date" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Paid", type: "checkbox" });
  await call("POST", `/api/tables/${tableId}/fields`, {
    name: "Tags", type: "multipleSelect", options: { choices: [{ name: "Print" }, { name: "Web" }, { name: "Rush" }] },
  });
  const detail = await call("GET", `/api/tables/${tableId}`);
  for (const f of detail.fields) F[f.name] = f;
  viewId = detail.views[0].id;
  // Remove the 3 blank starter records so assertions are simple.
  for (const r of (await call("GET", `/api/views/${viewId}/records`)).records) await call("DELETE", `/api/records/${r.id}`);
  const rows = [
    { Name: "Banner", Price: 120, Due: "2026-11-20", Paid: true, Status: "Done", Tags: ["Print", "Rush"] },
    { Name: "website", Price: 900, Due: "2026-12-01", Status: "In progress", Tags: ["Web"] },
    { Name: "Flyers", Price: 45.5, Due: "2026-11-15", Status: "Todo", Tags: ["Print"] },
    { Name: "Logo" },
  ];
  for (const cells of rows) await call("POST", `/api/tables/${tableId}/records`, { cells });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

async function names(config: any) {
  await call("PATCH", `/api/views/${viewId}`, { config });
  const { records } = await call("GET", `/api/views/${viewId}/records`);
  return records.map((r: any) => r.cells[F.Name.id] ?? "");
}
const cond = (field: string, operator: string, value?: unknown) => ({
  id: Math.random().toString(), fieldId: F[field].id, operator, value,
});
const choice = (field: string, name: string) => F[field].options.choices.find((c: any) => c.name === name).id;

describe("view filters", () => {
  it("text contains is case-insensitive", async () => {
    expect(await names({ filters: { conditions: [cond("Name", "contains", "WEB")] } })).toEqual(["website"]);
  });
  it("treats % and _ literally", async () => {
    expect(await names({ filters: { conditions: [cond("Name", "contains", "%")] } })).toEqual([]);
  });
  it("number comparisons", async () => {
    expect(await names({ filters: { conditions: [cond("Price", ">=", 120)] } })).toEqual(["Banner", "website"]);
    expect(await names({ filters: { conditions: [cond("Price", "!=", 120)] } })).toEqual(["website", "Flyers", "Logo"]);
  });
  it("checkbox, empty and single select", async () => {
    expect(await names({ filters: { conditions: [cond("Paid", "isNotChecked")] } })).toEqual(["website", "Flyers", "Logo"]);
    expect(await names({ filters: { conditions: [cond("Status", "isEmpty")] } })).toEqual(["Logo"]);
    expect(
      await names({ filters: { conditions: [cond("Status", "isAnyOf", [choice("Status", "Todo"), choice("Status", "Done")])] } }),
    ).toEqual(["Banner", "Flyers"]);
  });
  it("multiple select has any / all / none", async () => {
    expect(
      await names({ filters: { conditions: [cond("Tags", "hasAnyOf", [choice("Tags", "Rush"), choice("Tags", "Web")])] } }),
    ).toEqual(["Banner", "website"]);
    expect(
      await names({ filters: { conditions: [cond("Tags", "hasAllOf", [choice("Tags", "Print"), choice("Tags", "Rush")])] } }),
    ).toEqual(["Banner"]);
    expect(await names({ filters: { conditions: [cond("Tags", "hasNoneOf", [choice("Tags", "Print")])] } })).toEqual(["website", "Logo"]);
  });
  it("dates", async () => {
    expect(await names({ filters: { conditions: [cond("Due", "isBefore", "2026-11-20")] } })).toEqual(["Flyers"]);
    expect(await names({ filters: { conditions: [cond("Due", "isOnOrAfter", "2026-11-20")] } })).toEqual(["Banner", "website"]);
  });
  it("AND / OR, and ignores incomplete conditions", async () => {
    const paid = cond("Paid", "isChecked");
    expect(await names({ filters: { conjunction: "and", conditions: [cond("Price", "<", 200), paid] } })).toEqual(["Banner"]);
    expect(await names({ filters: { conjunction: "or", conditions: [cond("Name", "is", "logo"), paid] } })).toEqual(["Banner", "Logo"]);
    expect(await names({ filters: { conditions: [cond("Name", "contains", "")] } })).toHaveLength(4);
  });
});

describe("view sorts", () => {
  it("numbers descending, empties last", async () => {
    expect(await names({ sorts: [{ fieldId: F.Price.id, direction: "desc" }] })).toEqual(["website", "Banner", "Flyers", "Logo"]);
  });
  it("single select by option order", async () => {
    expect(await names({ sorts: [{ fieldId: F.Status.id, direction: "asc" }] })).toEqual(["Flyers", "website", "Banner", "Logo"]);
  });
  it("multiple select and multi-level sorts don't error", async () => {
    const r = await names({
      sorts: [{ fieldId: F.Tags.id, direction: "asc" }, { fieldId: F.Price.id, direction: "desc" }],
      filters: { conditions: [cond("Name", "isNotEmpty")] },
    });
    expect(r).toHaveLength(4);
  });
  it("text case-insensitively", async () => {
    expect(await names({ sorts: [{ fieldId: F.Name.id, direction: "asc" }] })).toEqual(["Banner", "Flyers", "Logo", "website"]);
  });
});

describe("views CRUD", () => {
  it("kanban stacks on the first single select; a table keeps at least one view", async () => {
    const { view } = await call("POST", `/api/tables/${tableId}/views`, { name: "Board", type: "kanban" });
    expect(view.config.stackFieldId).toBe(F.Status.id);
    await call("DELETE", `/api/views/${view.id}`);
    await expect(call("DELETE", `/api/views/${viewId}`)).rejects.toThrow(/at least one view/);
  });
  it("calendar views default to the first date field and colour by the first single select", async () => {
    const { view } = await call("POST", `/api/tables/${tableId}/views`, { name: "Schedule", type: "calendar" });
    expect(view.type).toBe("calendar");
    expect(view.config.dateFieldId).toBe(F.Due.id);
    expect(view.config.colorFieldId).toBe(F.Status.id);
    await call("DELETE", `/api/views/${view.id}`);
  });
  it("gallery views default to the first attachment field", async () => {
    const att = (await call("POST", `/api/tables/${tableId}/fields`, { name: "Photos", type: "attachment" })).field;
    const { view } = await call("POST", `/api/tables/${tableId}/views`, { name: "Wall", type: "gallery" });
    expect(view.config.coverFieldId).toBe(att.id);
    expect(view.config.cardSize).toBe("medium");
    await call("DELETE", `/api/views/${view.id}`);
    await call("DELETE", `/api/fields/${att.id}`);
  });
  it("rejects invalid config", async () => {
    await expect(
      call("PATCH", `/api/views/${viewId}`, { config: { sorts: [{ fieldId: "x", direction: "up" }] } }),
    ).rejects.toThrow(/400/);
  });
});

describe("resolveDate", () => {
  it("handles relative words", () => {
    expect(resolveDate("today", new Date("2026-11-12T12:00:00Z"))).toBe("2026-11-12");
    expect(resolveDate("nope")).toBeNull();
  });
});
