import { hash, verify } from "@node-rs/argon2";
import { newId, type User } from "@brill/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db";
import { HttpError } from "./errors";

const SESSION_COOKIE = "brill_sid";
const SESSION_DAYS = 30;

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

const registerBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});
const loginBody = z.object({ email: z.string().transform((s) => s.toLowerCase().trim()), password: z.string() });

export function registerAuth(app: FastifyInstance, db: Db, opts: { secureCookies: boolean }) {
  async function startSession(reply: FastifyReply, userId: string) {
    const sid = newId("ses") + newId("ses"); // ~28 random chars
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,$3)`, [sid, userId, expires]);
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secureCookies,
      path: "/",
      expires,
    });
  }

  // Attach the logged-in user (if any) to every request.
  app.addHook("onRequest", async (req) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    const row = await db.one<User>(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [sid],
    );
    if (row) req.user = row;
  });

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const exists = await db.one(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (exists) throw new HttpError(409, "An account with this email already exists");
    const user: User = { id: newId("usr"), email: body.email, name: body.name };
    const passwordHash = await hash(body.password);
    await db.tx(async (t) => {
      await t.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [
        user.id, user.email, user.name, passwordHash,
      ]);
      // Every new user gets their own workspace. Inviting people into a shared
      // workspace comes with the permissions work in Phase 5.
      const wsId = newId("wsp");
      await t.query(`INSERT INTO workspaces (id, name) VALUES ($1,$2)`, [wsId, `${user.name}'s workspace`]);
      await t.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [wsId, user.id]);
    });
    await startSession(reply, user.id);
    return { user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginBody.parse(req.body);
    const row = await db.one<User & { password_hash: string }>(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [body.email],
    );
    if (!row || !(await verify(row.password_hash, body.password))) {
      throw new HttpError(401, "Wrong email or password");
    }
    await startSession(reply, row.id);
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await db.query(`DELETE FROM sessions WHERE id = $1`, [sid]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ user: req.user ?? null }));
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "Please sign in");
  return req.user;
}
