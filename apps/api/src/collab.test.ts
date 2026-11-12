import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { bus, type ChangeEvent } from "./realtime";

let db: Db;
let app: ReturnType<typeof buildApp>;

type Client = { sid: string; call: (m: string, u: string, p?: unknown, h?: Record<string, string>) => Promise<{ code: number; body: any }> };
async function signUp(email: string, name: string): Promise<Client> {
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name, password: "password123" } });
  const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  return {
    sid,
    call: async (m, u, p, h = {}) => {
      const res = await app.inject({ method: m as any, url: u, payload: p as any, headers: h, cookies: { brill_sid: sid } });
      return { code: res.statusCode, body: res.json() };
    },
  };
}

let owner: Client;
let wsId: string;
let baseId: string;
let tableId: string;
let viewId: string;

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-collab-")) });
  await app.ready();
  owner = await signUp("owner@brill.test", "Olivia Owner");
  wsId = (await owner.call("GET", "/api/workspaces")).body.workspaces[0].id;
  const b = (await owner.call("POST", `/api/workspaces/${wsId}/bases`, { name: "Content" })).body;
  baseId = b.base.id;
  tableId = b.firstTableId;
  viewId = (await owner.call("GET", `/api/tables/${tableId}`)).body.views[0].id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("sharing", () => {
  it("adds an existing user straight away with the chosen role", async () => {
    const ed = await signUp("ed@brill.test", "Ed Editor");
    const r = await owner.call("POST", `/api/workspaces/${wsId}/invites`, { email: "ED@brill.test", role: "editor" });
    expect(r.body.added.name).toBe("Ed Editor");
    const ws = (await ed.call("GET", "/api/workspaces")).body;
    expect(ws.bases.map((b: any) => b.id)).toContain(baseId);
    expect((await ed.call("GET", `/api/bases/${baseId}`)).body.role).toBe("editor");
    expect((await ed.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "by Ed" } })).code).toBe(200);
    // Editors can't change the schema.
    expect((await ed.call("POST", `/api/tables/${tableId}/fields`, { name: "X", type: "number" })).code).toBe(403);
  });

  it("invites new people by link that only works for their email", async () => {
    const r = await owner.call("POST", `/api/workspaces/${wsId}/invites`, { email: "new@brill.test", role: "commenter" });
    const token = r.body.invite.token;
    expect(r.body.invite.path).toBe(`/invite/${token}`);
    const info = (await app.inject({ method: "GET", url: `/api/invites/${token}` })).json();
    expect(info).toMatchObject({ email: "new@brill.test", role: "commenter", workspace: expect.any(String), invitedBy: "Olivia Owner" });

    const wrong = await signUp("someone@brill.test", "Someone Else");
    expect((await wrong.call("POST", `/api/invites/${token}/accept`, {})).code).toBe(403);

    const newbie = await signUp("new@brill.test", "Nina New");
    expect((await newbie.call("POST", `/api/invites/${token}/accept`, {})).body.workspaceId).toBe(wsId);
    expect((await newbie.call("POST", `/api/invites/${token}/accept`, {})).code).toBe(410);

    // Commenters can comment but not edit.
    const rec = (await owner.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "Post 1" } })).body.record;
    expect((await newbie.call("PATCH", `/api/records/${rec.id}`, { cells: { Name: "x" } })).code).toBe(403);
    expect((await newbie.call("POST", `/api/records/${rec.id}/comments`, { body: "Nice!" })).code).toBe(200);
  });

  it("lists members and invites; only owners manage them; keeps one owner", async () => {
    const list = (await owner.call("GET", `/api/workspaces/${wsId}/members`)).body;
    expect(list.members[0]).toMatchObject({ name: "Olivia Owner", role: "owner" });
    expect(list.myRole).toBe("owner");
    const ed = list.members.find((m: any) => m.name === "Ed Editor");
    const edClient = await (async () => {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ed@brill.test", password: "password123" } });
      const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
      return (m: string, u: string, p?: unknown) => app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
    })();
    expect((await edClient("PATCH", `/api/workspaces/${wsId}/members/${ed.userId}`, { role: "owner" })).statusCode).toBe(403);
    expect((await owner.call("PATCH", `/api/workspaces/${wsId}/members/${list.members[0].userId}`, { role: "editor" })).code).toBe(400);
    expect((await owner.call("PATCH", `/api/workspaces/${wsId}/members/${ed.userId}`, { role: "read" })).code).toBe(200);
    expect((await owner.call("DELETE", `/api/workspaces/${wsId}/members/${ed.userId}`)).code).toBe(200);
    expect((await edClient("GET", `/api/bases/${baseId}`)).statusCode).toBe(404);
  });
});

describe("record comments and history", () => {
  it("keeps who changed what, and comments", async () => {
    const rec = (await owner.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "Reel draft", Status: "Todo" } })).body.record;
    await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Status: "Done", Name: "Reel final" } });
    const h = (await owner.call("GET", `/api/records/${rec.id}/history`)).body;
    expect(h.entries.map((e: any) => e.kind)).toEqual(["update", "create"]);
    const fields = (await owner.call("GET", `/api/tables/${tableId}`)).body.fields;
    const nameId = fields.find((f: any) => f.name === "Name").id;
    expect(h.entries[0].changes[nameId]).toEqual({ from: "Reel draft", to: "Reel final" });
    expect(h.entries[0].userName).toBe("Olivia Owner");

    const c = (await owner.call("POST", `/api/records/${rec.id}/comments`, { body: "Ready to post" })).body.comment;
    expect((await owner.call("GET", `/api/records/${rec.id}/comments`)).body.comments.map((x: any) => x.body)).toEqual(["Ready to post"]);
    expect((await owner.call("DELETE", `/api/record-comments/${c.id}`)).code).toBe(200);

    await owner.call("DELETE", `/api/records/${rec.id}`);
    expect((await db.query(`SELECT kind FROM record_history WHERE record_id=$1 ORDER BY id DESC LIMIT 1`, [rec.id]))[0].kind).toBe("delete");
  });
});

describe("live updates", () => {
  it("announces changes to the base with the tab that made them", async () => {
    const events: ChangeEvent[] = [];
    const listen = (e: ChangeEvent) => events.push(e);
    bus.on(`base:${baseId}`, listen);
    const rec = (await owner.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "live" } }, { "x-client-id": "tab-A" })).body.record;
    await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Name: "live 2" } });
    await owner.call("POST", `/api/records/${rec.id}/comments`, { body: "hi" });
    await owner.call("PATCH", `/api/views/${viewId}`, { config: { rowHeight: "tall" } });
    await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Live field", type: "number" });
    await owner.call("PATCH", `/api/records/${rec.id}`, { cells: { Nope: 1 } }); // fails: no event
    bus.off(`base:${baseId}`, listen);

    expect(events.map((e) => e.scope)).toEqual(["records", "records", "comments", "views", "schema"]);
    expect(events[0]).toMatchObject({ tableId, clientId: "tab-A" });
    expect(events[1].recordId).toBe(rec.id);
  });

  it("the event stream needs access to the base", async () => {
    const stranger = await signUp("stranger@brill.test", "Stranger");
    expect((await stranger.call("GET", `/api/bases/${baseId}/events`)).code).toBe(404);
  });
});
