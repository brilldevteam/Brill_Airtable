import { mkdtempSync } from "node:fs";
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
type Client = { id: string; call: (m: string, u: string, p?: unknown) => Promise<Res> };
async function signUp(email: string, name: string, verified = true): Promise<Client> {
  const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name, password: "test-pass-2026" } });
  const sid = r.cookies.find((c) => c.name === "brill_sid")!.value;
  if (verified) await db.query(`UPDATE users SET email_verified_at=now() WHERE email=$1`, [email]);
  return {
    id: r.json().user.id,
    call: async (m, u, p) => {
      const res = await app.inject({ method: m as any, url: u, payload: p as any, cookies: { brill_sid: sid } });
      return { code: res.statusCode, body: res.json() };
    },
  };
}

let owner: Client;
let wsId: string;
let reelsBase: string;
let internalBase: string;
let tableId: string;
let F: Record<string, string>;
let recId: string;

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-bs-")), mailer, appUrl: "https://app.example" });
  await app.ready();
  owner = await signUp("owner@studio.test", "Olivia Owner");
  wsId = (await owner.call("GET", "/api/workspaces")).body.workspaces[0].id;
  const b = (await owner.call("POST", `/api/workspaces/${wsId}/bases`, { name: "Client reels" })).body;
  reelsBase = b.base.id;
  tableId = b.firstTableId;
  internalBase = (await owner.call("POST", `/api/workspaces/${wsId}/bases`, { name: "Internal finances" })).body.base.id;
  await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Caption", type: "longText" });
  await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Reel", type: "attachment", editAccess: "team" });
  await owner.call("POST", `/api/tables/${tableId}/fields`, { name: "Fee", type: "number", editAccess: "creators" });
  const fields = (await owner.call("GET", `/api/tables/${tableId}`)).body.fields;
  F = Object.fromEntries(fields.map((f: any) => [f.name, f.id]));
  // Lock the default Status field to the team too.
  await owner.call("PATCH", `/api/fields/${F.Status}`, { editAccess: "team" });
  recId = (await owner.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "Diwali reel", Status: "Todo" } })).body.record.id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

async function inviteToBase(email: string, role = "editor") {
  const r = await owner.call("POST", `/api/bases/${reelsBase}/invites`, { email, role });
  expect(r.code).toBe(200);
  return r.body.invite.token as string;
}

