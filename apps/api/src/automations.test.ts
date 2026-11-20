import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { logMailer } from "./mail";

let db: Db;
let app: ReturnType<typeof buildApp>;
const mailer = logMailer({ quiet: true });
type Res = { code: number; body: any };
let sid: string;
const call = async (m: string, u: string, p?: unknown, cookie = sid): Promise<Res> => {
  const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: cookie } });
  return { code: res.statusCode, body: res.json() };
};
let baseId: string;
let tasks: string;
let log: string;
const F: Record<string, any> = {};
const L: Record<string, any> = {};
const choice = (name: string) => F.Status.options.choices.find((c: any) => c.name === name).id;
const cell = async (id: string, fieldId: string) => (await db.one(`SELECT cells FROM records WHERE id=$1`, [id]))!.cells[fieldId];
const runs = async (id: string) => (await call("GET", `/api/automations/${id}/runs`)).body.runs;
const settle = () => app.automations.idle();

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-auto-")), mailer, appUrl: "https://app.example", allowLoopbackWebhooks: true });
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "ann@studio.test", name: "Ann", password: "test-pass-2026" } });
  sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
  const b = (await call("POST", `/api/workspaces/${ws}/bases`, { name: "Studio" })).body;
  baseId = b.base.id;
  tasks = b.firstTableId;
  await call("POST", `/api/tables/${tasks}/fields`, { name: "Reviewer", type: "email" });
  for (const f of (await call("GET", `/api/tables/${tasks}`)).body.fields) F[f.name] = f;
  log = (await call("POST", `/api/bases/${baseId}/tables`, { name: "Log" })).body.table.id;
  for (const f of (await call("GET", `/api/tables/${log}`)).body.fields) L[f.name] = f;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("automations", () => {
  let doneAuto: string;
  let early: string;

  it("when a record starts matching: update it, email someone from a field, create a log record", async () => {
    early = (await call("POST", `/api/tables/${tasks}/records`, { cells: { Name: "Already done", Status: "Done", Reviewer: "early@client.test" } })).body.record.id;
    const r = await call("POST", `/api/bases/${baseId}/automations`, {
      name: "Task finished",
      enabled: true,
      trigger: { type: "recordMatches", tableId: tasks, conditions: [{ id: "c1", fieldId: F.Status.id, operator: "is", value: choice("Done") }] },
      actions: [
        { type: "updateRecord", fields: { [F.Notes.id]: "Finished: {Name}" } },
        { type: "sendEmail", to: "{Reviewer}, boss@studio.test", subject: "{Name} is done", body: "Hi,\n\n{Name} was marked {Status}.\n\nThanks" },
        { type: "createRecord", tableId: log, fields: { [L.Name.id]: "{Name} done", [L.Status.id]: "Done" } },
      ],
    });
    expect(r.code).toBe(200);
    doneAuto = r.body.automation.id;

    const rec = (await call("POST", `/api/tables/${tasks}/records`, { cells: { Name: "Reel cut", Status: "Todo", Reviewer: "chris@client.test" } })).body.record.id;
    await settle();
    expect(await runs(doneAuto)).toHaveLength(0);

    await call("PATCH", `/api/records/${rec}`, { cells: { Status: "Done" } });
    await settle();
    const [run] = await runs(doneAuto);
    expect(run).toMatchObject({ status: "success", recordId: rec, recordName: "Reel cut", test: false });
    expect(run.steps.map((s: any) => s.ok)).toEqual([true, true, true]);
    expect(await cell(rec, F.Notes.id)).toBe("Finished: Reel cut");
    const mails = mailer.outbox!.filter((m) => m.subject === "Reel cut is done").map((m) => m.to).sort();
    expect(mails).toEqual(["boss@studio.test", "chris@client.test"]);
    expect(mailer.outbox![0].text).toContain("Reel cut was marked Done.");
    const logRecs = (await db.query<any>(`SELECT cells FROM records WHERE table_id=$1 AND deleted_at IS NULL`, [log]))
      .map((x) => x.cells[L.Name.id]);
    expect(logRecs).toContain("Reel cut done");

    // Records that already matched when it was turned on didn't fire.
    expect((await runs(doneAuto)).some((x: any) => x.recordId === early)).toBe(false);

    // Editing it again while it still matches doesn't fire again; leaving and re-entering does.
    await call("PATCH", `/api/records/${rec}`, { cells: { Name: "Reel cut v2" } });
    await settle();
    expect(await runs(doneAuto)).toHaveLength(1);
    await call("PATCH", `/api/records/${rec}`, { cells: { Status: "Todo" } });
    await call("PATCH", `/api/records/${rec}`, { cells: { Status: "Done" } });
    await settle();
    expect(await runs(doneAuto)).toHaveLength(2);
  });

  it("when a record is updated (only chosen fields), and it never re-triggers itself", async () => {
    const a = (await call("POST", `/api/bases/${baseId}/automations`, {
      name: "Stamp", enabled: true,
      trigger: { type: "recordUpdated", tableId: tasks, fieldIds: [F.Reviewer.id] },
      actions: [{ type: "updateRecord", fields: { [F.Notes.id]: "Reviewer is now {Reviewer}" } }],
    })).body.automation.id;
    const rec = (await call("POST", `/api/tables/${tasks}/records`, { cells: { Name: "Logo" } })).body.record.id;
    await call("PATCH", `/api/records/${rec}`, { cells: { Name: "Logo v2" } });
    await settle();
    expect(await runs(a)).toHaveLength(0);
    await call("PATCH", `/api/records/${rec}`, { cells: { Reviewer: "dee@client.test" } });
    await settle();
    expect(await runs(a)).toHaveLength(1);
    expect(await cell(rec, F.Notes.id)).toBe("Reviewer is now dee@client.test");
    await call("PATCH", `/api/automations/${a}`, { enabled: false });
  });

  it("when a record is created, and when a form is submitted (only from that form)", async () => {
    const created = (await call("POST", `/api/bases/${baseId}/automations`, {
      name: "New", enabled: true, trigger: { type: "recordCreated", tableId: log }, actions: [{ type: "updateRecord", fields: { [L.Notes.id]: "auto" } }],
    })).body.automation.id;
    const id = (await call("POST", `/api/tables/${log}/records`, { cells: { Name: "x" } })).body.record.id;
    await settle();
    expect(await cell(id, L.Notes.id)).toBe("auto");
    await call("PATCH", `/api/automations/${created}`, { enabled: false });

    const form = (await call("POST", `/api/tables/${tasks}/views`, { name: "Request", type: "form" })).body.view;
    const share = (await call("POST", `/api/views/${form.id}/share`, {})).body.share.token;
    const viaForm = (await call("POST", `/api/bases/${baseId}/automations`, {
      name: "Thanks", enabled: true, trigger: { type: "formSubmitted", tableId: tasks, viewId: form.id },
      actions: [{ type: "sendEmail", to: "{Reviewer}", subject: "Thanks for {Name}", body: "We got it." }],
    })).body.automation.id;
    await call("POST", `/api/tables/${tasks}/records`, { cells: { Name: "Not from the form", Reviewer: "no@x.test" } });
    const sub = await app.inject({ method: "POST", url: `/api/public/forms/${share}/submit`, payload: { cells: { [F.Name.id]: "Brief", [F.Reviewer.id]: "form@client.test" } } });
    expect(sub.statusCode, sub.body).toBe(200);
    await settle();
    expect((await runs(viaForm)).map((r: any) => r.recordName)).toEqual(["Brief"]);
    expect(mailer.outbox!.some((m) => m.to === "form@client.test" && m.subject === "Thanks for Brief")).toBe(true);
    await call("PATCH", `/api/automations/${viaForm}`, { enabled: false });
  });

  it("calls webhooks with the record, and logs failures", async () => {
    const got: any[] = [];
    let status = 200;
    const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      got.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.statusCode = status;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const a = (await call("POST", `/api/bases/${baseId}/automations`, {
      name: "Hook", enabled: false, trigger: { type: "recordCreated", tableId: tasks },
      actions: [{ type: "webhook", url: `http://127.0.0.1:${port}/hook` }],
    })).body.automation.id;
    const t = await call("POST", `/api/automations/${a}/test`, {});
    expect(t.body.run).toMatchObject({ status: "success", test: true });
    expect(got[0]).toMatchObject({ automation: { name: "Hook" }, table: { name: "Table 1" } });
    expect(got[0].record.fields).toHaveProperty("Name");
    status = 500;
    const failed = (await call("POST", `/api/automations/${a}/test`, {})).body.run;
    expect(failed.status).toBe("failed");
    expect(failed.steps[0].message).toContain("500");
    server.close();
  });

  it("is managed by creators only, and refers to this base only", async () => {
    const other = (await call("POST", `/api/workspaces/${(await call("GET", "/api/workspaces")).body.workspaces[0].id}/bases`, { name: "Other" })).body.firstTableId;
    const bad = await call("POST", `/api/bases/${baseId}/automations`, { name: "x", trigger: { type: "recordCreated", tableId: other } });
    expect(bad.code).toBe(400);
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "ed@studio.test", name: "Ed", password: "test-pass-2026" } });
    const edSid = r.cookies.find((c) => c.name === "brill_sid")!.value;
    await db.query(`UPDATE users SET email_verified_at=now() WHERE email='ed@studio.test'`);
    const ws = (await call("GET", "/api/workspaces")).body.workspaces[0].id;
    const inv = (await call("POST", `/api/workspaces/${ws}/invites`, { email: "ed@studio.test", role: "editor" })).body.invite;
    await call("POST", `/api/invites/${inv.token}/accept`, {}, edSid);
    expect((await call("GET", `/api/bases/${baseId}/automations`, undefined, edSid)).code).toBe(403);
    const list = (await call("GET", `/api/bases/${baseId}/automations`)).body.automations;
    expect(list.find((x: any) => x.id === doneAuto).lastRun.status).toBe("success");
    expect((await call("DELETE", `/api/automations/${doneAuto}`)).code).toBe(200);
  });
});
