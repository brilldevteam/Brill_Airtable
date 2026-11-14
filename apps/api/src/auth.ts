import { hash, verify } from "@node-rs/argon2";
import { newId, type User } from "@brill/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { limiter } from "./rateLimit";

const SESSION_COOKIE = "brill_sid";
/** A session ends after 30 days without use, and after 90 days in any case. */
const IDLE_DAYS = 30;
const ABSOLUTE_DAYS = 90;
/** Sessions are extended at most once an hour, to keep reads cheap. */
const TOUCH_MS = 3600_000;

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    sessionHash?: string;
  }
}

/** The database stores only a hash of the session id, so a leaked database can't be used to sign in. */
const hashSid = (sid: string) => createHash("sha256").update(sid).digest("base64url");

const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((p) => !/^(.)\1+$/.test(p), "Choose a less predictable password")
  .refine((p) => !COMMON.has(p.toLowerCase()), "That password is too common — choose another");
const COMMON = new Set([
  "password", "password1", "password12", "password123", "1234567890", "12345678910", "qwertyuiop", "iloveyou12",
  "welcome123", "admin12345", "letmein123", "passw0rd12", "abc1234567", "qwerty1234", "1q2w3e4r5t",
]);

const registerBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
const loginBody = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) });

export function registerAuth(app: FastifyInstance, db: Db, opts: { secureCookies: boolean }) {
  // Brute-force protection: per address and per account.
  const loginByIp = limiter(30, 15 * 60_000);
  const loginByEmail = limiter(10, 15 * 60_000, "Too many sign-in attempts for this account — wait 15 minutes and try again");
  const registerByIp = limiter(20, 60 * 60_000);

  async function startSession(reply: FastifyReply, userId: string) {
    const sid = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expires = new Date(now + IDLE_DAYS * 86400_000);
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at, absolute_expires_at, last_seen_at) VALUES ($1,$2,$3,$4,now())`,
      [hashSid(sid), userId, expires, new Date(now + ABSOLUTE_DAYS * 86400_000)],
    );
    setCookie(reply, sid, expires);
  }
  function setCookie(reply: FastifyReply, sid: string, expires: Date) {
    reply.setCookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: "lax", secure: opts.secureCookies, path: "/", expires });
  }

  // Attach the logged-in user (if any) to every request; slide the idle expiry now and then.
  app.addHook("onRequest", async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    const h = hashSid(sid);
    const row = await db.one<User & { last_seen_at: string; absolute_expires_at: string }>(
      `SELECT u.id, u.email, u.name, s.last_seen_at, s.absolute_expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now() AND s.absolute_expires_at > now()`,
      [h],
    );
    if (!row) return;
    req.user = { id: row.id, email: row.email, name: row.name };
    req.sessionHash = h;
    if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
      const abs = new Date(row.absolute_expires_at).getTime();
      const expires = new Date(Math.min(Date.now() + IDLE_DAYS * 86400_000, abs));
      await db.query(`UPDATE sessions SET expires_at=$2, last_seen_at=now() WHERE id=$1`, [h, expires]);
      setCookie(reply, sid, expires);
    }
  });

  app.post("/api/auth/register", async (req, reply) => {
    registerByIp(req.ip);
    const body = registerBody.parse(req.body);
    const exists = await db.one(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (exists) throw new HttpError(409, "An account with this email already exists — sign in instead");
    const user: User = { id: newId("usr"), email: body.email, name: body.name };
    const passwordHash = await hash(body.password);
    await db.tx(async (t) => {
      await t.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [
        user.id, user.email, user.name, passwordHash,
      ]);
      // Every new user gets their own workspace; they can be invited into others.
      const wsId = newId("wsp");
      await t.query(`INSERT INTO workspaces (id, name) VALUES ($1,$2)`, [wsId, `${user.name}'s workspace`]);
      await t.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [wsId, user.id]);
    });
    await startSession(reply, user.id);
    return { user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginBody.parse(req.body);
    loginByIp(req.ip);
    loginByEmail(body.email);
    const row = await db.one<User & { password_hash: string }>(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [body.email],
    );
    if (!row || !(await verify(row.password_hash, body.password))) {
      throw new HttpError(401, "Wrong email or password");
    }
    loginByEmail.reset(body.email);
    await startSession(reply, row.id);
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionHash) await db.query(`DELETE FROM sessions WHERE id = $1`, [req.sessionHash]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ user: req.user ?? null }));

  // ---------------- account settings ----------------
  app.patch("/api/auth/me", async (req) => {
    const user = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    await db.query(`UPDATE users SET name=$2 WHERE id=$1`, [user.id, body.name]);
    return { user: { ...user, name: body.name } };
  });

  /** Change password. Signs out every other device. */
  app.post("/api/auth/password", async (req) => {
    const user = requireUser(req);
    loginByEmail(user.email);
    const body = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }).parse(req.body);
    const row = await db.one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
    if (!row || !(await verify(row.password_hash, body.currentPassword))) throw new HttpError(400, "Your current password is wrong");
    await db.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [user.id, await hash(body.newPassword)]);
    loginByEmail.reset(user.email);
    await db.query(`DELETE FROM sessions WHERE user_id=$1 AND id<>$2`, [user.id, req.sessionHash]);
    return { ok: true };
  });

  app.get("/api/auth/sessions", async (req) => {
    const user = requireUser(req);
    const r = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND expires_at > now() AND absolute_expires_at > now()`,
      [user.id],
    );
    return { active: r?.n ?? 0 };
  });

  /** Sign out of every other device. */
  app.post("/api/auth/sessions/revoke-others", async (req) => {
    const user = requireUser(req);
    await db.query(`DELETE FROM sessions WHERE user_id=$1 AND id<>$2`, [user.id, req.sessionHash]);
    return { ok: true };
  });

  // Clear out expired sessions at start-up and every few hours.
  const purge = () => db.query(`DELETE FROM sessions WHERE expires_at < now() OR absolute_expires_at < now()`).catch(() => {});
  app.addHook("onReady", async () => { void purge(); });
  const timer = setInterval(purge, 6 * 3600_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "Please sign in");
  return req.user;
}
