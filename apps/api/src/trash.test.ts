import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;
type Res = { code: number; body: any };
let call: (m: string, u: string, p?: unknown) => Promise<Res>;
let baseId: string;
let clientsT: string;
let projectsT: string;
const F: Record<string, string> = {};

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-trash-")) });
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "t@brill.test", name: "Tina Trash", password: "test-pass-2026" } });
  const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  call = async (m, u, p) => {
    const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
    return { code: res.statusCode, body: res.json() };
  };
  const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
  const b = (await call("POST", `/api/workspaces/${ws}/bases`, { name: "Agency" })).body;
  baseId = b.base.id;
  clientsT = b.firstTableId;
  await call("PATCH", `/api/tables/${clientsT}`, { name: "Clients" });
  projectsT = (await call("POST", `/api/bases/${baseId}/tables`, { name: "Projects" })).body.table.id;
  for (const t of [clientsT, projectsT]) {
    const v = (await call("GET", `/api/tables/${t}`)).body.views[0].id;
    for (const rec of (await call("GET", `/api/views/${v}/records`)).body.records) await call("DELETE", `/api/records/${rec.id}/permanent`).then(() => undefined);
  }
  F.link = (await call("POST", `/api/tables/${projectsT}/fields`, { name: "Client", type: "link", options: { linkedTableId: clientsT } })).body.field.id;
  const cf = (await call("GET", `/api/tables/${clientsT}`)).body.fields;
  F.inverse = cf.find((f: any) => f.name === "Projects").id;
  F.count = (await call("POST", `/api/tables/${clientsT}/fields`, { name: "Project count", type: "count", options: { linkFieldId: F.inverse } })).body.field.id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const get = async (id: string) => (await db.one(`SELECT cells, deleted_at FROM records WHERE id=$1`, [id]))!;
const create = async (t: string, cells: object) => (await call("POST", `/api/tables/${t}/records`, { cells })).body.record.id as string;

describe("trash", () => {
  let acme: string;
  let site: string;
  let logo: string;

  it("lists deleted records with their table, name, details and who deleted them", async () => {
    acme = await create(clientsT, { Name: "Acme" });
    site = await create(projectsT, { Name: "Website", Client: [acme], Notes: "Phase 1" });
    logo = await create(projectsT, { Name: "Logo", Client: [acme] });
    expect((await get(acme)).cells[F.count]).toBe(2);

    expect((await call("DELETE", `/api/records/${site}`)).code).toBe(200);
    expect((await get(acme)).cells[F.inverse]).toEqual([logo]);
    expect((await get(acme)).cells[F.count]).toBe(1);

    const trash = (await call("GET", `/api/bases/${baseId}/trash`)).body;
    expect(trash.days).toBe(30);
    const item = trash.items.find((i: any) => i.id === site);
    expect(item).toMatchObject({ tableName: "Projects", name: "Website", deletedBy: "Tina Trash" });
    expect(item.details.map((d: any) => d.value)).toContain("Acme");
  });

  it("restores a record and puts it back into its links", async () => {
    const r = await call("POST", `/api/records/${site}/restore`, {});
    expect(r.code).toBe(200);
    expect((await get(site)).deleted_at).toBeNull();
    expect((await get(acme)).cells[F.inverse]).toEqual([logo, site]);
    expect((await get(acme)).cells[F.count]).toBe(2);
    const hist = (await call("GET", `/api/records/${site}/history`)).body.entries.map((e: any) => e.kind);
    expect(hist[0]).toBe("restore");
    expect((await call("GET", `/api/bases/${baseId}/trash`)).body.items.some((i: any) => i.id === site)).toBe(false);
    // Restoring something that isn't deleted is refused.
    expect((await call("POST", `/api/records/${site}/restore`, {})).code).toBe(404);
  });

  it("skips links to records that are still deleted, and reconnects them when those come back", async () => {
    await call("DELETE", `/api/records/${logo}`);
    await call("DELETE", `/api/records/${acme}`);
    // Restore the project first: its client is still in the trash.
    await call("POST", `/api/records/${logo}/restore`, {});
    expect((await get(logo)).cells[F.link]).toBeUndefined();
    // Restoring the client links both projects again.
    await call("POST", `/api/records/${acme}/restore`, {});
    expect([...(await get(acme)).cells[F.inverse]].sort()).toEqual([site, logo].sort());
    expect((await get(logo)).cells[F.link]).toEqual([acme]);
    expect((await get(site)).cells[F.link]).toEqual([acme]);
    expect((await get(acme)).cells[F.count]).toBe(2);
  });

  it("deletes for good, and leaves out records older than 30 days", async () => {
    const tmp = await create(projectsT, { Name: "Temp" });
    await call("DELETE", `/api/records/${tmp}`);
    expect((await call("DELETE", `/api/records/${tmp}/permanent`)).code).toBe(200);
    expect(await db.one(`SELECT 1 FROM records WHERE id=$1`, [tmp])).toBeFalsy();
    // Can't permanently delete a live record.
    expect((await call("DELETE", `/api/records/${site}/permanent`)).code).toBe(404);

    const old = await create(projectsT, { Name: "Ancient" });
    await call("DELETE", `/api/records/${old}`);
    await db.query(`UPDATE records SET deleted_at = now() - interval '31 days' WHERE id=$1`, [old]);
    expect((await call("GET", `/api/bases/${baseId}/trash`)).body.items.some((i: any) => i.id === old)).toBe(false);
  });

  it("needs edit access", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "x@brill.test", name: "X", password: "test-pass-2026" } });
    const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
    const res = await app.inject({ method: "GET", url: `/api/bases/${baseId}/trash`, cookies: { brill_sid: sid } });
    expect(res.statusCode).toBe(404);
  });
});
