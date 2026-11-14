import type { Db } from "./db";
import { HttpError } from "./errors";

export type Role = "read" | "commenter" | "editor" | "creator" | "owner";
export const RANK: Record<Role, number> = { read: 0, commenter: 1, editor: 2, creator: 3, owner: 4 };

/**
 * Who can edit a field's values, or add/delete a table's records:
 *  - "all": anyone who can edit records (editors and up, including people invited to just this base)
 *  - "team": workspace members only (editors and up) — not people invited to just this base, e.g. clients
 *  - "creators": creators and owners only
 */
export type EditAccess = "all" | "team" | "creators";
export const EDIT_ACCESS = ["all", "team", "creators"] as const;

/** A user's access to a base: their role, and whether it comes only from a base invite ("guest"). */
export interface Access {
  role: Role;
  guest: boolean;
}

function check(role: Role | undefined, min: Role) {
  // 404 (not 403) when there is no access at all, so ids can't be probed.
  if (!role) throw new HttpError(404, "Not found");
  if (RANK[role] < RANK[min]) throw new HttpError(403, "You don't have permission to do that");
}

/** Workspace-level access only (base guests have none). */
export async function workspaceAccess(db: Db, userId: string, workspaceId: string, min: Role) {
  const r = await db.one<{ role: Role }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  check(r?.role, min);
}

/** The better of the workspace role and a base-only role. */
async function resolve(db: Db, userId: string, where: string, id: string): Promise<Access | undefined> {
  const r = await db.one<{ ws: Role | null; base: Role | null }>(
    `SELECT wm.role AS ws, bm.role AS base
     FROM ${where}
     LEFT JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = $2
     LEFT JOIN base_members bm ON bm.base_id = b.id AND bm.user_id = $2`,
    [id, userId],
  );
  if (!r || (!r.ws && !r.base)) return undefined;
  if (r.ws && (!r.base || RANK[r.ws] >= RANK[r.base])) return { role: r.ws, guest: false };
  return { role: r.base!, guest: !r.ws };
}

export async function baseAccess(db: Db, userId: string, baseId: string, min: Role): Promise<Access> {
  const a = await resolve(db, userId, `(SELECT * FROM bases WHERE id = $1) b`, baseId);
  check(a?.role, min);
  return a!;
}

export async function tableAccess(db: Db, userId: string, tableId: string, min: Role): Promise<Access> {
  const a = await resolve(db, userId, `(SELECT b.* FROM tables t JOIN bases b ON b.id = t.base_id WHERE t.id = $1) b`, tableId);
  check(a?.role, min);
  return a!;
}

/** Does this access level satisfy a field's or table's edit restriction? */
export function allowed(access: Access, rule: EditAccess | undefined): boolean {
  if (RANK[access.role] < RANK.editor) return false;
  if (rule === "creators") return RANK[access.role] >= RANK.creator;
  if (rule === "team") return !access.guest;
  return true;
}

/** Refuse a write that touches fields this user may not edit. */
export async function checkFieldEdits(db: Db, access: Access, tableId: string, fieldIds: string[]) {
  if (!fieldIds.length || RANK[access.role] >= RANK.owner) return;
  const rows = await db.query<{ id: string; name: string; rule: EditAccess | null }>(
    `SELECT id, name, options->>'editAccess' AS rule FROM fields WHERE table_id=$1 AND id = ANY($2)`,
    [tableId, fieldIds],
  );
  const blocked = rows.filter((f) => !allowed(access, f.rule ?? "all"));
  if (blocked.length) {
    throw new HttpError(403, `You can't edit ${blocked.map((f) => `“${f.name}”`).join(", ")} — ${blocked.length > 1 ? "these fields are" : "this field is"} locked`);
  }
}

/** Refuse adding or deleting records in a table that restricts it. */
export async function checkRecordAccess(db: Db, access: Access, tableId: string, what: "add" | "delete") {
  const t = await db.one<{ record_access: EditAccess }>(`SELECT record_access FROM tables WHERE id=$1`, [tableId]);
  if (!allowed(access, t?.record_access ?? "all")) {
    throw new HttpError(403, `You can't ${what} records in this table`);
  }
}

export async function fieldTableId(db: Db, fieldId: string): Promise<string> {
  const r = await db.one<{ table_id: string }>(`SELECT table_id FROM fields WHERE id = $1`, [fieldId]);
  if (!r) throw new HttpError(404, "Not found");
  return r.table_id;
}

export async function recordTableId(db: Db, recordId: string): Promise<string> {
  const r = await db.one<{ table_id: string }>(
    `SELECT table_id FROM records WHERE id = $1 AND deleted_at IS NULL`,
    [recordId],
  );
  if (!r) throw new HttpError(404, "Not found");
  return r.table_id;
}

export async function viewTableId(db: Db, viewId: string): Promise<string> {
  const r = await db.one<{ table_id: string }>(`SELECT table_id FROM views WHERE id = $1`, [viewId]);
  if (!r) throw new HttpError(404, "Not found");
  return r.table_id;
}
