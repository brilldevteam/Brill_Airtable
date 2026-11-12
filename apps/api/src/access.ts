import type { Db } from "./db";
import { HttpError } from "./errors";

export type Role = "read" | "commenter" | "editor" | "creator" | "owner";
const RANK: Record<Role, number> = { read: 0, commenter: 1, editor: 2, creator: 3, owner: 4 };

function check(role: Role | undefined, min: Role) {
  // 404 (not 403) when there is no access at all, so ids can't be probed.
  if (!role) throw new HttpError(404, "Not found");
  if (RANK[role] < RANK[min]) throw new HttpError(403, "You don't have permission to do that");
}

export async function workspaceAccess(db: Db, userId: string, workspaceId: string, min: Role) {
  const r = await db.one<{ role: Role }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  check(r?.role, min);
}

export async function baseAccess(db: Db, userId: string, baseId: string, min: Role) {
  const r = await db.one<{ role: Role }>(
    `SELECT m.role FROM bases b JOIN workspace_members m ON m.workspace_id = b.workspace_id
     WHERE b.id = $1 AND m.user_id = $2`,
    [baseId, userId],
  );
  check(r?.role, min);
}

export async function tableAccess(db: Db, userId: string, tableId: string, min: Role) {
  const r = await db.one<{ role: Role }>(
    `SELECT m.role FROM tables t JOIN bases b ON b.id = t.base_id
     JOIN workspace_members m ON m.workspace_id = b.workspace_id
     WHERE t.id = $1 AND m.user_id = $2`,
    [tableId, userId],
  );
  check(r?.role, min);
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