describe("sharing one base", () => {
  let client: Client;

  it("invites a client to one base by email; they see only that base", async () => {
    const token = await inviteToBase("client@brand.test");
    const mail = mailer.outbox![0];
    expect(mail.subject).toContain("shared “Client reels” with you");
    expect(mail.text).toContain(`https://app.example/invite/${token}`);
    const info = (await app.inject({ method: "GET", url: `/api/invites/${token}` })).json();
    expect(info.base).toBe("Client reels");

    client = await signUp("client@brand.test", "Chris Client");
    expect((await client.call("POST", `/api/invites/${token}/accept`, {})).body.baseId).toBe(reelsBase);

    const home = (await client.call("GET", "/api/workspaces")).body;
    expect(home.sharedBases.map((b: any) => b.id)).toEqual([reelsBase]);
    expect(home.bases.map((b: any) => b.id)).not.toContain(internalBase);
    const base = (await client.call("GET", `/api/bases/${reelsBase}`)).body;
    expect(base).toMatchObject({ role: "editor", guest: true });
    expect((await client.call("GET", `/api/bases/${internalBase}`)).code).toBe(404);
    expect((await client.call("GET", `/api/workspaces/${wsId}/members`)).code).toBe(404);
  });

  it("the client can write the caption but not locked fields", async () => {
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Caption: "Lights, colours, sweets ✨" } })).code).toBe(200);
    const reel = await client.call("PATCH", `/api/records/${recId}`, { cells: { Reel: [] } });
    expect(reel.code).toBe(403);
    expect(reel.body.error).toContain("“Reel”");
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Status: "Done" } })).code).toBe(403);
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Fee: 5 } })).code).toBe(403);
    // Creating a record with a locked value is refused too (here, and through the batch API).
    expect((await client.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "x", Status: "Done" } })).code).toBe(403);
    expect((await client.call("POST", `/api/tables/${tableId}/records/batch`, { records: [{ cells: { Fee: 1 } }] })).code).toBe(403);
  });

  it("a team editor can edit team fields, but only creators edit creator fields", async () => {
    const ed = await signUp("ed@studio.test", "Ed Editor");
    const inv = (await owner.call("POST", `/api/workspaces/${wsId}/invites`, { email: "ed@studio.test", role: "editor" })).body.invite;
    await ed.call("POST", `/api/invites/${inv.token}/accept`, {});
    expect((await ed.call("PATCH", `/api/records/${recId}`, { cells: { Status: "Done" } })).code).toBe(200);
    expect((await ed.call("PATCH", `/api/records/${recId}`, { cells: { Fee: 5 } })).code).toBe(403);
    expect((await owner.call("PATCH", `/api/records/${recId}`, { cells: { Fee: 25000 } })).code).toBe(200);
  });

  it("the table can stop clients adding or deleting records", async () => {
    expect((await client.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "client idea" } })).code).toBe(200);
    await owner.call("PATCH", `/api/tables/${tableId}`, { recordAccess: "team" });
    expect((await owner.call("GET", `/api/tables/${tableId}`)).body.table.recordAccess).toBe("team");
    expect((await client.call("POST", `/api/tables/${tableId}/records`, { cells: { Name: "another" } })).code).toBe(403);
    expect((await client.call("DELETE", `/api/records/${recId}`)).code).toBe(403);
    // Editing existing records still works.
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Caption: "v2" } })).code).toBe(200);
  });

  it("keeps a field's lock when its other settings change", async () => {
    await owner.call("PATCH", `/api/fields/${F.Status}`, { name: "Stage", options: { choices: [{ name: "Todo" }, { name: "Done" }, { name: "Posted" }] } });
    const f = (await owner.call("GET", `/api/tables/${tableId}`)).body.fields.find((x: any) => x.id === F.Status);
    expect(f.options.editAccess).toBe("team");
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Stage: "Posted" } })).code).toBe(403);
  });

  it("the sharing panel: managers see everything; clients see names without emails and can't invite", async () => {
    const s = (await owner.call("GET", `/api/bases/${reelsBase}/sharing`)).body;
    expect(s).toMatchObject({ canManageBase: true, canManageWorkspace: true, guest: false });
    expect(s.guests.map((g: any) => g.email)).toEqual(["client@brand.test"]);

    const c = (await client.call("GET", `/api/bases/${reelsBase}/sharing`)).body;
    expect(c).toMatchObject({ canManageBase: false, guest: true, invites: [] });
    expect(c.members.find((m: any) => m.name === "Olivia Owner").email).toBe("");
    expect(c.guests[0].email).toBe("client@brand.test");
    expect((await client.call("POST", `/api/bases/${reelsBase}/invites`, { email: "friend@brand.test" })).code).toBe(403);
  });

  it("refuses base invites for people who already have access", async () => {
    expect((await owner.call("POST", `/api/bases/${reelsBase}/invites`, { email: "ed@studio.test" })).code).toBe(409);
    expect((await owner.call("POST", `/api/bases/${reelsBase}/invites`, { email: "client@brand.test" })).code).toBe(409);
    expect((await owner.call("POST", `/api/bases/${reelsBase}/invites`, { email: "x@brand.test", role: "owner" })).code).toBe(400);
  });

  it("changes a client's role, and removes them", async () => {
    expect((await owner.call("PATCH", `/api/bases/${reelsBase}/members/${client.id}`, { role: "commenter" })).code).toBe(200);
    expect((await client.call("PATCH", `/api/records/${recId}`, { cells: { Caption: "v3" } })).code).toBe(403);
    expect((await client.call("POST", `/api/records/${recId}/comments`, { body: "Can we use the gold font?" })).code).toBe(200);
    expect((await owner.call("DELETE", `/api/bases/${reelsBase}/members/${client.id}`)).code).toBe(200);
    expect((await client.call("GET", `/api/bases/${reelsBase}`)).code).toBe(404);
    expect((await client.call("GET", "/api/workspaces")).body.sharedBases).toEqual([]);
  });
});
