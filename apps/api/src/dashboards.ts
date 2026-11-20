import {
  cellToText, defaultViewConfig, effectiveType, formatDateCell, formatNumber, groupKey, newId, viewConfigSchema, widgetSchema,
  type CellValue, type Dashboard, type Field, type Metric, type RecordRow, type Widget, type WidgetData,
} from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { displayData, loadFields, toRecord } from "./routes";
import { buildViewQuery } from "./viewQuery";

/**
 * Dashboards: pages of widgets (numbers, charts, record lists, notes) over a base's tables.
 * Widget data is worked out here from the records each widget's view shows, so the browser only
 * gets totals and the few records a list displays.
 */

interface Row { id: string; base_id: string; name: string; widgets: unknown; position: number; updated_at: string }
const toDashboard = (r: Row): Dashboard => ({
  id: r.id, baseId: r.base_id, name: r.name, position: r.position,
  widgets: z.array(widgetSchema).parse(r.widgets ?? []),
  updatedAt: new Date(r.updated_at).toISOString(),
});
type Recs = { fields: Field[]; records: RecordRow[] };
const MAX_DATE_BUCKETS = 60;

/** A number in the way the field shows numbers (₹, %, h:mm…). */
function show(field: Field | undefined, n: number | null): string {
  if (n === null) return "—";
  if (!field) return formatNumber(Math.round(n * 100) / 100);
  if (["currency", "percent", "duration"].includes(field.type)) return cellToText(field, n);
  return formatNumber(Math.round(n * 100) / 100, field.options.precision);
}

function measure(metric: Metric, records: RecordRow[], fields: Field[]): { value: number | null; field?: Field } {
  if (metric.kind === "count" || !metric.fieldId) return { value: records.length };
  const f = fields.find((x) => x.id === metric.fieldId);
  if (!f) throw new Error("The field this widget adds up was deleted");
  // Empty cells don't count (an average ignores them, like Airtable).
  const vals = records
    .map((r) => r.cells[f.id])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));
  switch (metric.kind) {
    case "sum": return { value: vals.reduce((a, b) => a + b, 0), field: f };
    case "avg": return { value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, field: f };
    case "min": return { value: vals.length ? Math.min(...vals) : null, field: f };
    case "max": return { value: vals.length ? Math.max(...vals) : null, field: f };
  }
  return { value: null };
}

