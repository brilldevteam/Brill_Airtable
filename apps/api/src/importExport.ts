import {
  cellToText,
  COMPUTED_TYPES,
  fieldOptionsSchema,
  isNumericField,
  newId,
  orderedFieldIds,
  viewConfigSchema,
  type CellValue,
  type Field,
} from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tableAccess, viewTableId } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { computeAllForRecord, Schema, writeCells } from "./links";
import { displayData, loadFields, prepareCells, toRecord } from "./routes";
import { buildViewQuery } from "./viewQuery";

/**
 * Bulk import (used by CSV import, and later by the Airtable migration tool) and CSV export.
 *
 * With `typecast: true`, loose values are converted like Airtable's API typecast option:
 *  - select options that don't exist yet are added to the field
 *  - linked records can be given by name; names with no match create a record in the linked table
 *  - "yes"/"✓"/"x" → checked, "₹1,200.50" → 1200.5, "31/12/2026" → a date (day-first by default)
 *  - calculated fields are ignored
 */

export const MAX_BATCH = 1000;
const COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];

type DateOrder = "dmy" | "mdy";

export function parseLooseDate(s: string, order: DateOrder): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}([T ].*)?$/.test(t)) {
    const d = new Date(t.length <= 10 ? t + "T00:00:00Z" : t);
    return Number.isNaN(d.getTime()) ? null : t.length <= 10 ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(t);
  if (m) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    const day = order === "dmy" ? a : b;
    const month = order === "dmy" ? b : a;
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (m[4]) {
      let h = Number(m[4]);
      if (m[7]?.toLowerCase() === "pm" && h < 12) h += 12;
      if (m[7]?.toLowerCase() === "am" && h === 12) h = 0;
      return new Date(year, month - 1, day, h, Number(m[5]), Number(m[6] ?? 0)).toISOString();
    }
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseLooseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v ?? "").trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d\-().]/g, ""));
  s = s.replace(/[^\d.eE]/g, "");
  const n = Number(s);
  if (!s || !Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "✓", "✔", "checked", "on"]);

/** Turn loose input values into values prepareCells accepts. Mutates field options (new choices) in the db. */
async function typecastCells(
  t: Db, tableId: string, fields: Field[], input: Record<string, unknown>, opts: { dateOrder: DateOrder; userId: string },
): Promise<Record<string, unknown>> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const f = byId.get(key) ?? byName.get(key.toLowerCase());
    if (!f) throw new HttpError(400, `Unknown field "${key}"`);
    if (COMPUTED_TYPES.has(f.type)) continue;
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
      out[f.id] = null;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : raw;
    switch (f.type) {
      case "number": {
        const n = parseLooseNumber(text);
        out[f.id] = n;
        break;
      }
      case "checkbox":
        out[f.id] = typeof text === "boolean" ? text : TRUE_WORDS.has(String(text).toLowerCase());
        break;
      case "date":
        out[f.id] = parseLooseDate(String(text), opts.dateOrder);
        break;
      case "singleSelect":
      case "multipleSelect": {
        const names = Array.isArray(text) ? text.map(String) : f.type === "multipleSelect" ? String(text).split(",") : [String(text)];
        const wanted = names.map((n) => n.trim()).filter(Boolean);
        const choices = [...(f.options.choices ?? [])];
        const ids = wanted.map((n) => {
          let c = choices.find((x) => x.name === n) ?? choices.find((x) => x.name.toLowerCase() === n.toLowerCase());
          if (!c) {
            c = { id: newId("sel"), name: n, color: COLORS[choices.length % COLORS.length] };
            choices.push(c);
          }
          return c.id;
        });
        if (choices.length !== (f.options.choices ?? []).length) {
          f.options = fieldOptionsSchema.parse({ ...f.options, choices });
          await t.query(`UPDATE fields SET options=$2 WHERE id=$1`, [f.id, f.options]);
        }
        out[f.id] = f.type === "singleSelect" ? ids[0] ?? null : ids;
        break;
      }
      case "link": {
        const parts = Array.isArray(text) ? text.map(String) : String(text).split(",");
        const linkedTable = f.options.linkedTableId!;
        const ids: string[] = [];
        for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
          if (/^rec[0-9A-Za-z]{14}$/.test(p)) { ids.push(p); continue; }
          ids.push(await findOrCreateByName(t, linkedTable, p, opts.userId));
        }
        out[f.id] = ids;
        break;
      }
      case "attachment":
        // Files can't come from text; the migration tool uploads them separately.
        break;
      default:
        out[f.id] = typeof text === "string" ? text : String(text);
    }
  }
  return out;
}

