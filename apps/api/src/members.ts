import { newId } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { workspaceAccess, type Role } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";

/**
 * Workspace members and invitations.
 *
 * There's no email server, so inviting someone who doesn't have an account yet creates an
 * invite link the owner copies and sends. The link only works for the invited email address,
 * expires after 14 days, and is stored hashed (only the person holding the link knows it).
 */

const ROLES = ["owner", "creator", "editor", "commenter", "read"] as const;
const INVITE_DAYS = 14;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

async function ownerCount(db: Db, wsId: string) {
  return (await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id=$1 AND role='owner'`, [wsId]))!.n;
}

export function registerMembers(app: FastifyInstance, db: Db) {
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
           WHERE workspace_id=$1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
          [wsId],
        )
      : [];
    return { members, invites, myRole: me?.role };
  });

  /**
   * Invite by email. Existing users are added straight away; otherwise an invite link is returned
   * (shown once — only its hash is stored).
   */
  app.post("/api/workspaces/:wsId/invites", async (req) => {
    const user = requireUser(req);
    const { wsId } = req.params as { wsId: string };
    const body = z
      .object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), role: z.enum(ROLES).default("editor") })
      .parse(req.body);
    await workspaceAccess(db, user.id, wsId, "owner");

    const existing = await db.one<{ id: string; name: string }>(`SELECT id, name FROM users WHERE email=$1`, [body.email]);
    if (existing) {
      const already = await db.one(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [wsId, existing.id]);
      if (already) throw new HttpError(409, `${existing.name} is already in this workspace`);
      await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [wsId, existing.id, body.role]);
      return { added: { userId: existing.id, name: existing.name, email: body.email, role: body.role } };
    }
    // Replace any older pending invite for the same email.
    await db.query(`DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL`, [wsId, body.email]);
    const token = randomBytes(24).toString("base64url");
    const id = newId("inv");
    await db.query(
      `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '${INVITE_DAYS} days')`,
      [id, wsId, body.email, body.role, hashToken(token), user.id],
    );
    return { invite: { id, email: body.email, role: body.role, token, path: `/invite/${token}` } };
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
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, w.name AS workspace, u.name AS "invitedBy"
       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash=$1`,
      [hashToken(token)],
    );
    if (!inv) throw new HttpError(404, "This invite link isn't valid");
    if (inv.accepted_at) throw new HttpError(410, "This invite has already been used");
    if (new Date(inv.expires_at) < new Date()) throw new HttpError(410, "This invite has expired — ask for a new one");
    return { email: inv.email, role: inv.role, workspace: inv.workspace, invitedBy: inv.invitedBy };
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
      await t.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [inv.workspace_id, user.id, inv.role],
      );
      await t.query(`UPDATE workspace_invites SET accepted_at=now() WHERE id=$1`, [inv.id]);
      return { workspaceId: inv.workspace_id };
    });
  });
}
