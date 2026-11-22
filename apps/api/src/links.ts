import {
  COMPUTED_TYPES,
  SYSTEM_TYPES,
  USER_TYPES,
  MODIFIED_DEP,
  NUMERIC_ROLLUPS,
  cellToFormulaValue,
  cellToText,
  compileFormula,
  runFormula,
  type CompiledFormula,
  type CellValue,
  type Field,
  type LinkLabels,
} from "@brill/shared";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { addNotifications } from "./notifications";

/**
 * Linked records & computed fields engine.
 *
 * - Link fields store record ids on BOTH sides (field + its inverse field in the other table).
 * - Lookup / rollup / count values are computed here and stored in `cells`, so reading,
 *   filtering and sorting never has to join. Whenever a value they depend on changes,
 *   `propagate` recomputes the affected records, following chains (lookup of a lookup…).
 */

type Cells = Record<string, CellValue>;
const toField = (r: any): Field => ({
  id: r.id, tableId: r.table_id, name: r.name, type: r.type, options: r.options ?? {}, position: r.position,
});

export interface RecordMeta { id: string; createdAt: Date; updatedAt: Date; createdBy: string | null; updatedBy: string | null }
const metaOf = (r: any): RecordMeta => ({
  id: r.id, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
  createdBy: r.created_by ?? null, updatedBy: r.updated_by ?? null,
});
/** Columns metaOf needs. */
const META_COLS = "id, cells, created_at, updated_at, created_by, updated_by";

/** Does a computed field need recomputing when these fields of the same record changed? */
function dependsOnChanged(f: Field, changed: Set<string>): boolean {
  // "Last modified" fields follow every edit; the other system fields are set once, at creation.
  if (f.type === "lastModifiedTime" || f.type === "lastModifiedBy") return changed.has(MODIFIED_DEP);
  if (SYSTEM_TYPES.has(f.type)) return false;
  if (f.type === "formula") return (f.options.dependsOn ?? []).some((d) => changed.has(d));
  return COMPUTED_TYPES.has(f.type) && changed.has(f.options.linkFieldId ?? "");
}

/** Per-operation cache of table schemas. */
export class Schema {
  private cache = new Map<string, Field[]>();
  private formulas = new Map<string, CompiledFormula | null>();
  /** Compiled formula for a formula field (null if it no longer compiles). */
  async formula(field: Field): Promise<CompiledFormula | null> {
    const key = field.id + "|" + field.options.formula;
    if (!this.formulas.has(key)) {
      try {
        this.formulas.set(key, compileFormula(field.options.formula ?? "", await this.fields(field.tableId), field.id));
      } catch {
        this.formulas.set(key, null);
      }
    }
    return this.formulas.get(key)!;
  }
  constructor(private db: Db) {}
  async fields(tableId: string): Promise<Field[]> {
    let f = this.cache.get(tableId);
    if (!f) {
      f = (await this.db.query(`SELECT * FROM fields WHERE table_id=$1 ORDER BY position, id`, [tableId])).map(toField);
      this.cache.set(tableId, f);
    }
    return f;
  }
  async field(fieldId: string): Promise<Field | undefined> {
    for (const list of this.cache.values()) {
      const f = list.find((x) => x.id === fieldId);
      if (f) return f;
    }
    const r = await this.db.one(`SELECT table_id FROM fields WHERE id=$1`, [fieldId]);
    return r ? (await this.fields(r.table_id)).find((x) => x.id === fieldId) : undefined;
  }
  async primary(tableId: string): Promise<Field | undefined> {
    const t = await this.db.one<{ primary_field_id: string }>(`SELECT primary_field_id FROM tables WHERE id=$1`, [tableId]);
    return (await this.fields(tableId)).find((f) => f.id === t?.primary_field_id);
  }
}

function sameValue(a: CellValue | undefined, b: CellValue | undefined) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function withCell(cells: Cells, fieldId: string, value: CellValue): Cells {
  const next = { ...cells };
  if (value === null || (Array.isArray(value) && value.length === 0)) delete next[fieldId];
  else next[fieldId] = value;
  return next;
}

async function loadRecords(db: Db, ids: string[]): Promise<Map<string, { id: string; table_id: string; cells: Cells }>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query(`SELECT id, table_id, cells FROM records WHERE id = ANY($1::text[]) AND deleted_at IS NULL`, [ids]);
  return new Map(rows.map((r: any) => [r.id, r]));
}