/** Find a record in a table by its primary field text (case-insensitive); create it if missing. */
async function findOrCreateByName(t: Db, tableId: string, name: string, userId: string): Promise<string> {
  const table = await t.one<{ primary_field_id: string }>(`SELECT primary_field_id FROM tables WHERE id=$1`, [tableId]);
  const pid = table!.primary_field_id;
  const hit = await t.one<{ id: string }>(
    `SELECT id FROM records WHERE table_id=$1 AND deleted_at IS NULL AND lower(cells->>$2) = lower($3) ORDER BY autonumber LIMIT 1`,
    [tableId, pid, name],
  );
  if (hit) return hit.id;
  const id = newId("rec");
  await t.query(`INSERT INTO records (id, table_id, cells, created_by, updated_by) VALUES ($1,$2,'{}',$3,$3)`, [id, tableId, userId]);
  const schema = new Schema(t);
  const cells = await prepareCells(t, tableId, { [pid]: name });
  await writeCells(t, schema, userId, tableId, id, cells, "create");
  await computeAllForRecord(t, schema, tableId, id);
  return id;
}

/** RFC 4180 CSV cell. Text that Excel would run as a formula gets a leading apostrophe. */
export function csvCell(s: string, guardFormula: boolean) {
  let v = s;
  // Phone numbers and plain numbers like "+91 98470 11111" or "-5" are safe and left alone.
  if (guardFormula && /^[=+\-@\t\r]/.test(v) && !/^[+-]?[\d\s().-]+$/.test(v)) v = "'" + v;
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function registerImportExport(app: FastifyInstance, db: Db) {
  /** Create many records at once. */
  app.post("/api/tables/:tableId/records/batch", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const body = z
      .object({
        records: z.array(z.object({ cells: z.record(z.unknown()) })).min(1).max(MAX_BATCH),
        typecast: z.boolean().default(false),
        dateOrder: z.enum(["dmy", "mdy"]).default("dmy"),
      })
      .parse(req.body);
    await tableAccess(db, user.id, tableId, "editor");

    const ids = await db.tx(async (t) => {
      const fields = await loadFields(t, tableId);
      const schema = new Schema(t);
      const created: string[] = [];
      for (const [i, r] of body.records.entries()) {
        try {
          const input = body.typecast
            ? await typecastCells(t, tableId, fields, r.cells, { dateOrder: body.dateOrder, userId: user.id })
            : r.cells;
          const cells = await prepareCells(t, tableId, input);
          const id = newId("rec");
          await t.query(`INSERT INTO records (id, table_id, cells, created_by, updated_by) VALUES ($1,$2,'{}',$3,$3)`, [id, tableId, user.id]);
          await writeCells(t, schema, user.id, tableId, id, cells, "create");
          await computeAllForRecord(t, schema, tableId, id);
          created.push(id);
        } catch (e) {
          // Report which row failed; the whole batch is rolled back.
          if (e instanceof HttpError) throw new HttpError(e.statusCode, `Row ${i + 1}: ${e.message}`);
          throw e;
        }
      }
      return created;
    });
    return { created: ids.length, ids };
  });

  /** Download a view as CSV: visible fields in view order, with the view's filters and sorts. */
  app.get("/api/views/:viewId/export.csv", async (req, reply) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    const tableId = await viewTableId(db, viewId);
    await tableAccess(db, user.id, tableId, "read");
    const viewRow = await db.one(`SELECT * FROM views WHERE id=$1`, [viewId]);
    const table = await db.one<{ name: string; primary_field_id: string }>(`SELECT name, primary_field_id FROM tables WHERE id=$1`, [tableId]);
    const config = viewConfigSchema.parse(viewRow.config ?? {});
    const all = await loadFields(db, tableId);
    const hidden = new Set(config.hiddenFieldIds);
    const fields = orderedFieldIds(config, all.map((f) => f.id), table!.primary_field_id)
      .filter((id) => id === table!.primary_field_id || !hidden.has(id))
      .map((id) => all.find((f) => f.id === id)!)
      .filter(Boolean);

    const { sql, params } = buildViewQuery(tableId, all, config);
    const records = (await db.query(sql, params)).map(toRecord);
    const { labels, files } = await displayData(db, all, records);
    const origin = `${req.protocol}://${req.headers.host ?? "localhost"}`;

    const lines = [fields.map((f) => csvCell(f.name, true)).join(",")];
    for (const r of records) {
      lines.push(
        fields
          .map((f) => {
            const v: CellValue = r.cells[f.id] ?? null;
            let text: string;
            if (f.type === "attachment") {
              text = ((v as string[]) ?? []).map((id) => (files[id] ? `${files[id].filename} (${origin}${files[id].url})` : "")).join(", ");
            } else if (f.type === "checkbox" || (f.type === "formula" && f.options.resultType === "boolean")) {
              text = v ? "checked" : "";
            } else if (isNumericField(f) && typeof v === "number") {
              text = String(v);
            } else {
              text = cellToText(f, v, labels);
            }
            return csvCell(text, !isNumericField(f));
          })
          .join(","),
      );
    }
    const filename = `${table!.name} - ${viewRow.name}.csv`.replace(/[\\/:*?"<>|]/g, "_");
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header("Cache-Control", "no-store");
    // BOM so Excel opens UTF-8 (₹, names in other scripts) correctly.
    return reply.send("﻿" + lines.join("\r\n") + "\r\n");
  });
}

