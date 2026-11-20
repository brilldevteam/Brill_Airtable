import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;

type Res = { code: number; body: any };
type Client = { id: string; sid: string; call: (m: string, u: string, p?: unknown) => Promise<Res> };
async function signUp(email: string, name: string): Promise<Client> {
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name, password: "test-pass-2026" } });
  const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  await db.query(`UPDATE users SET email_verified_at=now() WHERE email=$1`, [email]);
  return {
    id: r.json().user.id,
    sid,
    call: async (m, u, p) => {
      const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
      return { code: res.statusCode, body: res.json() };
    },
  };
}

let owner: Client;
let mate: Client;
let wsId: string;
let baseId: string;
let tableId: string;
let viewId: string;
const F: Record<string, any> = {};
const fieldsNow = async () => {
  const fs = (await owner.call("GET", `/api/tables/${tableId}`)).body.fields;
  for (const f of fs) F[f.name] = f;
  return fs;
};
const records = async (config?: object) => {
  if (config) await owner.call("PATCH", `/api/views/${viewId}`, { config });
  return (await owner.call("GET", `/api/views/${viewId}/records`)).body;
};
const add = async (cells: object, who: Client = owner) => {
  const r = await who.call("POST", `/api/tables/${tableId}/records`, { cells });
  expect(r.code, JSON.stringify(r.body)).toBe(200);
  return r.body.record;
};

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-ft-")) });
  await app.ready();
  owner = await signUp("olivia@studio.test", "Olivia Owner");
  mate = await signUp("arun@studio.test", "Arun Editor");
  wsId = (await owner.call("GET", "/api/workspaces")).body.workspaces[0].id;
  const inv = (await owner.call("POST", `/api/workspaces/${wsId}/invites`, { email: "arun@studio.test", role: "editor" })).body.invite;
  await mate.call("POST", `/api/invites/${inv.token}/accept`, {});
  const b = (await owner.call("POST", `/api/workspaces/${wsId}/bases`, { name: "Shoots" })).body;
  baseId = b.base.id;
  tableId = b.firstTableId;
  viewId = (await owner.call("GET", `/api/tables/${tableId}`)).body.views[0].id;
  // Start from an empty table.
  for (const r of (await records()).records) await owner.call("DELETE", `/api/records/${r.id}`);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("number-like fields", () => {
  it("currency, percent, rating and duration accept loose input and store numbers", async () => {
    const mk = (name: string, type: string, options?: object) => owner.call("POST", `/api/tables/${tableId}/fields`, { name, type, options });
    expect((await mk("Fee", "currency", { symbol: "₹" })).body.field.options).toMatchObject({ symbol: "₹", precision: 2 });
    expect((await mk("Done %", "percent")).body.field.options.precision).toBe(0);
    expect((await mk("Score", "rating", { max: 5 })).body.field.options.max).toBe(5);
    expect((await mk("Edit time", "duration")).body.field.options.durationFormat).toBe("h:mm");
    await fieldsNow();

    const rec = await add({ Name: "Diwali reel", Fee: "₹12,500.5", "Done %": "40%", Score: 4, "Edit time": "1:30" });
    expect(rec.cells[F.Fee.id]).toBe(12500.5);
    expect(rec.cells[F["Done %"].id]).toBe(40);
    expect(rec.cells[F.Score.id]).toBe(4);
    expect(rec.cells[F["Edit time"].id]).toBe(5400);
    // "90" typed into a duration means 90 minutes; numbers through the API are seconds.
    const r2 = await add({ Name: "Teaser", "Edit time": "90", Score: 2, Fee: 800 });
    expect(r2.cells[F["Edit time"].id]).toBe(5400);
    expect((await owner.call("PATCH", `/api/records/${r2.id}`, { cells: { Score: 6 } })).code).toBe(422);
    expect((await owner.call("PATCH", `/api/records/${r2.id}`, { cells: { Score: 0 } })).body.record.cells[F.Score.id]).toBeUndefined();

    // They filter and sort as numbers.
    const list = await records({
      filters: { conjunction: "and", conditions: [{ id: "c", fieldId: F.Fee.id, operator: ">", value: 1000 }] }, sorts: [],
    });
    expect(list.records.map((r: any) => r.cells[F.Fee.id])).toEqual([12500.5]);
    await records({ filters: { conjunction: "and", conditions: [] }, sorts: [{ fieldId: F.Fee.id, direction: "asc" }] });
  });

  it("formulas and rollups use them as numbers", async () => {
    const f = (await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Fee with GST", type: "formula", options: { formula: "{Fee} * 1.18" } })).body.field;
    expect(f.options.resultType).toBe("number");
    const r = (await records({ filters: { conjunction: "and", conditions: [] }, sorts: [] })).records.find((x: any) => x.cells[F.Fee.id] === 800);
    expect(r.cells[f.id]).toBeCloseTo(944);
  });

  it("converting number ↔ currency keeps the value", async () => {
    const n = (await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Budget", type: "number", options: { precision: 0 } })).body.field;
    const rec = await add({ Name: "Budgeted", Budget: 50000 });
    await owner.call("PATCH", `/api/fields/${n.id}`, { type: "currency", options: { symbol: "$" } });
    const after = (await records()).records.find((x: any) => x.id === rec.id);
    expect(after.cells[n.id]).toBe(50000);
  });
});

describe("system fields", () => {
  it("autonumber numbers existing records in creation order, then continues and never reuses", async () => {
    const before = (await records()).records.length;
    const auto = (await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "No.", type: "autonumber" })).body.field;
    const all = (await records({ filters: { conjunction: "and", conditions: [] }, sorts: [{ fieldId: auto.id, direction: "asc" }] })).records;
    expect(all.map((r: any) => r.cells[auto.id])).toEqual(Array.from({ length: before }, (_, i) => i + 1));
    const last = await add({ Name: "Next" });
    expect(last.cells[auto.id]).toBe(before + 1);
    await owner.call("DELETE", `/api/records/${last.id}`);
    expect((await add({ Name: "After delete" })).cells[auto.id]).toBe(before + 2);
    // Can't be typed into.
    expect((await owner.call("PATCH", `/api/records/${last.id}`, { cells: { "No.": 99 } })).code).not.toBe(200);
  });

  it("created / last modified time and by follow the record", async () => {
    for (const [name, type] of [["Created", "createdTime"], ["Modified", "lastModifiedTime"], ["Creator", "createdBy"], ["Editor", "lastModifiedBy"]]) {
      expect((await owner.call("POST", `/api/tables/${tableId}/fields`, { name, type })).code).toBe(200);
    }
    await fieldsNow();
    const rec = await add({ Name: "Owner's record" });
    expect(rec.cells[F.Creator.id]).toEqual([owner.id]);
    expect(rec.cells[F.Editor.id]).toEqual([owner.id]);
    expect(new Date(rec.cells[F.Created.id]).getTime()).toBeGreaterThan(Date.now() - 60_000);

    await new Promise((r) => setTimeout(r, 15));
    const edited = (await mate.call("PATCH", `/api/records/${rec.id}`, { cells: { Name: "Edited by Arun" } })).body.record;
    expect(edited.cells[F.Creator.id]).toEqual([owner.id]);
    expect(edited.cells[F.Editor.id]).toEqual([mate.id]);
    expect(edited.cells[F.Modified.id] > rec.cells[F.Modified.id]).toBe(true);
    expect(edited.cells[F.Created.id]).toBe(rec.cells[F.Created.id]);

    // Existing records were filled in when the fields were added.
    const old = (await records()).records.find((r: any) => r.cells[F.Name.id] === "Diwali reel");
    expect(old.cells[F.Creator.id]).toEqual([owner.id]);
    // Names come back as labels.
    expect((await records()).labels[mate.id]).toBe("Arun Editor");
  });

  it("formulas can use them", async () => {
    const f = (await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "By", type: "formula", options: { formula: "ARRAYJOIN({Creator})" } })).body.field;
    const rec = (await records()).records.find((r: any) => r.cells[F.Name.id] === "Edited by Arun");
    expect(rec.cells[f.id]).toBe("Olivia Owner");
  });
});