/** The date period a value falls in: [sortable key, label]. */
function bucket(iso: string, size: "day" | "week" | "month"): [string, string] {
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return ["", "(Empty)"];
  if (size === "month") {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return [key, d.toLocaleDateString(undefined, { month: "short", year: "numeric" })];
  }
  if (size === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return [key, (size === "week" ? "Week of " : "") + formatDateCell(key)];
}

/** The period after a bucket key ("2026-01" → "2026-02", or a day / week start + 1 day / 7 days). */
function nextPeriod(key: string, size: "day" | "week" | "month"): string {
  if (size === "month") {
    const [y, m] = key.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + (size === "week" ? 7 : 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The groups a record belongs to for a chart (several for multi-value fields). */
function groupsOf(f: Field, v: CellValue, labels: Record<string, string>, dateBucket: "day" | "week" | "month"): { key: string; label: string; color: string | null }[] {
  const empty = [{ key: "", label: "(Empty)", color: null }];
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
    return effectiveType(f) === "checkbox" ? [{ key: "0", label: "Unchecked", color: null }] : empty;
  }
  const choice = (id: string) => f.options.choices?.find((c) => c.id === id);
  switch (effectiveType(f)) {
    case "singleSelect": {
      const c = choice(String(v));
      return [{ key: String(v), label: c?.name ?? "(Deleted option)", color: c?.color ?? null }];
    }
    case "multipleSelect":
      return (v as string[]).map((id) => ({ key: id, label: choice(id)?.name ?? "(Deleted option)", color: choice(id)?.color ?? null }));
    case "date": {
      const [key, label] = bucket(String(v), dateBucket);
      return [{ key, label, color: null }];
    }
    case "checkbox":
      return [{ key: "1", label: "Checked", color: null }];
  }
  if (Array.isArray(v)) {
    return v.map((x) => {
      const label = f.type === "lookup" ? String(x) : labels[String(x)] ?? String(x);
      return { key: f.type === "lookup" ? label.toLowerCase() : String(x), label, color: null };
    });
  }
  const [key, label] = groupKey(f, v, labels);
  return [{ key, label, color: null }];
}

async function compute(db: Db, w: Widget, load: (tableId: string, viewId: string | null) => Promise<Recs>): Promise<WidgetData> {
  if (w.type === "text") return { type: "text" };
  const { fields, records } = await load(w.tableId, w.viewId);
  if (w.type === "number") {
    const m = measure(w.metric, records, fields);
    return { type: "number", value: m.value, display: show(m.field, m.value), records: records.length };
  }
  if (w.type === "list") {
    const shown = records.slice(0, w.limit);
    const ids = w.fieldIds.length ? w.fieldIds : fields.slice(0, 4).map((f) => f.id);
    const used = ids.map((id) => fields.find((f) => f.id === id)).filter((f): f is Field => !!f);
    const { labels } = await displayData(db, used, shown);
    return {
      type: "list",
      fields: used.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options as Record<string, unknown> })),
      records: shown.map((r) => ({ id: r.id, cells: Object.fromEntries(used.map((f) => [f.id, r.cells[f.id] ?? null])) })),
      labels,
      more: Math.max(0, records.length - shown.length),
    };
  }
  // chart
  const gf = fields.find((f) => f.id === w.groupFieldId);
  if (!gf) throw new Error("Choose a field to group by");
  const { labels } = await displayData(db, [gf], records);
  const groups = new Map<string, { key: string; label: string; color: string | null; recs: RecordRow[] }>();
  for (const r of records) {
    for (const g of groupsOf(gf, r.cells[gf.id] ?? null, labels, w.dateBucket)) {
      const cur = groups.get(g.key) ?? { ...g, recs: [] };
      cur.recs.push(r);
      groups.set(g.key, cur);
    }
  }
  const metricField = w.metric.kind === "count" ? undefined : fields.find((f) => f.id === w.metric.fieldId);
  let list = [...groups.values()].map((g) => ({ ...g, value: measure(w.metric, g.recs, fields).value ?? 0 }));
  const t = effectiveType(gf);
  const isDate = t === "date";
  if (isDate) {
    // Time runs left to right; empty dates go last.
    list.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.key.localeCompare(b.key)));
    // Periods with nothing in them still get a (zero) bar, so the timeline isn't misleading.
    const dated = list.filter((g) => g.key !== "");
    if (dated.length > 1) {
      const have = new Map(dated.map((g) => [g.key, g]));
      const filled: typeof list = [];
      for (let key = dated[0].key, n = 0; key <= dated[dated.length - 1].key && n < 400; key = nextPeriod(key, w.dateBucket), n++) {
        filled.push(have.get(key) ?? { key, label: bucket(key.length === 7 ? key + "-01" : key, w.dateBucket)[1], color: null, recs: [], value: 0 });
      }
      list = [...filled, ...list.filter((g) => g.key === "")];
    }
    list = list.slice(-MAX_DATE_BUCKETS);
  } else if (t === "singleSelect") {
    const order = (gf.options.choices ?? []).map((c) => c.id);
    list.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : order.indexOf(a.key) - order.indexOf(b.key)));
  } else {
    list.sort((a, b) => b.value - a.value);
  }
  if (!isDate && list.length > w.limit) {
    // Keep the biggest groups; add the rest up as "Other".
    const byValue = [...list].sort((a, b) => b.value - a.value);
    const keep = new Set(byValue.slice(0, w.limit - 1).map((g) => g.key));
    const rest = list.filter((g) => !keep.has(g.key));
    const restRecs = [...new Set(rest.flatMap((g) => g.recs))];
    list = list.filter((g) => keep.has(g.key));
    list.push({ key: "__other", label: `Other (${rest.length})`, color: null, recs: restRecs, value: measure(w.metric, restRecs, fields).value ?? 0 });
  }
  const total = measure(w.metric, records, fields).value ?? 0;
  return {
    type: "chart",
    groups: list.map((g) => ({ key: g.key, label: g.label, color: g.color, value: g.value, display: show(metricField, g.value) })),
    total,
    totalDisplay: show(metricField, total),
    valueLabel: w.metric.kind === "count" ? "Records" : `${w.metric.kind === "avg" ? "Average" : w.metric.kind[0].toUpperCase() + w.metric.kind.slice(1)} of ${metricField?.name ?? "?"}`,
  };
}