/** Display names (primary field text) for records, grouped by their table. */
export async function labelsFor(db: Db, schema: Schema, ids: string[]): Promise<LinkLabels> {
  const unique = [...new Set(ids)];
  const labels: LinkLabels = {};
  if (unique.length === 0) return labels;
  const recs = await loadRecords(db, unique);
  const primaries = new Map<string, Field | undefined>();
  for (const r of recs.values()) {
    if (!primaries.has(r.table_id)) primaries.set(r.table_id, await schema.primary(r.table_id));
    const p = primaries.get(r.table_id);
    // Primary fields can themselves be links; keep it simple and show ids-free text.
    labels[r.id] = p ? cellToText(p, r.cells[p.id] ?? null, {}) : "";
  }
  return labels;
}

/** Throws 422 unless every id is a live record in the linked table. */
export async function assertLinkTargets(db: Db, field: Field, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM records WHERE table_id=$1 AND id = ANY($2::text[]) AND deleted_at IS NULL`,
    [field.options.linkedTableId, ids],
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(422, `${field.name}: some linked records don't exist`);
}

/** Calculate a lookup / rollup / count / formula value for one record. */
export async function computeValue(db: Db, schema: Schema, field: Field, cells: Cells, meta?: RecordMeta): Promise<CellValue> {
  switch (field.type) {
    case "autonumber": {
      // Numbers are given once and never reused, even after records are deleted.
      if (typeof cells[field.id] === "number") return cells[field.id];
      await db.query(`SELECT 1 FROM fields WHERE id=$1 FOR UPDATE`, [field.id]);
      const r = await db.one<{ n: string }>(
        `SELECT COALESCE(MAX((cells->>$2)::bigint), 0) + 1 AS n FROM records WHERE table_id=$1`, [field.tableId, field.id],
      );
      return Number(r!.n);
    }
    case "createdTime": return meta ? meta.createdAt.toISOString() : (cells[field.id] ?? null);
    case "lastModifiedTime": return meta ? meta.updatedAt.toISOString() : (cells[field.id] ?? null);
    case "createdBy": return meta ? (meta.createdBy ? [meta.createdBy] : null) : (cells[field.id] ?? null);
    case "lastModifiedBy": return meta ? (meta.updatedBy ? [meta.updatedBy] : null) : (cells[field.id] ?? null);
  }
  if (field.type === "formula") {
    const compiled = await schema.formula(field);
    if (!compiled) return null;
    const tableFields = await schema.fields(field.tableId);
    const byId = new Map(tableFields.map((f) => [f.id, f]));
    // Linked records are seen by formulas as their names, attachments as their filenames.
    const idsOf = (type: string) => compiled.dependsOn.flatMap((d) => (byId.get(d)?.type === type ? ((cells[d] as string[]) ?? []) : []));
    const linkIds = idsOf("link");
    const labels = linkIds.length ? await labelsFor(db, schema, linkIds) : {};
    Object.assign(labels, await attachmentNames(db, idsOf("attachment")));
    Object.assign(labels, await userNames(db, [...idsOf("user"), ...idsOf("createdBy"), ...idsOf("lastModifiedBy")]));
    const now = new Date();
    return runFormula(compiled.ast, compiled.resultType, {
      field: (id) => {
        const f = byId.get(id);
        return f ? cellToFormulaValue(f, cells[id] ?? null, labels) : null;
      },
      recordId: meta?.id ?? "",
      createdTime: meta?.createdAt ?? now,
      lastModifiedTime: meta?.updatedAt ?? now,
      now,
    });
  }
  const ids = (cells[field.options.linkFieldId ?? ""] as string[] | undefined) ?? [];
  if (field.type === "count") return ids.length;

  const linkField = await schema.field(field.options.linkFieldId ?? "");
  const target = await schema.field(field.options.targetFieldId ?? "");
  if (!linkField || !target) return null;

  const recs = await loadRecords(db, ids);
  const raw: CellValue[] = ids.map((id) => recs.get(id)?.cells[target.id] ?? null);

  if (field.type === "lookup") {
    let labels: LinkLabels = {};
    if (target.type === "link") labels = await labelsFor(db, schema, raw.flatMap((v) => (Array.isArray(v) ? v : [])));
    if (target.type === "attachment") labels = await attachmentNames(db, raw.flatMap((v) => (Array.isArray(v) ? v : [])));
    if (USER_TYPES.has(target.type)) labels = await userNames(db, raw.flatMap((v) => (Array.isArray(v) ? v : [])));
    const texts: string[] = [];
    for (const v of raw) {
      if (v === null) continue;
      if (target.type === "lookup" && Array.isArray(v)) texts.push(...v);
      else if (target.type === "link" && Array.isArray(v)) texts.push(...v.map((id) => labels[id] || "Unnamed record"));
      else if (target.type === "attachment" && Array.isArray(v)) texts.push(...v.map((id) => labels[id] || "file"));
      else if (USER_TYPES.has(target.type) && Array.isArray(v)) texts.push(...v.map((id) => labels[id] || "Unknown user"));
      else if (target.type === "multipleSelect" && Array.isArray(v)) texts.push(...cellToText(target, v).split(", "));
      else {
        const t = cellToText(target, v);
        if (t) texts.push(t);
      }
    }
    return texts.length ? texts : null;
  }

  // rollup
  const agg = field.options.aggregation ?? "sum";
  const flat = raw.flatMap((v) => (Array.isArray(v) ? v : [v]));
  if (NUMERIC_ROLLUPS.has(agg)) {
    if (agg === "countAll") return flat.length;
    const present = flat.filter((v) => v !== null && v !== "");
    if (agg === "count") return present.length;
    const nums = present.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => Number.isFinite(n));
    if (agg === "sum") return round(nums.reduce((a, b) => a + b, 0));
    if (nums.length === 0) return null;
    if (agg === "avg") return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    if (agg === "min") return Math.min(...nums);
    if (agg === "max") return Math.max(...nums);
  }
  const texts = flat.filter((v) => v !== null).map((v) => (target.type === "lookup" ? String(v) : cellToText(target, v as CellValue)));
  const list = agg === "joinUnique" ? [...new Set(texts)] : texts;
  return list.length ? list.join(", ") : null;
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;

