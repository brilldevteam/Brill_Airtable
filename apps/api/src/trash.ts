import { cellToText, type CellValue, type Field } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { baseAccess, checkRecordAccess, tableAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { computeAllForRecord, labelsFor, logHistory, propagate, Schema, userNames } from "./links";
import { loadFields, toRecord } from "./routes";

/**
 * Trash: deleted records stay restorable for 30 days, then they're removed for good.
 *
 * Deleting already only hides a record (deleted_at) and takes it out of other records' links;
 * the record keeps its own cells. Restoring un-hides it and puts it back into the links it had,
 * on the other side too — skipping records that have since been deleted themselves.
 */
export const TRASH_DAYS = 30;
type Cells = Record<string, CellValue>;

/** Where a deleted record's id belongs again: its link fields and their inverse fields. */
async function restoreRecord(t: Db, userId: string, tableId: string, recordId: string) {
  const schema = new Schema(t);
  const fields = await schema.fields(tableId);
  const row = await t.one<{ cells: Cells; trash_links: Record<string, string[]> | null }>(
    `SELECT cells, trash_links FROM records WHERE id=$1 FOR UPDATE`, [recordId],
  );
  if (!row) throw new HttpError(404, "Not found");
  const cells = { ...row.cells };
  const changes: { recordId: string; tableId: string; fields: Set<string> }[] = [];
  /** Links to records that are still in the trash: remembered so they come back when those do. */
  const waiting: Record<string, string[]> = { ...(row.trash_links ?? {}) };

  for (const f of fields.filter((x) => x.type === "link")) {
    const ids = (cells[f.id] as string[] | undefined) ?? [];
    if (!ids.length) continue;
    const alive = await t.query<{ id: string; table_id: string; cells: Cells }>(
      `SELECT id, table_id, cells FROM records WHERE id = ANY($1::text[]) AND deleted_at IS NULL`, [ids],
    );
    const aliveIds = new Set(alive.map((r) => r.id));
    const kept = ids.filter((id) => aliveIds.has(id));
    if (kept.length !== ids.length) {
      if (kept.length) cells[f.id] = kept;
      else delete cells[f.id];
      waiting[f.id] = [...new Set([...(waiting[f.id] ?? []), ...ids.filter((id) => !aliveIds.has(id))])];
    }
    const inv = f.options.inverseFieldId;
    if (!inv) continue;
    for (const other of alive) {
      const cur = (other.cells[inv] as string[] | undefined) ?? [];
      if (cur.includes(recordId)) continue;
      await t.query(`UPDATE records SET cells = cells || jsonb_build_object($2::text, $3::jsonb) WHERE id=$1`, [
        other.id, inv, JSON.stringify([...cur, recordId]),
      ]);
      changes.push({ recordId: other.id, tableId: other.table_id, fields: new Set([inv]) });
    }
  }
  // Records restored earlier that were waiting for this one: link them up again, on both sides.
  const waiters = await t.query<{ id: string; table_id: string; cells: Cells; trash_links: Record<string, string[]> }>(
    `SELECT id, table_id, cells, trash_links FROM records
     WHERE deleted_at IS NULL AND trash_links IS NOT NULL AND id <> $1 AND trash_links::text LIKE '%' || $1 || '%'`,
    [recordId],
  );
  for (const w of waiters) {
    const wFields = await schema.fields(w.table_id);
    const nextWaiting: Record<string, string[]> = {};
    const wCells = { ...w.cells };
    const touched = new Set<string>();
    for (const [fid, ids] of Object.entries(w.trash_links)) {
      const lf = wFields.find((x) => x.id === fid && x.type === "link");
      const rest = ids.filter((id) => id !== recordId);
      if (rest.length) nextWaiting[fid] = rest;
      if (!lf || !ids.includes(recordId) || lf.options.linkedTableId !== tableId) continue;
      const cur = (wCells[fid] as string[] | undefined) ?? [];
      if (!cur.includes(recordId)) wCells[fid] = [...cur, recordId];
      touched.add(fid);
      const inv = lf.options.inverseFieldId;
      if (inv) {
        const mine = (cells[inv] as string[] | undefined) ?? [];
        if (!mine.includes(w.id)) cells[inv] = [...mine, w.id];
      }
    }
    await t.query(`UPDATE records SET cells=$2, trash_links=$3 WHERE id=$1`, [
      w.id, wCells, Object.keys(nextWaiting).length ? nextWaiting : null,
    ]);
    if (touched.size) changes.push({ recordId: w.id, tableId: w.table_id, fields: touched });
  }

  await t.query(`UPDATE records SET deleted_at = NULL, cells = $2, updated_by = $3, trash_links = $4 WHERE id=$1`, [
    recordId, cells, userId, Object.keys(waiting).length ? waiting : null,
  ]);
  await logHistory(t, recordId, userId, "restore", {});
  await computeAllForRecord(t, schema, tableId, recordId);
  await propagate(t, schema, changes);
}

async function deletedRecordTable(db: Db, recordId: string): Promise<string> {
  const r = await db.one<{ table_id: string }>(`SELECT table_id FROM records WHERE id=$1 AND deleted_at IS NOT NULL`, [recordId]);
  if (!r) throw new HttpError(404, "That record isn't in the trash");
  return r.table_id;
}

export function registerTrash(app: FastifyInstance, db: Db) {
  /** Deleted records in a base, newest first, with enough detail to recognise them. */
  app.get("/api/bases/:baseId/trash", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "editor");
    const rows = await db.query<{
      id: string; table_id: string; table_name: string; primary_field_id: string; cells: Cells; deleted_at: string; deleted_by: string | null;
    }>(
      `SELECT r.id, r.table_id, t.name AS table_name, t.primary_field_id, r.cells, r.deleted_at,
              (SELECT h.user_id FROM record_history h WHERE h.record_id = r.id AND h.kind = 'delete' ORDER BY h.id DESC LIMIT 1) AS deleted_by
       FROM records r JOIN tables t ON t.id = r.table_id
       WHERE t.base_id = $1 AND r.deleted_at IS NOT NULL AND r.deleted_at > now() - interval '${TRASH_DAYS} days'
       ORDER BY r.deleted_at DESC LIMIT 500`,
      [baseId],
    );
    const fieldsByTable = new Map<string, Field[]>();
    for (const tid of new Set(rows.map((r) => r.table_id))) fieldsByTable.set(tid, await loadFields(db, tid));
    const schema = new Schema(db);
    const linkIds = rows.flatMap((r) =>
      (fieldsByTable.get(r.table_id) ?? []).filter((f) => f.type === "link").flatMap((f) => (r.cells[f.id] as string[] | undefined) ?? []),
    );
    const labels = { ...(await labelsFor(db, schema, linkIds)), ...(await userNames(db, rows.map((r) => r.deleted_by ?? "").filter(Boolean))) };
    return {
      days: TRASH_DAYS,
      items: rows.map((r) => {
        const fields = fieldsByTable.get(r.table_id) ?? [];
        const primary = fields.find((f) => f.id === r.primary_field_id);
        // A few other filled-in values so similar records can be told apart.
        const details = fields
          .filter((f) => f.id !== r.primary_field_id && f.type !== "attachment" && r.cells[f.id] !== undefined && r.cells[f.id] !== null)
          .slice(0, 3)
          .map((f) => ({ field: f.name, value: cellToText(f, r.cells[f.id] ?? null, labels) }))
          .filter((d) => d.value);
        return {
          id: r.id,
          tableId: r.table_id,
          tableName: r.table_name,
          name: primary ? cellToText(primary, r.cells[primary.id] ?? null, labels) : "",
          details,
          deletedAt: new Date(r.deleted_at).toISOString(),
          deletedBy: r.deleted_by ? labels[r.deleted_by] ?? null : null,
        };
      }),
    };
  });

  /** Put a deleted record back, with its links. */
  app.post("/api/records/:recordId/restore", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    const tableId = await deletedRecordTable(db, recordId);
    const access = await tableAccess(db, user.id, tableId, "editor");
    await checkRecordAccess(db, access, tableId, "add");
    const record = await db.tx(async (t) => {
      await restoreRecord(t, user.id, tableId, recordId);
      return toRecord(await t.one(`SELECT * FROM records WHERE id=$1`, [recordId]));
    });
    return { record };
  });

  /** Remove a record from the trash for good. */
  app.delete("/api/records/:recordId/permanent", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    const tableId = await deletedRecordTable(db, recordId);
    const access = await tableAccess(db, user.id, tableId, "editor");
    await checkRecordAccess(db, access, tableId, "delete");
    await db.query(`DELETE FROM records WHERE id=$1 AND deleted_at IS NOT NULL`, [recordId]);
    return { ok: true };
  });

  // Empty records out of the trash once they're older than 30 days (at start-up, then daily).
  const purge = () =>
    db.query(`DELETE FROM records WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '${TRASH_DAYS} days'`).catch(() => {});
  app.addHook("onReady", async () => { void purge(); });
  const timer = setInterval(purge, 24 * 3600_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
