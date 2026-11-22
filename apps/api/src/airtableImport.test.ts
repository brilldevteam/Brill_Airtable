import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { convertFormula, convertValue, mapColor, plainSpec, rollupAggregation } from "./airtableImport";
import { openDb, type Db } from "./db";

// A stand-in for Airtable's Web API: one base, two linked tables, records over two pages.
const id = (p: string, n: string) => (p + n.padEnd(14, "x")).slice(0, p.length + 14);
const BASE = id("app", "Content");
const T_POSTS = id("tbl", "Posts");
const T_CLIENTS = id("tbl", "Clients");
const F = {
  name: id("fld", "Name"), date: id("fld", "Date"), type: id("fld", "Type"), media: id("fld", "Media"), done: id("fld", "Done"),
  progress: id("fld", "Progress"), client: id("fld", "Client"), clientName: id("fld", "ClientName"), caption: id("fld", "Caption"),
  words: id("fld", "Words"), broken: id("fld", "Broken"), owner: id("fld", "Owner"),
  cName: id("fld", "CName"), cPosts: id("fld", "CPosts"), cCount: id("fld", "CCount"),
};
const tables = [
  {
    id: T_POSTS, name: "Posts", primaryFieldId: F.name,
    fields: [
      { id: F.name, name: "Name", type: "singleLineText" },
      { id: F.date, name: "Date", type: "date", options: { dateFormat: { name: "friendly", format: "LL" } } },
      { id: F.type, name: "Post Type", type: "singleSelect", options: { choices: [{ id: "sel1", name: "Image Post", color: "greenLight2" }, { id: "sel2", name: "Video Post", color: "yellowBright" }] } },
      { id: F.media, name: "Media File", type: "multipleAttachments", options: {} },
      { id: F.done, name: "Posted", type: "checkbox", options: {} },
      { id: F.progress, name: "Progress", type: "percent", options: { precision: 0 } },
      { id: F.client, name: "Client", type: "multipleRecordLinks", options: { linkedTableId: T_CLIENTS, inverseLinkFieldId: F.cPosts } },
      { id: F.clientName, name: "Client name", type: "multipleLookupValues", options: { recordLinkFieldId: F.client, fieldIdInLinkedTable: F.cName, result: { type: "singleLineText" } } },
      { id: F.caption, name: "Caption", type: "multilineText" },
      { id: F.words, name: "Caption length", type: "formula", options: { formula: `LEN({${F.caption}})`, referencedFieldIds: [F.caption], result: { type: "number", options: { precision: 0 } } } },
      { id: F.broken, name: "Odd formula", type: "formula", options: { formula: `{${id("fld", "Gone")}} & "!"`, referencedFieldIds: [], result: { type: "singleLineText" } } },
      { id: F.owner, name: "Owner", type: "singleCollaborator", options: {} },
    ],
    views: [
      { id: id("viw", "All"), name: "All posts", type: "grid", visibleFieldIds: [F.name, F.date, F.type, F.media] },
      { id: id("viw", "Board"), name: "Board", type: "kanban" },
      { id: id("viw", "Time"), name: "Timeline", type: "timeline" },
    ],
  },
  {
    id: T_CLIENTS, name: "Clients", primaryFieldId: F.cName,
    fields: [
      { id: F.cName, name: "Client", type: "singleLineText" },
      { id: F.cPosts, name: "Posts", type: "multipleRecordLinks", options: { linkedTableId: T_POSTS, inverseLinkFieldId: F.client } },
      { id: F.cCount, name: "Post count", type: "count", options: { recordLinkFieldId: F.cPosts } },
    ],
    views: [{ id: id("viw", "Grid2"), name: "Grid view", type: "grid" }],
  },
];
const R = { gyro: id("rec", "Gyro"), p1: id("rec", "P1"), p2: id("rec", "P2"), p3: id("rec", "P3") };
const posts = [
  { id: R.p1, createdTime: "2025-12-01T09:00:00.000Z", fields: {
    [F.name]: "Sleeve launch", [F.date]: "2025-12-01", [F.type]: "Image Post", [F.done]: true, [F.progress]: 0.5,
    [F.media]: [{ id: "att1", url: "https://dl.airtable.test/a/brief.pdf", filename: "brief.pdf", type: "application/pdf", size: 8 }],
    [F.client]: [R.gyro], [F.clientName]: ["Gyroteq"], [F.caption]: "Built for clean lifts", [F.words]: 21, [F.broken]: "x!",
    [F.owner]: { id: "usr1", email: "a@b.test", name: "Aadhil" },
  } },
  { id: R.p2, createdTime: "2025-12-02T09:00:00.000Z", fields: { [F.name]: "Chalk reel", [F.date]: "2025-12-02", [F.type]: "Video Post", [F.client]: [R.gyro] } },
  { id: R.p3, createdTime: "2025-12-03T09:00:00.000Z", fields: { [F.name]: "Empty day", [F.date]: "2025-12-03" } },
];
const clients = [{ id: R.gyro, createdTime: "2025-11-20T10:00:00.000Z", fields: { [F.cName]: "Gyroteq", [F.cPosts]: [R.p1, R.p2], [F.cCount]: 2 } }];