export function registerDashboards(app: FastifyInstance, db: Db) {
  async function dashboardFor(userId: string, id: string, min: "read" | "creator") {
    const row = await db.one<Row>(`SELECT * FROM dashboards WHERE id=$1`, [id]);
    if (!row) throw new HttpError(404, "Not found");
    await baseAccess(db, userId, row.base_id, min);
    return row;
  }
  /** Widgets may only read tables and views of the dashboard's base. */
  async function validate(baseId: string, widgets: Widget[]) {
    const tables = new Set((await db.query<{ id: string }>(`SELECT id FROM tables WHERE base_id=$1`, [baseId])).map((r) => r.id));
    for (const w of widgets) {
      if (w.type === "text") continue;
      if (!tables.has(w.tableId)) throw new HttpError(400, `“${w.title || "Widget"}”: choose a table in this base`);
      if (w.viewId && !(await db.one(`SELECT 1 FROM views WHERE id=$1 AND table_id=$2`, [w.viewId, w.tableId]))) {
        throw new HttpError(400, `“${w.title || "Widget"}”: that view isn't in the chosen table`);
      }
    }
  }

  app.get("/api/bases/:baseId/dashboards", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "read");
    const rows = await db.query<Row>(`SELECT * FROM dashboards WHERE base_id=$1 ORDER BY position, created_at`, [baseId]);
    return { dashboards: rows.map(toDashboard) };
  });

  app.post("/api/bases/:baseId/dashboards", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "creator");
    const body = z.object({ name: z.string().trim().min(1).max(120), widgets: z.array(widgetSchema).max(40).default([]) }).parse(req.body);
    await validate(baseId, body.widgets);
    const pos = await db.one<{ n: number }>(`SELECT COALESCE(MAX(position)+1,0)::int AS n FROM dashboards WHERE base_id=$1`, [baseId]);
    const row = await db.one<Row>(
      `INSERT INTO dashboards (id, base_id, name, widgets, position, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId("dsh"), baseId, body.name, JSON.stringify(body.widgets), pos!.n, user.id],
    );
    return { dashboard: toDashboard(row!) };
  });

  app.patch("/api/dashboards/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const cur = await dashboardFor(user.id, id, "creator");
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), widgets: z.array(widgetSchema).max(40).optional() }).parse(req.body);
    if (body.widgets) await validate(cur.base_id, body.widgets);
    const row = await db.one<Row>(
      `UPDATE dashboards SET name=COALESCE($2,name), widgets=COALESCE($3,widgets), updated_at=now() WHERE id=$1 RETURNING *`,
      [id, body.name ?? null, body.widgets ? JSON.stringify(body.widgets) : null],
    );
    return { dashboard: toDashboard(row!) };
  });

  app.delete("/api/dashboards/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await dashboardFor(user.id, id, "creator");
    await db.query(`DELETE FROM dashboards WHERE id=$1`, [id]);
    return { ok: true };
  });

  /** Every widget's numbers. A widget that can't be worked out reports why, without failing the rest. */
  app.get("/api/dashboards/:id/data", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const d = toDashboard(await dashboardFor(user.id, id, "read"));
    const cache = new Map<string, Promise<Recs>>();
    const load = (tableId: string, viewId: string | null) => {
      const key = tableId + "|" + (viewId ?? "");
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const fields = await loadFields(db, tableId);
          const v = viewId ? await db.one<{ config: unknown }>(`SELECT config FROM views WHERE id=$1 AND table_id=$2`, [viewId, tableId]) : null;
          if (viewId && !v) throw new Error("The view this widget uses was deleted");
          const config = v ? viewConfigSchema.parse(v.config ?? {}) : defaultViewConfig();
          const { sql, params } = buildViewQuery(tableId, fields, config);
          return { fields, records: (await db.query(sql, params)).map(toRecord) };
        })());
      }
      return cache.get(key)!;
    };
    const data: Record<string, WidgetData> = {};
    for (const w of d.widgets) {
      try {
        data[w.id] = await compute(db, w, load);
      } catch (e) {
        data[w.id] = { type: "error", message: (e as Error).message };
      }
    }
    return { data };
  });
}