interface Change { recordId: string; tableId: string; fields: Set<string> }

/**
 * Recompute everything that depends on the given changes, transitively.
 * Must run inside the same transaction as the write that caused the changes.
 */
export async function propagate(db: Db, schema: Schema, initial: Change[]) {
  const queue = [...initial];
  let steps = 0;
  while (queue.length) {
    if (++steps > 10_000) throw new HttpError(500, "Too many dependent updates (is there a loop?)");
    const { recordId, tableId, fields: changed } = queue.shift()!;
    const tableFields = await schema.fields(tableId);

    // 1. This record's own lookups/rollups/counts that follow a link field that changed.
    const own = tableFields.filter((f) => dependsOnChanged(f, changed));
    if (own.length) {
      const row = await db.one(`SELECT ${META_COLS} FROM records WHERE id=$1 AND deleted_at IS NULL`, [recordId]);
      if (row) {
        let cells: Cells = row.cells;
        const updated = new Set<string>();
        for (const f of own) {
          const v = await computeValue(db, schema, f, cells, metaOf(row));
          if (!sameValue(cells[f.id], v)) {
            cells = withCell(cells, f.id, v);
            updated.add(f.id);
          }
        }
        if (updated.size) {
          await db.query(`UPDATE records SET cells=$2 WHERE id=$1`, [recordId, cells]);
          queue.push({ recordId, tableId, fields: updated });
        }
      }
    }

    // 2. Records elsewhere whose lookups/rollups read a changed field of this record.
    const dependents = (
      await db.query(
        `SELECT * FROM fields WHERE type IN ('lookup','rollup') AND options->>'targetFieldId' = ANY($1::text[])`,
        [[...changed]],
      )
    ).map(toField);
    for (const dep of dependents) {
      const link = dep.options.linkFieldId!;
      const rows = await db.query<{ id: string; cells: Cells }>(
        `SELECT id, cells FROM records WHERE table_id=$1 AND deleted_at IS NULL AND cells->$2 ? $3`,
        [dep.tableId, link, recordId],
      );
      for (const r of rows) {
        const v = await computeValue(db, schema, dep, r.cells);
        if (!sameValue(r.cells[dep.id], v)) {
          await db.query(`UPDATE records SET cells=$2 WHERE id=$1`, [r.id, withCell(r.cells, dep.id, v)]);
          queue.push({ recordId: r.id, tableId: dep.tableId, fields: new Set([dep.id]) });
        }
      }
    }
  }
}