let server: Server;
let apiUrl: string;
const TOKEN = "patTESTtoken.0123456789";

let db: Db;
let app: ReturnType<typeof buildApp>;
let sid: string;
const call = async (m: string, u: string, p?: unknown) => {
  const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
  return { code: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { type: "AUTHENTICATION_REQUIRED" } });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v0/meta/bases") return send(200, { bases: [{ id: BASE, name: "Gyroteq", permissionLevel: "create" }] });
    if (url.pathname === `/v0/meta/bases/${BASE}/tables`) return send(200, { tables });
    if (url.pathname === `/v0/${BASE}/${T_POSTS}`) {
      // Two pages, to exercise paging.
      return url.searchParams.get("offset") === "page2" ? send(200, { records: posts.slice(2) }) : send(200, { records: posts.slice(0, 2), offset: "page2" });
    }
    if (url.pathname === `/v0/${BASE}/${T_CLIENTS}`) return send(200, { records: clients });
    send(404, { error: "NOT_FOUND" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  db = await openDb("memory://");
  app = buildApp(db, {
    filesDir: mkdtempSync(join(tmpdir(), "brill-at-")),
    airtable: {
      apiUrl, minGapMs: 0,
      fetchFile: async (url) => ({ stream: Readable.from([Buffer.from("%PDF-1.4")]), mime: "application/pdf", filename: url.split("/").pop()!, length: 8 }),
    },
  });
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "i@studio.test", name: "Imp", password: "test-pass-2026" } });
  sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
});
afterAll(async () => {
  await app.close();
  await db.close();
  server.close();
});

describe("Airtable field mapping", () => {
  it("maps types, colours, values and rollups", () => {
    expect(mapColor("blueLight2")).toBe("blue");
    expect(mapColor("tealBright")).toBe("teal");
    expect(mapColor("purpleDark1")).toBe("purple");
    expect(mapColor("weird")).toBe("blue");
    expect(plainSpec({ id: "f", name: "x", type: "dateTime", options: { dateFormat: { name: "european" }, timeFormat: { name: "24hour" } } }))
      .toEqual({ type: "date", options: { includeTime: true, dateFormat: "european", timeFormat: "24" } });
    expect(plainSpec({ id: "f", name: "x", type: "multipleRecordLinks" })).toBeNull();
    expect(convertValue("percent", { type: "percent", options: {} }, 0.255)).toBe(25.5);
    expect(convertValue("singleCollaborator", { type: "singleLineText", options: {} }, { name: "Aadhil", email: "a@b" })).toBe("Aadhil");
    expect(convertValue("multipleCollaborators", { type: "singleLineText", options: {} }, [{ name: "A" }, { name: "B" }])).toBe("A, B");
    expect(convertValue("barcode", { type: "singleLineText", options: {} }, { text: "123" })).toBe("123");
    expect(rollupAggregation("SUM(values)")).toBe("sum");
    expect(rollupAggregation("ARRAYJOIN(ARRAYUNIQUE(values))")).toBe("joinUnique");
    expect(rollupAggregation("values * 2")).toBeNull();
    expect(convertFormula(`{${F.caption}} & "x"`, new Map([[F.caption, "Caption"]]))).toBe(`{Caption} & "x"`);
    expect(convertFormula(`{${F.caption}}`, new Map())).toBeNull();
  });
});

