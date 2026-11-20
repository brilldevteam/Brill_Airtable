import { newId } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { baseAccess, RANK, workspaceAccess, type Access, type Role } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { emails, type Mailer } from "./mail";

/**
 * Workspace members and invitations.
 *
 * Every invite — to new and existing users alike — is emailed as a link and must be accepted
 * by someone signed in with that (confirmed) email address. Nobody is added to a workspace
 * without saying yes. The link expires after 14 days and is stored hashed. The owner also
 * gets the link back once, to send another way if email doesn't arrive.
 */

const ROLES = ["owner", "creator", "editor", "commenter", "read"] as const;
const INVITE_DAYS = 14;
const ROLE_LABEL: Record<Role, string> = { owner: "an owner", creator: "a creator", editor: "an editor", commenter: "a commenter", read: "a read-only member" };
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

async function ownerCount(db: Db, wsId: string) {
  return (await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id=$1 AND role='owner'`, [wsId]))!.n;
}

export function registerMembers(app: FastifyInstance, db: Db, opts: { mailer: Mailer; appUrl: string }) {
  /** Members and pending invites. Anyone in the workspace can see who else is in it. */
  app.get("/api/workspaces/:wsId/members", async (req) => {
    const user = requireUser(req);
    const { wsId } = req.params as { wsId: string };
    await workspaceAccess(db, user.id, wsId, "read");
    const members = await db.query(
      `SELECT u.id AS "userId", u.name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'creator' THEN 1 WHEN 'editor' THEN 2 WHEN 'commenter' THEN 3 ELSE 4 END, u.name`,
      [wsId],
    );
    const me = members.find((m: any) => m.userId === user.id);
    const invites = me?.role === "owner"
      ? await db.query(
          `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt" FROM workspace_invites
           WHERE workspace_id=$1 AND base_id IS NULL AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
          [wsId],
        )
      : [];
    return { members, invites, myRole: me?.role };
  });

  /** Invite by email: emails the link, and returns it once (only its hash is stored). */
  app.post("/api/workspaces/:wsId/invites", async (req) => {
    const user = requireUser(req);
    const { wsId } = req.params as { wsId: string };
    const body = z
      .object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), role: z.enum(ROLES).default("editor") })
      .parse(req.body);
    await workspaceAccess(db, user.id, wsId, "owner");

    const already = await db.one(
      `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id=$1 AND u.email=$2`,
      [wsId, body.email],
    );
    if (already) throw new HttpError(409, `${body.email} is already in this workspace`);
    // Replace any older pending invite for the same email.
    await db.query(`DELETE FROM workspace_invites WHERE workspace_id=$1 AND base_id IS NULL AND email=$2 AND accepted_at IS NULL`, [wsId, body.email]);
    const token = randomBytes(24).toString("base64url");
    const id = newId("inv");
    await db.query(
      `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '${INVITE_DAYS} days')`,
      [id, wsId, body.email, body.role, hashToken(token), user.id],
    );
    const ws = await db.one<{ name: string }>(`SELECT name FROM workspaces WHERE id=$1`, [wsId]);
    let emailed = true;
    try {
      await opts.mailer.send(emails.invite(body.email, user.name, ws!.name, ROLE_LABEL[body.role], `${opts.appUrl}/invite/${token}`));
    } catch (e) {
      emailed = false;
      req.log.error(e, "invite email failed");
    }
    return { invite: { id, email: body.email, role: body.role, token, path: `/invite/${token}`, emailed } };
  });

  app.delete("/api/workspaces/:wsId/invites/:inviteId", async (req) => {
    const user = requireUser(req);
    const { wsId, inviteId } = req.params as { wsId: string; inviteId: string };
    await workspaceAccess(db, user.id, wsId, "owner");
    await db.query(`DELETE FROM workspace_invites WHERE id=$1 AND workspace_id=$2`, [inviteId, wsId]);
    return { ok: true };
  });

  /** Change a member's role (owners only; the last owner can't be demoted). */
  app.patch("/api/workspaces/:wsId/members/:userId", async (req) => {
    const user = requireUser(req);
    const { wsId, userId } = req.params as { wsId: string; userId: string };
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    await workspaceAccess(db, user.id, wsId, "owner");
    const cur = await db.one<{ role: Role }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [wsId, userId]);
    if (!cur) throw new HttpError(404, "Not a member");
    if (cur.role === "owner" && role !== "owner" && (await ownerCount(db, wsId)) <= 1) {
      throw new HttpError(400, "A workspace needs at least one owner");
    }
    await db.query(`UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`, [wsId, userId, role]);
    return { ok: true };
  });

  /** Remove a member (owners), or leave the workspace yourself. */
  app.delete("/api/workspaces/:wsId/members/:userId", async (req) => {
    const user = requireUser(req);
    const { wsId, userId } = req.params as { wsId: string; userId: string };
    if (userId !== user.id) await workspaceAccess(db, user.id, wsId, "owner");
    else await workspaceAccess(db, user.id, wsId, "read");
    const cur = await db.one<{ role: Role }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [wsId, userId]);
    if (!cur) throw new HttpError(404, "Not a member");
    if (cur.role === "owner" && (await ownerCount(db, wsId)) <= 1) throw new HttpError(400, "A workspace needs at least one owner");
    await db.query(`DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [wsId, userId]);
    return { ok: true };
  });

  /** What an invite link is for (works signed out, so the page can say who invited you). */
  app.get("/api/invites/:token", async (req) => {
    const { token } = req.params as { token: string };
    const inv = await db.one(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, w.name AS workspace, b.name AS base, u.name AS "invitedBy"
       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
       LEFT JOIN bases b ON b.id = i.base_id
       WHERE i.token_hash=$1`,
      [hashToken(token)],
    );
    if (!inv) throw new HttpError(404, "This invite link isn't valid");
    if (inv.accepted_at) throw new HttpError(410, "This invite has already been used");
    if (new Date(inv.expires_at) < new Date()) throw new HttpError(410, "This invite has expired — ask for a new one");
    return { email: inv.email, role: inv.role, workspace: inv.workspace, base: inv.base ?? null, invitedBy: inv.invitedBy };
  });

  app.post("/api/invites/:token/accept", async (req) => {
    const user = requireUser(req);
    const { token } = req.params as { token: string };
    return db.tx(async (t) => {
      const inv = await t.one(`SELECT * FROM workspace_invites WHERE token_hash=$1 FOR UPDATE`, [hashToken(token)]);
      if (!inv) throw new HttpError(404, "This invite link isn't valid");
      if (inv.accepted_at) throw new HttpError(410, "This invite has already been used");
      if (new Date(inv.expires_at) < new Date()) throw new HttpError(410, "This invite has expired — ask for a new one");
      if (inv.email !== user.email.toLowerCase()) {
        throw new HttpError(403, `This invite is for ${inv.email}. Sign in with that email to accept it.`);
      }
      if (!user.emailVerified) {
        throw new HttpError(403, `Confirm your email address first — we sent a link to ${user.email}.`);
      }
      if (inv.base_id) {
        await t.query(
          `INSERT INTO base_members (base_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (base_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [inv.base_id, user.id, inv.role],
        );
      } else {
        await t.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [inv.workspace_id, user.id, inv.role],
        );
      }
      await t.query(`UPDATE workspace_invites SET accepted_at=now() WHERE id=$1`, [inv.id]);
      return { workspaceId: inv.workspace_id, baseId: inv.base_id ?? null };
    });
  });

  // ================= Sharing one base (e.g. with a client) =================
  const BASE_ROLES = ["creator", "editor", "commenter", "read"] as const;
  /** Workspace creators and owners manage who else can open a base; people invited to just the base can't. */
  const canManageBase = (a: Access) => !a.guest && RANK[a.role] >= RANK.creator;
  async function manageBase(userId: string, baseId: string) {
    const a = await baseAccess(db, userId, baseId, "read");
    if (!canManageBase(a)) throw new HttpError(403, "Only the workspace's creators and owners can share this base");
    return a;
  }

  /** Everyone who can open this base: workspace members, people invited to just this base, and pending invites. */
  app.get("/api/bases/:baseId/sharing", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const access = await baseAccess(db, user.id, baseId, "read");
    const base = await db.one<{ name: string; workspace_id: string; workspace: string }>(
      `SELECT b.name, b.workspace_id, w.name AS workspace FROM bases b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id=$1`, [baseId],
    );
    const manage = canManageBase(access);
    const owner = !access.guest && access.role === "owner";
    // People invited to just this base (clients) don't get to see everyone's email address.
    const emailCol = access.guest ? `CASE WHEN u.id = $2 THEN u.email ELSE '' END` : `CASE WHEN u.id = $2 THEN u.email ELSE u.email END`;
    const members = await db.query(
      `SELECT u.id AS "userId", u.name, ${emailCol} AS email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'creator' THEN 1 WHEN 'editor' THEN 2 WHEN 'commenter' THEN 3 ELSE 4 END, u.name`,
      [base!.workspace_id, user.id],
    );
    const guests = await db.query(
      `SELECT u.id AS "userId", u.name, ${emailCol} AS email, bm.role FROM base_members bm JOIN users u ON u.id = bm.user_id
       WHERE bm.base_id=$1 AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=$3 AND m.user_id=bm.user_id)
       ORDER BY bm.created_at`,
      [baseId, user.id, base!.workspace_id],
    );
    const invites = manage
      ? await db.query(
          `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt",
                  CASE WHEN base_id IS NULL THEN 'workspace' ELSE 'base' END AS scope
           FROM workspace_invites
           WHERE accepted_at IS NULL AND expires_at > now()
             AND ((base_id = $1) OR (base_id IS NULL AND workspace_id = $2 AND $3::boolean))
           ORDER BY created_at DESC`,
          [baseId, base!.workspace_id, owner],
        )
      : [];
    return {
      base: { id: baseId, name: base!.name },
      workspace: { id: base!.workspace_id, name: base!.workspace },
      myRole: access.role,
      guest: access.guest,
      canManageBase: manage,
      canManageWorkspace: owner,
      members,
      guests,
      invites,
    };
  });

  /** Invite someone to this base only. They won't see the workspace's other bases. */
  app.post("/api/bases/:baseId/invites", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const body = z
      .object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), role: z.enum(BASE_ROLES).default("editor") })
      .parse(req.body);
    await manageBase(user.id, baseId);
    const base = await db.one<{ name: string; workspace_id: string }>(`SELECT name, workspace_id FROM bases WHERE id=$1`, [baseId]);
    const inWorkspace = await db.one(
      `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id=$1 AND u.email=$2`,
      [base!.workspace_id, body.email],
    );
    if (inWorkspace) throw new HttpError(409, `${body.email} is in the workspace already, so they can open this base`);
    const onBase = await db.one(
      `SELECT 1 FROM base_members bm JOIN users u ON u.id = bm.user_id WHERE bm.base_id=$1 AND u.email=$2`, [baseId, body.email],
    );
    if (onBase) throw new HttpError(409, `${body.email} already has access to this base — change their role instead`);

    await db.query(`DELETE FROM workspace_invites WHERE base_id=$1 AND email=$2 AND accepted_at IS NULL`, [baseId, body.email]);
    const token = randomBytes(24).toString("base64url");
    const id = newId("inv");
    await db.query(
      `INSERT INTO workspace_invites (id, workspace_id, base_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${INVITE_DAYS} days')`,
      [id, base!.workspace_id, baseId, body.email, body.role, hashToken(token), user.id],
    );
    let emailed = true;
    try {
      await opts.mailer.send(emails.baseInvite(body.email, user.name, base!.name, ROLE_LABEL[body.role], `${opts.appUrl}/invite/${token}`));
    } catch (e) {
      emailed = false;
      req.log.error(e, "invite email failed");
    }
    return { invite: { id, email: body.email, role: body.role, token, path: `/invite/${token}`, emailed } };
  });

  app.delete("/api/bases/:baseId/invites/:inviteId", async (req) => {
    const user = requireUser(req);
    const { baseId, inviteId } = req.params as { baseId: string; inviteId: string };
    await manageBase(user.id, baseId);
    await db.query(`DELETE FROM workspace_invites WHERE id=$1 AND base_id=$2`, [inviteId, baseId]);
    return { ok: true };
  });

  app.patch("/api/bases/:baseId/members/:userId", async (req) => {
    const user = requireUser(req);
    const { baseId, userId } = req.params as { baseId: string; userId: string };
    const { role } = z.object({ role: z.enum(BASE_ROLES) }).parse(req.body);
    await manageBase(user.id, baseId);
    const r = await db.one(`UPDATE base_members SET role=$3 WHERE base_id=$1 AND user_id=$2 RETURNING 1`, [baseId, userId, role]);
    if (!r) throw new HttpError(404, "Not a member of this base");
    return { ok: true };
  });

  /** Remove someone's access to this base (managers), or leave it yourself. */
  app.delete("/api/bases/:baseId/members/:userId", async (req) => {
    const user = requireUser(req);
    const { baseId, userId } = req.params as { baseId: string; userId: string };
    if (userId === user.id) await baseAccess(db, user.id, baseId, "read");
    else await manageBase(user.id, baseId);
    const r = await db.one(`DELETE FROM base_members WHERE base_id=$1 AND user_id=$2 RETURNING 1`, [baseId, userId]);
    if (!r) throw new HttpError(404, "Not a member of this base");
    return { ok: true };
  });

  /** People who can open this base — for user fields and "assigned to" filters. */
  app.get("/api/bases/:baseId/collaborators", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const access = await baseAccess(db, user.id, baseId, "read");
    const rows = await db.query<{ id: string; name: string; email: string }>(
      `SELECT u.id, u.name, u.email FROM users u JOIN bases b ON b.id = $1
       WHERE EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = b.workspace_id AND m.user_id = u.id)
          OR EXISTS (SELECT 1 FROM base_members bm WHERE bm.base_id = b.id AND bm.user_id = u.id)
       ORDER BY lower(u.name)`,
      [baseId],
    );
    // People invited to just this base don't see everyone's email address.
    return { users: rows.map((r) => ({ id: r.id, name: r.name, email: access.guest && r.id !== user.id ? "" : r.email })) };
  });
}