/**
 * Write cell changes to a record (already validated/normalised), keep inverse links in sync,
 * and recompute dependants. Returns the record's final cells.
 */
export async function writeCells(
  db: Db, schema: Schema, userId: string | null, tableId: string, recordId: string, patch: Cells,
  history: "create" | "update" = "update",
): Promise<void> {
  const fields = await schema.fields(tableId);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const row = await db.one<{ cells: Cells }>(`SELECT cells FROM records WHERE id=$1 FOR UPDATE`, [recordId]);
  const before = row?.cells ?? {};
  let after = before;
  const changed = new Set<string>();
  for (const [fid, v] of Object.entries(patch)) {
    if (!sameValue(before[fid], v)) {
      after = withCell(after, fid, v);
      changed.add(fid);
    }
  }
  if (changed.size === 0) {
    if (history === "create") await logHistory(db, recordId, userId, "create", {});
    return;
  }
  await db.query(`UPDATE records SET cells=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [recordId, after, userId]);
  await logHistory(db, recordId, userId, history, diffOf(before, after, changed));

  // People newly added to a person field that notifies them.
  for (const fid of changed) {
    const f = byId.get(fid);
    if (f?.type !== "user" || !f.options.notify) continue;
    const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    const was = new Set(ids(before[fid]));
    const added = ids(after[fid]).filter((id) => !was.has(id));
    if (added.length) await addNotifications(db, added, { kind: "assigned", tableId, recordId, actorId: userId, data: { field: f.name } });
  }

  // LAST_MODIFIED_TIME() formulas depend on any edit.
  const changes: Change[] = [{ recordId, tableId, fields: new Set([...changed, MODIFIED_DEP]) }];
  // Mirror link changes onto the other side.
  for (const fid of changed) {
    const f = byId.get(fid);
    if (f?.type !== "link" || !f.options.inverseFieldId) continue;
    const oldIds = new Set((before[fid] as string[] | undefined) ?? []);
    const newIds = new Set((after[fid] as string[] | undefined) ?? []);
    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));
    const inv = f.options.inverseFieldId;
    const others = await loadRecords(db, [...added, ...removed]);
    for (const other of others.values()) {
      const cur = (other.cells[inv] as string[] | undefined) ?? [];
      const next = newIds.has(other.id) ? (cur.includes(recordId) ? cur : [...cur, recordId]) : cur.filter((id) => id !== recordId);
      if (sameValue(cur, next)) continue;
      await db.query(`UPDATE records SET cells=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [
        other.id, withCell(other.cells, inv, next), userId,
      ]);
      await logHistory(db, other.id, userId, "update", { [inv]: { from: cur.length ? cur : null, to: next.length ? next : null } });
      changes.push({ recordId: other.id, tableId: other.table_id, fields: new Set([inv, MODIFIED_DEP]) });
    }
  }
  await propagate(db, schema, changes);
}

