import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { openDb, type Db } from "./db";
import { isBlockedAddress, safeFetch } from "./safeFetch";

let db: Db;
let app: ReturnType<typeof buildApp>;
let sid: string;
let tableId: string;
let local: Server;
let localUrl: string;

async function req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}, cookie = sid) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers, cookies: { brill_sid: cookie } });
  return { code: r.statusCode, json: () => r.json(), raw: r };
}
async function upload(name: string, type: string, data: Buffer) {
  const b = "----t" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await app.inject({
    method: "POST", url: `/api/tables/${tableId}/attachments`, payload,
    headers: { "content-type": `multipart/form-data; boundary=${b}`, "x-brill-upload": "1" }, cookies: { brill_sid: sid },
  });
  return r.json().attachments[0];
}

beforeAll(async () => {
  db = await openDb("memory://");
  app = buildApp(db, { filesDir: mkdtempSync(join(tmpdir(), "brill-att2-")) });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a2@example.com", name: "Ann Two", password: "test-pass-2026" } });
  sid = res.cookies.find((c) => c.name === "brill_sid")!.value;
  const ws = (await req("GET", "/api/workspaces")).json();
  tableId = (await req("POST", `/api/workspaces/${ws.workspaces[0].id}/bases`, { name: "Media" })).json().firstTableId;

  local = createServer((rq, rs) => {
    if (rq.url === "/clip.mp4") { rs.writeHead(200, { "Content-Type": "video/mp4" }); rs.end(Buffer.alloc(1000, 7)); return; }
    if (rq.url === "/hop") { rs.writeHead(302, { Location: "/clip.mp4" }); rs.end(); return; }
    rs.writeHead(404).end();
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
});
afterAll(async () => {
  local.close();
  await app.close();
  await db.close();
});

describe("video streaming", () => {
  it("serves byte ranges so videos can seek", async () => {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const a = await upload("Cup.mp4", "application/octet-stream", data);
    expect(a.mime).toBe("video/mp4"); // fixed up from the extension

    const full = await req("GET", a.url);
    expect(full.raw.headers["accept-ranges"]).toBe("bytes");
    expect(full.raw.rawPayload.length).toBe(5000);
    // No sandbox for media: it would give the player page a null origin and block playback.
    expect(full.raw.headers["content-security-policy"]).not.toMatch(/sandbox/);
    expect(full.raw.headers["content-security-policy"]).toContain("media-src 'self'");

    const part = await req("GET", a.url, undefined, { range: "bytes=100-199" });
    expect(part.code).toBe(206);
    expect(part.raw.headers["content-range"]).toBe("bytes 100-199/5000");
    expect([...part.raw.rawPayload]).toEqual([...data.subarray(100, 200)]);

    const tail = await req("GET", a.url, undefined, { range: "bytes=-10" });
    expect(tail.raw.headers["content-range"]).toBe("bytes 4990-4999/5000");
    expect((await req("GET", a.url, undefined, { range: "bytes=9000-" })).code).toBe(416);

    const dl = await req("GET", a.url + "?download=1");
    expect(dl.raw.headers["content-disposition"]).toMatch(/^attachment/);
  });
});

describe("rename and comments", () => {
  it("renames a file", async () => {
    const a = await upload("old.txt", "text/plain", Buffer.from("x"));
    const r = (await req("PATCH", `/api/attachments/${a.id}`, { filename: "new name.txt" })).json();
    expect(r.attachment.filename).toBe("new name.txt");
    expect(r.attachment.url).toContain("new%20name.txt");
  });

  it("adds, lists and deletes comments; only the author can delete", async () => {
    const a = await upload("pic.txt", "text/plain", Buffer.from("x"));
    const c = (await req("POST", `/api/attachments/${a.id}/comments`, { body: "Brighten the cup a bit" })).json().comment;
    expect(c.userName).toBe("Ann Two");
    expect((await req("GET", `/api/attachments/${a.id}/comments`)).json().comments.map((x: any) => x.body)).toEqual(["Brighten the cup a bit"]);

    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "out@example.com", name: "Out", password: "test-pass-2026" } });
    const outsider = r.cookies.find((x) => x.name === "brill_sid")!.value;
    expect((await req("GET", `/api/attachments/${a.id}/comments`, undefined, {}, outsider)).code).toBe(404);
    expect((await req("DELETE", `/api/attachment-comments/${c.id}`, undefined, {}, outsider)).code).toBe(404);

    expect((await req("DELETE", `/api/attachment-comments/${c.id}`)).code).toBe(200);
    expect((await req("GET", `/api/attachments/${a.id}/comments`)).json().comments).toEqual([]);
  });
});

describe("add from link", () => {
  it("refuses private and local addresses (SSRF protection)", async () => {
    for (const url of ["http://127.0.0.1:4000/api/health", "http://localhost/", "http://10.0.0.5/x.png", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", localUrl + "/clip.mp4"]) {
      const r = await req("POST", `/api/tables/${tableId}/attachments/from-url`, { url });
      expect(r.code, url).toBeGreaterThanOrEqual(400);
      expect(r.code, url).toBeLessThan(500);
    }
  });

  it("knows reserved ranges", () => {
    expect(isBlockedAddress("192.168.1.10")).toBe(true);
    expect(isBlockedAddress("172.20.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("fd00::1")).toBe(true);
  });

  it("downloads and follows redirects (test server via the test-only switch)", async () => {
    const f = await safeFetch(localUrl + "/hop", { allowLoopbackForTests: true });
    expect(f.mime).toBe("video/mp4");
    expect(f.filename).toBe("clip.mp4");
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(1000);
  });
});