describe("user field", () => {
  it("assigns people who can open the base; others are refused", async () => {
    const u = (await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Assignee", type: "user" })).body.field;
    expect(u.options.multiple).toBe(false);
    const people = (await owner.call("GET", `/api/bases/${baseId}/collaborators`)).body.users;
    expect(people.map((p: any) => p.name)).toEqual(["Arun Editor", "Olivia Owner"]);

    const rec = await add({ Name: "Assigned", Assignee: [mate.id] });
    expect(rec.cells[u.id]).toEqual([mate.id]);
    expect((await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Assignee: [mate.id, owner.id] } })).code).toBe(422);
    const stranger = await signUp("stranger@else.test", "Stranger");
    const bad = await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Assignee: [stranger.id] } });
    expect(bad.code).toBe(422);

    await owner.call("PATCH", `/api/fields/${u.id}`, { options: { multiple: true } });
    expect((await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Assignee: [mate.id, owner.id] } })).code).toBe(200);
    await add({ Name: "Olivia's", Assignee: [owner.id] });

    const mine = await records({
      filters: { conjunction: "and", conditions: [{ id: "c", fieldId: u.id, operator: "hasAnyOf", value: [owner.id] }] },
      sorts: [{ fieldId: u.id, direction: "asc" }],
    });
    expect(mine.records.map((r: any) => r.cells[F.Name.id]).sort()).toEqual(["Assigned", "Olivia's"]);
    expect(mine.labels[owner.id]).toBe("Olivia Owner");
  });

  it("imports people by email or name, and amounts with symbols", async () => {
    const r = await owner.call("POST", `/api/tables/${tableId}/records/batch`, {
      typecast: true,
      records: [{ cells: { Name: "Imported", Assignee: "arun@studio.test, Olivia Owner", Fee: "₹1,200", "Edit time": "2h 15m", Score: "3" } }],
    });
    expect(r.code, JSON.stringify(r.body)).toBe(200);
    await fieldsNow();
    const rec = (await records({ filters: { conjunction: "and", conditions: [] }, sorts: [] })).records.find((x: any) => x.id === r.body.ids[0]);
    expect(rec.cells[F.Assignee.id]).toEqual([mate.id, owner.id]);
    expect(rec.cells[F.Fee.id]).toBe(1200);
    expect(rec.cells[F["Edit time"].id]).toBe(8100);
    expect(rec.cells[F.Score.id]).toBe(3);
  });

  it("exports readable values to CSV", async () => {
    await records({ filters: { conjunction: "and", conditions: [] }, sorts: [], hiddenFieldIds: [] });
    const res = await app.inject({ method: "GET", url: `/api/views/${viewId}/export.csv`, cookies: { brill_sid: owner.sid } });
    expect(res.statusCode).toBe(200);
    const row = res.body.split("\n").find((l) => l.startsWith("Imported"))!;
    expect(row).toContain("Arun Editor, Olivia Owner"); // people by name
    expect(row).toContain("2:15"); // duration as h:mm
    expect(row).toContain("1200"); // currency as a plain number for spreadsheets
  });
});
