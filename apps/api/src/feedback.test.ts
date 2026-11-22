import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { logMailer } from "./mail";

// Admin feedback round: default options, attachment/person conversions, notifications and
// mentions, client logos, moving bases.
let db: Db;
let app: ReturnType<typeof buildApp>;
const mailer = logMailer({ quiet: true });
type Res = { code: number; body: any };
const call = async (sid: string, m: string, u: string, p?: unknown): Promise<Res> => {
  const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
  return { code: res.statusCode, body: res.body ? res.json() : {} };
};
const signUp = async (email: string, name: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name, password: "test-pass-2026" } });
  return { sid: r.cookies.find((c) => c.name === "brill_sid")!.value, id: r.json().user.id as string };
};
let owner: { sid: string; id: string };
let mate: { sid: string; id: string };
let ws: string;
let baseId: string;
let tableId: string;
let viewId: string;

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-fb-")), mailer });
  await app.ready();
  owner = await signUp("owner@studio.test", "Olive Owner");
  mate = await signUp("mate@studio.test", "Max Mate");
  ws = (await call(owner.sid, "GET", "/api/workspaces")).body.workspaces[0].id;
  // Max joins Olive's workspace as an editor.
  await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'editor')`, [ws, mate.id]);
  const b = (await call(owner.sid, "POST", `/api/workspaces/${ws}/bases`, { name: "Clients" })).body;
  baseId = b.base.id;
  tableId = b.firstTableId;
  viewId = (await call(owner.sid, "GET", `/api/tables/${tableId}`)).body.views[0].id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("select options", () => {
  it("new records start with the default option; editing keeps choice ids", async () => {
    const f = (await call(owner.sid, "POST", `/api/tables/${tableId}/fields`, {
      name: "Stage", type: "singleSelect", options: { choices: [{ name: "Draft", color: "gray" }, { name: "Approved", color: "green" }], defaultChoice: "Draft" },
    })).body.field;
    const draft = f.options.choices.find((c: any) => c.name === "Draft");
    expect(f.options.defaultChoiceId).toBe(draft.id);
    expect(f.options.choices.map((c: any) => c.color)).toEqual(["gray", "green"]);
    const rec = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: {} })).body.record;
    expect(rec.cells[f.id]).toBe(draft.id);
    const given = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: { Stage: "Approved" } })).body.record;
    expect(given.cells[f.id]).not.toBe(draft.id);
    // Reorder + recolour + new option, no default any more.
    const edited = (await call(owner.sid, "PATCH", `/api/fields/${f.id}`, {
      options: { choices: [{ id: f.options.choices[1].id, name: "Approved", color: "teal" }, { id: draft.id, name: "Draft", color: "gray" }, { name: "Posted" }], defaultChoice: null },
    })).body.field;
    expect(edited.options.choices.map((c: any) => c.name)).toEqual(["Approved", "Draft", "Posted"]);
    expect(edited.options.choices[1].id).toBe(draft.id);
    expect(edited.options.defaultChoiceId).toBeUndefined();
    expect((await call(owner.sid, "GET", `/api/views/${viewId}/records`)).body.records.find((r: any) => r.id === rec.id).cells[f.id]).toBe(draft.id);
  });
});

describe("changing a field to or from attachments and people", () => {
  it("text → attachment clears values; person → text keeps names", async () => {
    const t = (await call(owner.sid, "POST", `/api/tables/${tableId}/fields`, { name: "Proof", type: "singleLineText" })).body.field;
    const r = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: { Proof: "see drive" } })).body.record;
    const asFiles = await call(owner.sid, "PATCH", `/api/fields/${t.id}`, { type: "attachment" });
    expect(asFiles.code).toBe(200);
    expect(asFiles.body.field.type).toBe("attachment");
    const after = (await call(owner.sid, "GET", `/api/views/${viewId}/records`)).body.records.find((x: any) => x.id === r.id);
    expect(after.cells[t.id]).toBeUndefined();

    const who = (await call(owner.sid, "POST", `/api/tables/${tableId}/fields`, { name: "Owner", type: "user", options: { multiple: true } })).body.field;
    const r2 = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: { Owner: [owner.id, mate.id] } })).body.record;
    expect((await call(owner.sid, "PATCH", `/api/fields/${who.id}`, { type: "singleLineText" })).code).toBe(200);
    const r2after = (await call(owner.sid, "GET", `/api/views/${viewId}/records`)).body.records.find((x: any) => x.id === r2.id);
    expect(r2after.cells[who.id]).toBe("Olive Owner, Max Mate");
  });
});

describe("notifications", () => {
  it("person fields that notify tell newly added people, in the bell and by email", async () => {
    const f = (await call(owner.sid, "POST", `/api/tables/${tableId}/fields`, { name: "Assignee", type: "user", options: { notify: true } })).body.field;
    expect(f.options.notify).toBe(true);
    const rec = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: { Name: "Launch reel", Assignee: [mate.id] } })).body.record;
    // Adding yourself doesn't notify you.
    await call(owner.sid, "PATCH", `/api/records/${rec.id}`, { cells: { [f.id]: [mate.id, owner.id] } });
    const mine = (await call(owner.sid, "GET", "/api/notifications")).body;
    expect(mine.unread).toBe(0);
    const theirs = (await call(mate.sid, "GET", "/api/notifications")).body;
    expect(theirs.unread).toBe(1);
    expect(theirs.notifications[0]).toMatchObject({ kind: "assigned", title: "Olive Owner added you to “Launch reel”", read: false });
    expect(theirs.notifications[0].link).toBe(`/base/${baseId}/${tableId}?record=${rec.id}`);

    // The dev outbox lists the newest email first.
    const notes = () => mailer.outbox!.filter((m) => /added you|mentioned you/.test(m.subject));
    await app.sendPendingNotifications();
    expect(notes().map((m) => m.to)).toEqual(["mate@studio.test"]);
    expect(notes()[0].subject).toBe("Olive Owner added you to “Launch reel”");
    await app.sendPendingNotifications(); // nothing twice
    expect(notes()).toHaveLength(1);

    expect((await call(mate.sid, "POST", "/api/notifications/read", {})).code).toBe(200);
    expect((await call(mate.sid, "GET", "/api/notifications")).body.unread).toBe(0);
  });

  it("@mentions in comments notify the people mentioned (only if they can open the base)", async () => {
    const outsider = await signUp("out@else.test", "Otto Outsider");
    const rec = (await call(owner.sid, "POST", `/api/tables/${tableId}/records`, { cells: { Name: "Caption" } })).body.record;
    const body = `Can you check this @[Max Mate](${mate.id})? cc @[Otto Outsider](${outsider.id})`;
    expect((await call(owner.sid, "POST", `/api/records/${rec.id}/comments`, { body })).code).toBe(200);
    const theirs = (await call(mate.sid, "GET", "/api/notifications")).body;
    expect(theirs.notifications[0]).toMatchObject({ kind: "mention", title: "Olive Owner mentioned you on “Caption”" });
    expect(theirs.notifications[0].body).toBe("Can you check this @Max Mate? cc @Otto Outsider");
    expect((await call(outsider.sid, "GET", "/api/notifications")).body.notifications).toHaveLength(0);
  });
});

describe("base logos and moving bases", () => {
  it("uploads a logo (re-encoded as WebP), serves it to members only, and removes it", async () => {
    const png = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#e11d48" } }).png().toBuffer();
    const boundary = "----brill";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
      png, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: "POST", url: `/api/bases/${baseId}/logo`, payload, cookies: { brill_sid: owner.sid },
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-brill-upload": "1" },
    });
    expect(up.statusCode).toBe(200);
    const name = up.json().logo;
    const listed = (await call(owner.sid, "GET", "/api/workspaces")).body.bases.find((b: any) => b.id === baseId);
    expect(listed.logo).toBe(name);
    const img = await app.inject({ method: "GET", url: `/api/bases/${baseId}/logo/${name}`, cookies: { brill_sid: mate.sid } });
    expect(img.headers["content-type"]).toBe("image/webp");
    expect((await sharp(img.rawPayload).metadata()).width).toBe(256);
    const stranger = await signUp("s@else.test", "Stranger");
    expect((await app.inject({ method: "GET", url: `/api/bases/${baseId}/logo/${name}`, cookies: { brill_sid: stranger.sid } })).statusCode).toBe(404);
    expect((await call(owner.sid, "DELETE", `/api/bases/${baseId}/logo`)).code).toBe(200);
    expect((await call(owner.sid, "GET", "/api/workspaces")).body.bases.find((b: any) => b.id === baseId).logo).toBeNull();
  });

  it("the owner can move a base to another workspace they can create in", async () => {
    const otherId = "wspAgency0000001";
    await db.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'Agency')`, [otherId]);
    await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [otherId, owner.id]);
    expect((await call(mate.sid, "POST", `/api/bases/${baseId}/move`, { workspaceId: otherId })).code).toBe(403);
    expect((await call(owner.sid, "POST", `/api/bases/${baseId}/move`, { workspaceId: otherId })).code).toBe(200);
  });
});