/** Remove a (soft-deleted) record from every link pointing at it, then recompute. */
export async function unlinkRecord(db: Db, schema: Schema, userId: string, tableId: string, recordId: string) {
  const linkFields = (
    await db.query(`SELECT * FROM fields WHERE type='link' AND options->>'linkedTableId' = $1`, [tableId])
  ).map(toField);
  const changes: Change[] = [];
  for (const lf of linkFields) {
    const rows = await db.query<{ id: string; cells: Cells }>(
      `SELECT id, cells FROM records WHERE table_id=$1 AND deleted_at IS NULL AND cells->$2 ? $3`,
      [lf.tableId, lf.id, recordId],
    );
    for (const r of rows) {
      const next = ((r.cells[lf.id] as string[]) ?? []).filter((id) => id !== recordId);
      await db.query(`UPDATE records SET cells=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [r.id, withCell(r.cells, lf.id, next), userId]);
      changes.push({ recordId: r.id, tableId: lf.tableId, fields: new Set([lf.id, MODIFIED_DEP]) });
    }
  }
  await propagate(db, schema, changes);
}

/** (Re)compute one computed field for every record of its table, then propagate. */
export async function recomputeField(db: Db, schema: Schema, field: Field) {
  const rows = await db.query(
    `SELECT ${META_COLS} FROM records WHERE table_id=$1 AND deleted_at IS NULL ORDER BY created_at, autonumber`,
    [field.tableId],
  );
  const changes: Change[] = [];
  if (field.type === "autonumber") {
    // Number existing records in the order they were created.
    let n = 0;
    for (const r of rows) n = Math.max(n, typeof r.cells[field.id] === "number" ? r.cells[field.id] : 0);
    for (const r of rows) {
      if (typeof r.cells[field.id] === "number") continue;
      await db.query(`UPDATE records SET cells=$2 WHERE id=$1`, [r.id, withCell(r.cells, field.id, ++n)]);
      changes.push({ recordId: r.id, tableId: field.tableId, fields: new Set([field.id]) });
    }
    await propagate(db, schema, changes);
    return;
  }
  for (const r of rows) {
    const v = await computeValue(db, schema, field, r.cells, metaOf(r));
    if (!sameValue(r.cells[field.id], v)) {
      await db.query(`UPDATE records SET cells=$2 WHERE id=$1`, [r.id, withCell(r.cells, field.id, v)]);
      changes.push({ recordId: r.id, tableId: field.tableId, fields: new Set([field.id]) });
    }
  }
  await propagate(db, schema, changes);
}

/** Names of computed fields (anywhere) that read this field or follow this link field. */
export async function dependentFieldNames(db: Db, fieldId: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT f.name || ' (' || t.name || ')' AS name FROM fields f JOIN tables t ON t.id = f.table_id
     WHERE (f.type IN ('lookup','rollup','count') AND (f.options->>'targetFieldId' = $1 OR f.options->>'linkFieldId' = $1))
        OR (f.type = 'formula' AND (f.options->'dependsOn') ? $1)`,
    [fieldId],
  );
  return rows.map((r) => r.name);
}

/**
 * Compute every calculated field of one record (used for new records), repeating until
 * values settle so formulas that use other formulas come out right, then update dependants.
 */
export async function computeAllForRecord(db: Db, schema: Schema, tableId: string, recordId: string) {
  const computed = (await schema.fields(tableId)).filter((f) => COMPUTED_TYPES.has(f.type));
  if (computed.length === 0) return;
  const row = await db.one(`SELECT ${META_COLS} FROM records WHERE id=$1`, [recordId]);
  if (!row) return;
  let cells: Cells = row.cells;
  const changed = new Set<string>();
  for (let pass = 0; pass <= computed.length; pass++) {
    let any = false;
    for (const f of computed) {
      const v = await computeValue(db, schema, f, cells, metaOf(row));
      if (!sameValue(cells[f.id], v)) {
        cells = withCell(cells, f.id, v);
        changed.add(f.id);
        any = true;
      }
    }
    if (!any) break;
  }
  if (changed.size === 0) return;
  await db.query(`UPDATE records SET cells=$2 WHERE id=$1`, [recordId, cells]);
  await propagate(db, schema, [{ recordId, tableId, fields: changed }]);
}

/** Names of people, by user id. */
export async function userNames(db: Db, ids: string[]): Promise<LinkLabels> {
  if (!ids.length) return {};
  const rows = await db.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::text[])`, [[...new Set(ids)]]);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** Filenames of attachments, by id. */
export async function attachmentNames(db: Db, ids: string[]): Promise<LinkLabels> {
  if (!ids.length) return {};
  const rows = await db.query<{ id: string; filename: string }>(`SELECT id, filename FROM attachments WHERE id = ANY($1::text[])`, [[...new Set(ids)]]);
  return Object.fromEntries(rows.map((r) => [r.id, r.filename]));
}

/** Record history: who changed which fields, from what to what. Calculated fields aren't logged. */
export async function logHistory(db: Db, recordId: string, userId: string | null, kind: "create" | "update" | "delete" | "restore", changes: Record<string, { from: CellValue; to: CellValue }>) {
  await db.query(`INSERT INTO record_history (record_id, user_id, kind, changes) VALUES ($1,$2,$3,$4)`, [recordId, userId, kind, changes]);
}

function diffOf(before: Cells, after: Cells, changed: Set<string>) {
  const out: Record<string, { from: CellValue; to: CellValue }> = {};
  for (const fid of changed) out[fid] = { from: before[fid] ?? null, to: after[fid] ?? null };
  return out;
}
