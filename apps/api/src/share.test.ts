import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";

let db: Db;
let app: ReturnType<typeof buildApp>;
let sid: string;
let tableId: string;
let F: Record<string, any>;

async function call(method: string, url: string, payload?: unknown, cookie: string | null = sid, headers: Record<string, string> = {}) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers, cookies: cookie ? { brill_sid: cookie } : {} });
  let body: any = r.body;
  try { body = r.json(); } catch { /* not JSON */ }
  return { code: r.statusCode, body, raw: r };
}
const pub = (method: string, url: string, payload?: unknown) => call(method, url, payload, null);
function multipart(name: string, type: string, data: Buffer) {
  const b = "----s" + Math.random().toString(16).slice(2);
  return {
    payload: Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${b}`, "x-brill-upload": "1" },
  };
}

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-share-")) });
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "s@brill.test", name: "Sam", password: "test-pass-2026" } });
  sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  const ws = (await call("GET", "/api/workspaces")).body;
  tableId = (await call("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Requests" })).body.firstTableId;
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Email", type: "email" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Budget", type: "number" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Brief", type: "attachment" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Internal notes", type: "longText" });
  await call("POST", `/api/tables/${tableId}/fields`, { name: "Budget x2", type: "formula", options: { formula: "{Budget} * 2" } });
  F = Object.fromEntries((await call("GET", `/api/tables/${tableId}`)).body.fields.map((f: any) => [f.name, f]));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("form views", () => {
  let viewId: string;
  let token: string;

  it("a new form view asks for every form-friendly field, name first and required", async () => {
    const { view } = (await call("POST", `/api/tables/${tableId}/views`, { name: "Request form", type: "form" })).body;
    viewId = view.id;
    const ids = view.config.form.fields.map((f: any) => f.fieldId);
    expect(ids[0]).toBe(F.Name.id);
    expect(view.config.form.fields[0].required).toBe(true);
    expect(ids).toContain(F.Brief.id);
    expect(ids).not.toContain(F["Budget x2"].id); // calculated fields can't be on a form
    // Keep the form small for the tests: no internal notes / status, email required.
    await call("PATCH", `/api/views/${viewId}`, {
      config: {
        ...view.config,
        form: {
          ...view.config.form,
          title: "Request a design",
          fields: [
            { fieldId: F.Name.id, required: true, label: "Project name" },
            { fieldId: F.Email.id, required: true },
            { fieldId: F.Budget.id },
            { fieldId: F.Brief.id, help: "PDF or images" },
          ],
        },
      },
    });
  });

  it("is private until shared; then the link shows only the form's fields", async () => {
    expect((await call("GET", `/api/views/${viewId}/share`)).body.share).toBeNull();
    token = (await call("POST", `/api/views/${viewId}/share`, {})).body.share.token;
    expect(token.length).toBeGreaterThanOrEqual(24);
    const form = (await pub("GET", `/api/public/forms/${token}`)).body.form;
    expect(form.title).toBe("Request a design");
    expect(form.fields.map((f: any) => f.label)).toEqual(["Project name", "Email", "Budget", "Brief"]);
    expect(JSON.stringify(form)).not.toContain("Internal notes");
  });

  it("validates answers, accepts a submission with a file, and records it", async () => {
    let r = await pub("POST", `/api/public/forms/${token}/submit`, { cells: { [F.Name.id]: "Logo", [F.Email.id]: "nope" } });
    expect(r.code).toBe(422);
    expect(r.body.error).toMatch(/Email/);

    r = await pub("POST", `/api/public/forms/${token}/submit`, { cells: { [F.Email.id]: "a@b.co" } });
    expect(r.body.error).toMatch(/Project name is required/);

    // Fields not on the form are refused.
    r = await pub("POST", `/api/public/forms/${token}/submit`, { cells: { [F.Name.id]: "x", [F.Email.id]: "a@b.co", [F["Internal notes"].id]: "sneaky" } });
    expect(r.code).toBe(400);

    const m = multipart("brief.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    const up = await app.inject({ method: "POST", url: `/api/public/forms/${token}/attachments`, payload: m.payload, headers: m.headers });
    const att = up.json().attachments[0];
    expect(att.filename).toBe("brief.pdf");
    expect(att.url).toBeUndefined();

    r = await pub("POST", `/api/public/forms/${token}/submit`, {
      cells: { [F.Name.id]: "Café logo", [F.Email.id]: "chef@cafe.in", [F.Budget.id]: "15000", [F.Brief.id]: [att.id] },
    });
    expect(r.code).toBe(200);
    const grid = (await call("GET", `/api/tables/${tableId}`)).body.views[0].id;
    const rec = (await call("GET", `/api/views/${grid}/records`)).body.records.find((x: any) => x.cells[F.Name.id] === "Café logo");
    expect(rec.cells[F.Budget.id]).toBe(15000);
    expect(rec.cells[F["Budget x2"].id]).toBe(30000);
    expect(rec.cells[F.Brief.id]).toEqual([att.id]);

    // The same uploaded file can't be reused in another submission.
    r = await pub("POST", `/api/public/forms/${token}/submit`, { cells: { [F.Name.id]: "dup", [F.Email.id]: "a@b.co", [F.Brief.id]: [att.id] } });
    expect(r.code).toBe(422);
  });

  it("regenerating kills the old link; turning it off hides the form", async () => {
    const fresh = (await call("POST", `/api/views/${viewId}/share`, { regenerate: true })).body.share.token;
    expect(fresh).not.toBe(token);
    expect((await pub("GET", `/api/public/forms/${token}`)).code).toBe(404);
    expect((await pub("GET", `/api/public/forms/${fresh}`)).code).toBe(200);
    await call("DELETE", `/api/views/${viewId}/share`);
    expect((await pub("GET", `/api/public/forms/${fresh}`)).code).toBe(404);
  });

  it("only creators can share; editors can't", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "e@brill.test", name: "Ed", password: "test-pass-2026" } });
    const ed = r.cookies.find((c) => c.name === "brill_sid")!.value;
    const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
    const inv = (await call("POST", `/api/workspaces/${ws}/invites`, { email: "e@brill.test", role: "editor" })).body.invite;
    await db.query(`UPDATE users SET email_verified_at=now() WHERE email='e@brill.test'`);
    expect((await call("POST", `/api/invites/${inv.token}/accept`, {}, ed)).code).toBe(200);
    expect((await call("POST", `/api/views/${viewId}/share`, {}, ed)).code).toBe(403);
  });
});

describe("shared views", () => {
  it("shows visible fields only, with the view's filter, and serves its files", async () => {
    const grid = (await call("GET", `/api/tables/${tableId}`)).body.views[0];
    await call("PATCH", `/api/views/${grid.id}`, {
      config: {
        ...grid.config,
        hiddenFieldIds: [F["Internal notes"].id, F.Email.id],
        filters: { conditions: [{ id: "c", fieldId: F.Budget.id, operator: ">", value: 0 }] },
      },
    });
    await call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "Secret", "Internal notes": "do not share", Budget: 5 } });
    const token = (await call("POST", `/api/views/${grid.id}/share`, {})).body.share.token;
    const v = (await pub("GET", `/api/public/views/${token}`)).body;
    expect(v.fields.map((f: any) => f.name)).not.toContain("Internal notes");
    expect(v.fields.map((f: any) => f.name)).not.toContain("Email");
    expect(JSON.stringify(v.records)).not.toContain("do not share");
    expect(JSON.stringify(v.records)).not.toContain("chef@cafe.in");
    expect(v.records.every((r: any) => r.cells[F.Budget.id] > 0)).toBe(true);

    const fileId = Object.keys(v.files)[0];
    const file = await pub("GET", v.files[fileId].url);
    expect(file.code).toBe(200);
    expect(file.raw.rawPayload.toString()).toBe("%PDF-1.4");
    // A form token can't be used to read data.
    expect((await pub("GET", `/api/public/forms/${token}`)).code).toBe(404);
  });
});
