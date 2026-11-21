import { hash, verify } from "@node-rs/argon2";
import { newId, type User } from "@brill/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { emails, type Mailer } from "./mail";
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

const VERIFY_HOURS = 24;
const RESET_MINUTES = 60;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("base64url");

export function registerAuth(app: FastifyInstance, db: Db, opts: { secureCookies: boolean; mailer: Mailer; appUrl: string; signups?: "open" | "invite" }) {
  // Brute-force protection: per address and per account.
  const loginByIp = limiter(30, 15 * 60_000);
  const loginByEmail = limiter(10, 15 * 60_000, "Too many sign-in attempts for this account — wait 15 minutes and try again");
  const registerByIp = limiter(20, 60 * 60_000);
  const mailByIp = limiter(10, 60 * 60_000, "Too many emails requested — please wait a while and try again");
  const mailByEmail = limiter(3, 15 * 60_000, "We've just sent an email to this address — check your inbox (and spam), or wait 15 minutes");

  /** Create a single-use token (only its hash is stored), replacing older unused ones of the same kind. */
  async function issueToken(userId: string, kind: "verify" | "reset", ms: number) {
    const token = randomBytes(32).toString("base64url");
    await db.query(`DELETE FROM email_tokens WHERE user_id=$1 AND kind=$2 AND used_at IS NULL`, [userId, kind]);
    await db.query(`INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ($1,$2,$3,$4)`, [
      hashToken(token), userId, kind, new Date(Date.now() + ms),
    ]);
    return token;
  }
  /** Use up a token: returns the user id, or throws if it's unknown, used or expired. */
  async function consumeToken(t: Db, token: string, kind: "verify" | "reset") {
    const row = await t.one<{ user_id: string; expires_at: string; used_at: string | null }>(
      `SELECT user_id, expires_at, used_at FROM email_tokens WHERE token_hash=$1 AND kind=$2 FOR UPDATE`,
      [hashToken(token), kind],
    );
    const what = kind === "verify" ? "confirmation" : "reset";
    if (!row) throw new HttpError(400, `This ${what} link isn't valid. Ask for a new one.`);
    if (row.used_at) throw new HttpError(410, `This ${what} link has already been used.`);
    if (new Date(row.expires_at) < new Date()) throw new HttpError(410, `This ${what} link has expired. Ask for a new one.`);
    await t.query(`UPDATE email_tokens SET used_at=now() WHERE token_hash=$1`, [hashToken(token)]);
    return row.user_id;
  }
  async function sendVerification(user: User) {
    const token = await issueToken(user.id, "verify", VERIFY_HOURS * 3600_000);
    await opts.mailer.send(emails.verify(user.email, user.name, `${opts.appUrl}/verify-email/${token}`));
  }
  /** Email failures shouldn't break sign-up; they're logged and the user can ask again. */
  const trySend = (req: FastifyRequest, p: Promise<void>) => p.catch((e) => req.log.error(e, "email failed"));

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
    const row = await db.one<User & { last_seen_at: string; absolute_expires_at: string; verified: boolean }>(
      `SELECT u.id, u.email, u.name, u.email_verified_at IS NOT NULL AS verified, s.last_seen_at, s.absolute_expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now() AND s.absolute_expires_at > now()`,
      [h],
    );
    if (!row) return;
    req.user = { id: row.id, email: row.email, name: row.name, emailVerified: row.verified };
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
    if (opts.signups === "invite") {
      // Invite-only: the very first account (the owner) may sign up; after that only invited emails.
      const anyone = await db.one(`SELECT 1 FROM users LIMIT 1`);
      const invited = await db.one(
        `SELECT 1 FROM workspace_invites WHERE email=$1 AND accepted_at IS NULL AND expires_at > now()`, [body.email],
      );
      if (anyone && !invited) throw new HttpError(403, "Sign-up is by invitation only. Ask a workspace owner to invite you.");
    }
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
    await trySend(req, sendVerification(user));
    return { user: { ...user, emailVerified: false } };
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
  /** Lets the sign-in page hide "Create an account" when sign-ups are invite-only. */
  app.get("/api/auth/config", async () => {
    // Invite-only still lets the very first account (the owner) sign up.
    const first = !(await db.one(`SELECT 1 FROM users LIMIT 1`));
    return { signups: opts.signups ?? "open", firstAccount: first };
  });

  // ---------------- email verification ----------------
  app.post("/api/auth/verify-email", async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const email = await db.tx(async (t) => {
      const userId = await consumeToken(t, token, "verify");
      const u = await t.one<{ email: string }>(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING email`, [userId],
      );
      return u!.email;
    });
    return { ok: true, email };
  });

  app.post("/api/auth/resend-verification", async (req) => {
    const user = requireUser(req);
    if (user.emailVerified) return { ok: true, alreadyVerified: true };
    mailByIp(req.ip);
    mailByEmail(user.email);
    try {
      await sendVerification(user);
    } catch (e) {
      // Tell the person something useful; the full reason (e.g. Resend's answer) goes to the server log.
      req.log.error(e, "verification email failed");
      throw new HttpError(502, "We couldn't send the email. The email settings on the server need checking — try again later.");
    }
    return { ok: true };
  });

  // ---------------- forgotten password ----------------
  /** Always answers the same way, so it can't be used to find out who has an account. */
  app.post("/api/auth/forgot-password", async (req) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).parse(req.body);
    mailByIp(req.ip);
    mailByEmail(email);
    const user = await db.one<User>(`SELECT id, email, name FROM users WHERE email=$1`, [email]);
    if (user) {
      const token = await issueToken(user.id, "reset", RESET_MINUTES * 60_000);
      await trySend(req, opts.mailer.send(emails.reset(user.email, user.name, `${opts.appUrl}/reset-password/${token}`)));
    }
    return { ok: true };
  });

  /** Set a new password from an emailed link. Signs out every device, then signs in here. */
  app.post("/api/auth/reset-password", async (req, reply) => {
    const body = z.object({ token: z.string().min(10).max(200), password: passwordSchema }).parse(req.body);
    loginByIp(req.ip);
    const passwordHash = await hash(body.password);
    const user = await db.tx(async (t) => {
      const userId = await consumeToken(t, body.token, "reset");
      // Following the emailed link proves they own the address.
      const u = await t.one<User>(
        `UPDATE users SET password_hash=$2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING id, email, name`,
        [userId, passwordHash],
      );
      await t.query(`DELETE FROM sessions WHERE user_id=$1`, [userId]);
      return u!;
    });
    loginByEmail.reset(user.email);
    await startSession(reply, user.id);
    return { user: { ...user, emailVerified: true } };
  });

  // ---------------- account settings ----------------
  app.patch("/api/auth/me", async (req) => {
    const user = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    await db.query(`UPDATE users SET name=$2 WHERE id=$1`, [user.id, body.name]);
    return { user: { ...user, name: body.name } };
  });

  /**
   * Change the account's email. Needs the current password. Nothing changes until the link sent to
   * the NEW address is opened; the old address gets a notice.
   */
  app.post("/api/auth/email", async (req) => {
    const user = requireUser(req);
    const body = z.object({
      newEmail: z.string().trim().toLowerCase().email().max(254),
      currentPassword: z.string().max(200),
    }).parse(req.body);
    loginByEmail(user.email);
    mailByIp(req.ip);
    if (body.newEmail === user.email.toLowerCase()) throw new HttpError(400, "That's already your email");
    const row = await db.one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
    if (!row || !(await verify(row.password_hash, body.currentPassword))) throw new HttpError(400, "Your current password is wrong");
    loginByEmail.reset(user.email);
    if (await db.one(`SELECT 1 FROM users WHERE email=$1`, [body.newEmail])) {
      throw new HttpError(409, "Another account already uses that email");
    }
    mailByEmail(body.newEmail);
    const token = randomBytes(32).toString("base64url");
    await db.query(`DELETE FROM email_tokens WHERE user_id=$1 AND kind='email' AND used_at IS NULL`, [user.id]);
    await db.query(
      `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, new_email) VALUES ($1,$2,'email',$3,$4)`,
      [hashToken(token), user.id, new Date(Date.now() + VERIFY_HOURS * 3600_000), body.newEmail],
    );
    try {
      await opts.mailer.send(emails.changeEmail(body.newEmail, user.name, `${opts.appUrl}/confirm-email/${token}`));
    } catch (e) {
      req.log.error(e, "email-change email failed");
      throw new HttpError(502, "We couldn't send the email. The email settings on the server need checking — try again later.");
    }
    await trySend(req, opts.mailer.send(emails.emailChangeNotice(user.email, user.name, body.newEmail, opts.appUrl)).then(() => undefined));
    return { ok: true, pending: body.newEmail };
  });

  /** Open the link from the new address: the account switches to it (and it counts as confirmed). */
  app.post("/api/auth/confirm-email", async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const email = await db.tx(async (t) => {
      const row = await t.one<{ user_id: string; expires_at: string; used_at: string | null; new_email: string }>(
        `SELECT user_id, expires_at, used_at, new_email FROM email_tokens WHERE token_hash=$1 AND kind='email' FOR UPDATE`,
        [hashToken(token)],
      );
      if (!row) throw new HttpError(400, "This link isn't valid. Ask for a new one in Account settings.");
      if (row.used_at) throw new HttpError(410, "This link has already been used.");
      if (new Date(row.expires_at) < new Date()) throw new HttpError(410, "This link has expired. Ask for a new one in Account settings.");
      if (await t.one(`SELECT 1 FROM users WHERE email=$1 AND id<>$2`, [row.new_email, row.user_id])) {
        throw new HttpError(409, "Another account started using that email in the meantime.");
      }
      await t.query(`UPDATE email_tokens SET used_at=now() WHERE token_hash=$1`, [hashToken(token)]);
      await t.query(`UPDATE users SET email=$2, email_verified_at=now() WHERE id=$1`, [row.user_id, row.new_email]);
      // Older confirmation links for the previous address no longer apply.
      await t.query(`DELETE FROM email_tokens WHERE user_id=$1 AND kind='verify' AND used_at IS NULL`, [row.user_id]);
      return row.new_email;
    });
    return { ok: true, email };
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