describe("importing a base from Airtable", () => {
  it("rejects a wrong token with a clear message", async () => {
    const r = await call("POST", "/api/import/airtable/bases", { token: "patWRONGtoken.000" });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/didn't accept that token/);
  });

  it("brings over tables, fields, records, files, links, calculations and views", async () => {
    const list = await call("POST", "/api/import/airtable/bases", { token: TOKEN });
    expect(list.body.bases).toEqual([{ id: BASE, name: "Gyroteq", permissionLevel: "create" }]);
    const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
    const start = await call("POST", "/api/import/airtable", { token: TOKEN, workspaceId: ws, bases: [{ id: BASE, name: "Gyroteq" }] });
    expect(start.code).toBe(200);
    let job = start.body.job;
    for (let i = 0; i < 200 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await call("GET", `/api/import/jobs/${job.id}`)).body.job;
    }
    expect(job.status).toBe("done");
    const jb = job.bases[0];
    expect(jb).toMatchObject({ status: "done", tables: 2, records: 4, files: 1 });
    expect(JSON.stringify(job)).not.toContain(TOKEN); // the token is never echoed back

    const base = (await call("GET", `/api/bases/${jb.baseId}`)).body;
    const tbls = base.tables ?? base.base.tables;
    expect(tbls.map((t: any) => t.name)).toEqual(["Posts", "Clients"]);
    const postsT = (await call("GET", `/api/tables/${tbls[0].id}`)).body;
    const byName = Object.fromEntries(postsT.fields.map((f: any) => [f.name, f]));
    expect(byName["Name"].id).toBe(postsT.table.primaryFieldId);
    expect(byName["Date"]).toMatchObject({ type: "date", options: { dateFormat: "friendly" } });
    expect(byName["Post Type"].options.choices.map((c: any) => [c.name, c.color])).toEqual([["Image Post", "green"], ["Video Post", "yellow"]]);
    expect(byName["Media File"].type).toBe("attachment");
    expect(byName["Client"].type).toBe("link");
    expect(byName["Client name"].type).toBe("lookup");
    expect(byName["Caption length"].type).toBe("formula");
    expect(byName["Odd formula"].type).toBe("longText"); // kept as values
    expect(byName["Owner"].type).toBe("singleLineText");
    // No leftovers from a new table's defaults.
    expect(byName["Notes"]).toBeUndefined();
    expect(byName["Status"]).toBeUndefined();

    const grid = postsT.views.find((v: any) => v.name === "All posts");
    const recs = (await call("GET", `/api/views/${grid.id}/records`)).body.records;
    expect(recs).toHaveLength(3);
    const p1 = recs.find((r: any) => r.cells[byName["Name"].id] === "Sleeve launch");
    expect(p1.cells[byName["Date"].id]).toBe("2025-12-01");
    expect(p1.cells[byName["Posted"].id]).toBe(true);
    expect(p1.cells[byName["Progress"].id]).toBe(50);
    expect(p1.cells[byName["Media File"].id]).toHaveLength(1);
    expect(p1.cells[byName["Client"].id]).toHaveLength(1);
    expect(p1.cells[byName["Client name"].id]).toEqual(["Gyroteq"]);
    expect(p1.cells[byName["Caption length"].id]).toBe(21);
    expect(p1.cells[byName["Odd formula"].id]).toBe("x!");
    expect(p1.cells[byName["Owner"].id]).toBe("Aadhil");
    expect(p1.createdAt).toBe("2025-12-01T09:00:00.000Z");

    // The other side of the link, and a count over it.
    const clientsT = (await call("GET", `/api/tables/${tbls[1].id}`)).body;
    const cf = Object.fromEntries(clientsT.fields.map((f: any) => [f.name, f]));
    expect(cf["Posts"].type).toBe("link");
    expect(cf["Post count"].type).toBe("count");
    const gyro = (await call("GET", `/api/views/${clientsT.views[0].id}/records`)).body.records[0];
    expect(gyro.cells[cf["Posts"].id]).toHaveLength(2);
    expect(gyro.cells[cf["Post count"].id]).toBe(2);

    // Views: names, types, visible fields; unsupported types become grids with a note.
    expect(postsT.views.map((v: any) => [v.name, v.type])).toEqual([["All posts", "grid"], ["Board", "kanban"], ["Timeline", "grid"]]);
    expect(grid.config.hiddenFieldIds).toContain(byName["Caption"].id);
    expect(grid.config.hiddenFieldIds).not.toContain(byName["Date"].id);
    expect(grid.config.fieldOrder.slice(0, 4)).toEqual([byName["Name"].id, byName["Date"].id, byName["Post Type"].id, byName["Media File"].id]);
    expect(jb.notes.join("\n")).toMatch(/Odd formula: kept as values/);
    expect(jb.notes.join("\n")).toMatch(/timeline views aren't here yet/);
  });

  it("only lets creators import into a workspace", async () => {
    const r = await call("POST", "/api/import/airtable", { token: TOKEN, workspaceId: "wspNope", bases: [{ id: BASE, name: "x" }] });
    expect(r.code).toBe(403);
  });
});
