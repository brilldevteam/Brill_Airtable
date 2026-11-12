import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { csvCell, parseLooseDate, parseLooseNumber } from "./importExport";

let db: Db;
let app: ReturnType<typeof buildApp>;
let sid: string;
let baseId: string;

async function req(method: string, url: string, payload?: unknown, cookie = sid) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, cookies: cookie ? { brill_sid: cookie } : {} });
  return { code: r.statusCode, body: r.headers["content-type"]?.includes("json") ? r.json() : r.body, raw: r };
}
async function call(method: string, url: string, payload?: unknown) {
  const r = await req(method, url, payload);
  if (r.code >= 400) throw new Error(`${method} ${url} -> ${r.code} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function signUp(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: "U", password: "password123" } });
  return res.cookies.find((c) => c.name === "brill_sid")!.value;
}
function multipart(files: { name: string; type: string; data: Buffer }[], extraHeaders: Record<string, string> = { "x-brill-upload": "1" }) {
  const boundary = "----brilltest" + Math.random().toString(16).slice(2);
  const parts = files.map((f) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.data,
      Buffer.from("\r\n"),
    ]),
  );
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...extraHeaders },
  };
}
async function upload(tableId: string, files: { name: string; type: string; data: Buffer }[], cookie = sid, headers?: Record<string, string>) {
  const m = multipart(files, headers);
  const r = await app.inject({ method: "POST", url: `/api/tables/${tableId}/attachments`, payload: m.payload, headers: m.headers, cookies: { brill_sid: cookie } });
  return { code: r.statusCode, body: r.json() };
}
async function makeTable(name: string) {
  const { table } = await call("POST", `/api/bases/${baseId}/tables`, { name });
  const d = await call("GET", `/api/tables/${table.id}`);
  for (const r of (await call("GET", `/api/views/${d.views[0].id}/records`)).records) await call("DELETE", `/api/records/${r.id}`);
  return { id: table.id as string, viewId: d.views[0].id as string };
}

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-files-")) });
  await app.ready();
  sid = await signUp("files@example.com");
  const ws = await call("GET", "/api/workspaces");
  baseId = (await call("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Files" })).base.id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("attachments", () => {
  let t: { id: string; viewId: string };
  let field: any;
  let png: Buffer;

  beforeAll(async () => {
    t = await makeTable("Designs");
    field = (await call("POST", `/api/tables/${t.id}/fields`, { name: "Files", type: "attachment" })).field;
    png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#4f46e5" } }).png().toBuffer();
  });

  it("uploads images (with thumbnail) and other files", async () => {
    const r = await upload(t.id, [
      { name: "logo.png", type: "image/png", data: png },
      { name: "brief.txt", type: "text/plain", data: Buffer.from("hello") },
    ]);
    expect(r.code).toBe(200);
    const [img, txt] = r.body.attachments;
    expect(img).toMatchObject({ filename: "logo.png", mime: "image/png", width: 800, height: 600 });
    expect(img.thumbUrl).toBeTruthy();
    expect(txt.thumbUrl).toBeNull();

    const rec = await call("POST", `/api/tables/${t.id}/records`, { cells: { Name: "Poster", Files: [img.id, txt.id] } });
    const view = await call("GET", `/api/views/${t.viewId}/records`);
    expect(view.records.find((x: any) => x.id === rec.record.id).cells[field.id]).toEqual([img.id, txt.id]);
    expect(view.files[img.id].filename).toBe("logo.png");
    expect(view.labels[txt.id]).toBe("brief.txt");

    const file = await req("GET", img.url);
    expect(file.code).toBe(200);
    expect(file.raw.headers["content-type"]).toBe("image/png");
    expect(file.raw.rawPayload.length).toBe(png.length);
    const thumb = await req("GET", img.thumbUrl);
    expect(thumb.raw.headers["content-type"]).toBe("image/webp");
    expect((await sharp(thumb.raw.rawPayload).metadata()).width).toBe(480);
  });

  it("serves risky types as downloads, never inline", async () => {
    const r = await upload(t.id, [{ name: "x.html", type: "text/html", data: Buffer.from("<script>alert(1)</script>") }]);
    const f = await req("GET", r.body.attachments[0].url);
    expect(f.raw.headers["content-type"]).toBe("application/octet-stream");
    expect(f.raw.headers["content-disposition"]).toMatch(/^attachment/);
    expect(f.raw.headers["content-security-policy"]).toMatch(/sandbox/);
  });

  it("requires the upload header (CSRF guard) and table access", async () => {
    expect((await upload(t.id, [{ name: "a.txt", type: "text/plain", data: Buffer.from("a") }], sid, {})).code).toBe(415);
    const other = await signUp("other@example.com");
    expect((await upload(t.id, [{ name: "a.txt", type: "text/plain", data: Buffer.from("a") }], other)).code).toBe(404);
    const mine = await upload(t.id, [{ name: "a.txt", type: "text/plain", data: Buffer.from("a") }]);
    expect((await req("GET", mine.body.attachments[0].url, undefined, other)).code).toBe(404);
  });

  it("rejects attachment ids from another table", async () => {
    const t2 = await makeTable("Other");
    const a = await upload(t2.id, [{ name: "a.txt", type: "text/plain", data: Buffer.from("a") }]);
    const r = await req("POST", `/api/tables/${t.id}/records`, { cells: { Files: [a.body.attachments[0].id] } });
    expect(r.code).toBe(422);
  });

  it("formulas and lookups see filenames", async () => {
    const f = (await call("POST", `/api/tables/${t.id}/fields`, { name: "Names", type: "formula", options: { formula: "ARRAYJOIN({Files}, ' | ')" } })).field;
    const a = await upload(t.id, [{ name: "one.pdf", type: "application/pdf", data: Buffer.from("%PDF") }]);
    const rec = await call("POST", `/api/tables/${t.id}/records`, { cells: { Name: "Doc", Files: [a.body.attachments[0].id] } });
    expect(rec.record.cells[f.id]).toBe("one.pdf");
  });
});

describe("batch import with typecast", () => {
  it("converts loose values, adds select options and links by name", async () => {
    const cust = await makeTable("Clients");
    const orders = await makeTable("Jobs");
    await call("POST", `/api/tables/${orders.id}/fields`, { name: "Amount", type: "number", options: { precision: 2 } });
    await call("POST", `/api/tables/${orders.id}/fields`, { name: "Due", type: "date" });
    await call("POST", `/api/tables/${orders.id}/fields`, { name: "Paid", type: "checkbox" });
    await call("POST", `/api/tables/${orders.id}/fields`, { name: "Tags", type: "multipleSelect", options: { choices: [{ name: "Print" }] } });
    const link = (await call("POST", `/api/tables/${orders.id}/fields`, { name: "Client", type: "link", options: { linkedTableId: cust.id } })).field;
    await call("POST", `/api/tables/${cust.id}/records`, { cells: { Name: "Acme" } });

    const res = await call("POST", `/api/tables/${orders.id}/records/batch`, {
      typecast: true,
      records: [
        { cells: { Name: "Banner", Amount: "₹1,250.50", Due: "31/12/2026", Paid: "Yes", Status: "Done", Tags: "print, Rush", Client: "acme" } },
        { cells: { Name: "Flyers", Amount: "", Due: "2026-01-05", Paid: "no", Status: "Blocked", Client: "New Client Ltd" } },
      ],
    });
    expect(res.created).toBe(2);

    const d = await call("GET", `/api/tables/${orders.id}`);
    const F = Object.fromEntries(d.fields.map((f: any) => [f.name, f]));
    const recs = (await call("GET", `/api/views/${d.views[0].id}/records`)).records;
    const [a, b] = recs;
    expect(a.cells[F.Amount.id]).toBe(1250.5);
    expect(a.cells[F.Due.id]).toBe("2026-12-31");
    expect(a.cells[F.Paid.id]).toBe(true);
    expect(F.Tags.options.choices.map((c: any) => c.name)).toEqual(["Print", "Rush"]);
    expect(F.Status.options.choices.map((c: any) => c.name)).toContain("Blocked");
    expect(b.cells[F.Paid.id]).toBeUndefined();

    // Linked by name (case-insensitive), and a new client was created for the unknown name.
    const clients = (await call("GET", `/api/views/${(await call("GET", `/api/tables/${cust.id}`)).views[0].id}/records`)).records;
    expect(clients).toHaveLength(2);
    expect(a.cells[link.id]).toEqual([clients[0].id]);
    expect(b.cells[link.id]).toEqual([clients[1].id]);
  });

  it("rolls back the whole batch and names the failing row", async () => {
    const t = await makeTable("Strict");
    await call("POST", `/api/tables/${t.id}/fields`, { name: "Email", type: "email" });
    const r = await req("POST", `/api/tables/${t.id}/records/batch`, {
      records: [{ cells: { Name: "ok", Email: "a@b.co" } }, { cells: { Name: "bad", Email: "nope" } }],
    });
    expect(r.code).toBe(422);
    expect(r.body.error).toMatch(/^Row 2:/);
    const d = await call("GET", `/api/tables/${t.id}`);
    expect((await call("GET", `/api/views/${d.views[0].id}/records`)).records).toHaveLength(0);
  });
});

describe("CSV export", () => {
  it("exports visible fields in view order, with view filters, escaping and formula guard", async () => {
    const t = await makeTable("Export");
    await call("POST", `/api/tables/${t.id}/fields`, { name: "Amount", type: "number" });
    await call("POST", `/api/tables/${t.id}/records/batch`, {
      records: [
        { cells: { Name: 'Say "hi", world', Amount: -5, Notes: "secret" } },
        { cells: { Name: "=HYPERLINK(1)", Amount: 10 } },
        { cells: { Name: "skip me", Amount: 99 } },
      ],
    });
    const d = await call("GET", `/api/tables/${t.id}`);
    const F = Object.fromEntries(d.fields.map((f: any) => [f.name, f]));
    await call("PATCH", `/api/views/${t.viewId}`, {
      config: {
        hiddenFieldIds: [F.Notes.id, F.Status.id],
        filters: { conditions: [{ id: "c", fieldId: F.Amount.id, operator: "<", value: 50 }] },
      },
    });
    const r = await req("GET", `/api/views/${t.viewId}/export.csv`);
    expect(r.raw.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.raw.headers["content-disposition"]).toMatch(/Export/);
    const lines = r.raw.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toEqual(["Name,Amount", '"Say ""hi"", world",-5', "'=HYPERLINK(1),10"]);
  });
});

describe("loose value parsing", () => {
  it("dates", () => {
    expect(parseLooseDate("31/12/2026", "dmy")).toBe("2026-12-31");
    expect(parseLooseDate("12/31/2026", "mdy")).toBe("2026-12-31");
    expect(parseLooseDate("31/02/2026", "dmy")).toBeNull();
    expect(parseLooseDate("5.1.26", "dmy")).toBe("2026-01-05");
  });
  it("numbers", () => {
    expect(parseLooseNumber("₹ 1,23,456.75")).toBe(123456.75);
    expect(parseLooseNumber("(200)")).toBe(-200);
    expect(parseLooseNumber("-3.5%")).toBe(-3.5);
    expect(parseLooseNumber("abc")).toBeNull();
  });
  it("csv cells", () => {
    expect(csvCell("plain", true)).toBe("plain");
    expect(csvCell("a,b", true)).toBe('"a,b"');
    expect(csvCell("-5", false)).toBe("-5");
    expect(csvCell("@cmd", true)).toBe("'@cmd");
    expect(csvCell("+91 98470 11111", true)).toBe("+91 98470 11111");
    expect(csvCell("+cmd|calc", true)).toBe("'+cmd|calc");
  });
});
