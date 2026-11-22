import {
  CellValidationError,
  cellToText,
  compileFormula,
  FormulaError,
  COMPUTED_TYPES,
  convertCell,
  FIELD_TYPES,
  fieldOptionsSchema,
  newId,
  normalizeCell,
  ROLLUP_AGGREGATIONS,
  STRUCTURAL_TYPES,
  type CellValue,
  type Field,
  type FieldOptions,
  formulaToDisplay,
  type FieldType,
  type RecordRow,
  type Table,
  type View,
  defaultViewConfig,
  VIEW_TYPES,
  viewConfigSchema,
  isDateLike,
  FORM_FIELD_TYPES,
  DURATION_FORMATS,
  USER_TYPES,
} from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseAccess, fieldTableId, recordTableId, tableAccess, viewTableId, workspaceAccess, checkFieldEdits, checkRecordAccess, EDIT_ACCESS, type EditAccess } from "./access";
import { buildViewQuery } from "./viewQuery";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { assertAttachments, attachmentInfos } from "./files";
import {
  assertLinkTargets, computeAllForRecord, dependentFieldNames, labelsFor, logHistory, recomputeField, Schema, unlinkRecord, userNames, writeCells,
} from "./links";

// ---------- row mappers ----------
export const toField = (r: any): Field => ({
  id: r.id, tableId: r.table_id, name: r.name, type: r.type, options: r.options ?? {}, position: r.position,
});
const toTable = (r: any): Table => ({
  id: r.id, baseId: r.base_id, name: r.name, primaryFieldId: r.primary_field_id, position: r.position,
  recordAccess: r.record_access ?? "all",
});
const toView = (r: any): View => ({
  id: r.id, tableId: r.table_id, name: r.name, type: r.type, position: r.position,
  // Parse through the schema so older saved configs pick up new defaults.
  config: viewConfigSchema.parse(r.config ?? {}),
});
export const toRecord = (r: any): RecordRow => ({
  id: r.id, cells: r.cells ?? {}, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

// ---------- input schemas ----------
const nameSchema = z.string().trim().min(1).max(255);
const choiceInput = z.object({ id: z.string().optional(), name: z.string().trim().min(1), color: z.string().optional() });
const fieldOptionsInput = z
  .object({
    precision: z.number().int().min(0).max(8).optional(),
    defaultChoice: z.string().nullable().optional(),
    notify: z.boolean().optional(),
    includeTime: z.boolean().optional(),
    dateFormat: z.enum(["local", "friendly", "us", "european", "iso"]).optional(),
    timeFormat: z.enum(["12", "24"]).optional(),
    choices: z.array(choiceInput).optional(),
    linkedTableId: z.string().optional(),
    linkFieldId: z.string().optional(),
    targetFieldId: z.string().optional(),
    aggregation: z.enum(ROLLUP_AGGREGATIONS).optional(),
    /** formula: as typed, with {Field Name} references. */
    formula: z.string().max(5000).optional(),
    symbol: z.string().max(5).optional(),
    max: z.number().int().min(1).max(10).optional(),
    durationFormat: z.enum(DURATION_FORMATS).optional(),
    multiple: z.boolean().optional(),
  })
  .optional();
const COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];

function buildOptions(type: FieldType, input: z.infer<typeof fieldOptionsInput>) {
  const o = input ?? {};
  const opts: Record<string, unknown> = {};
  if (type === "number") opts.precision = o.precision ?? 0;
  if (type === "currency") {
    opts.precision = o.precision ?? 2;
    opts.symbol = (o.symbol ?? "₹").trim().slice(0, 5) || "₹";
  }
  if (type === "percent") opts.precision = o.precision ?? 0;
  if (type === "rating") opts.max = Math.min(10, Math.max(1, o.max ?? 5));
  if (type === "duration") opts.durationFormat = o.durationFormat ?? "h:mm";
  if (type === "user") opts.multiple = o.multiple ?? false;
  if (type === "user" && o.notify) opts.notify = true;
  if (type === "date") opts.includeTime = o.includeTime ?? false;
  if (type === "date" || type === "createdTime" || type === "lastModifiedTime") {
    if (o.dateFormat) opts.dateFormat = o.dateFormat;
    if (o.timeFormat) opts.timeFormat = o.timeFormat;
  }
  if (type === "singleSelect" || type === "multipleSelect") {
    const seen = new Set<string>();
    opts.choices = (o.choices ?? []).filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c, i) => ({
      id: c.id ?? newId("sel"),
      name: c.name,
      color: c.color ?? COLORS[i % COLORS.length],
    }));
    const choices = opts.choices as { id: string; name: string }[];
    const d = o.defaultChoice === undefined ? (o as FieldOptions).defaultChoiceId : o.defaultChoice;
    const hit = d ? choices.find((c) => c.name === d || c.id === d) : undefined;
    if (hit) opts.defaultChoiceId = hit.id;
  }
  if (type === "link") {
    opts.linkedTableId = o.linkedTableId;
    if ("inverseFieldId" in o) opts.inverseFieldId = (o as FieldOptions).inverseFieldId;
  }
  if (type === "lookup" || type === "rollup" || type === "count") opts.linkFieldId = o.linkFieldId;
  if (type === "lookup" || type === "rollup") opts.targetFieldId = o.targetFieldId;
  if (type === "rollup") {
    opts.aggregation = o.aggregation ?? "sum";
    if (o.precision !== undefined) opts.precision = o.precision;
  }
  if (type === "formula") {
    opts.formula = o.formula ?? "";
    if (o.precision !== undefined) opts.precision = o.precision;
  }
  return fieldOptionsSchema.parse(opts);
}

/** Validate input cells, including that linked records and attachments exist. */
/** Cells prepareCells filled in from defaults (not typed by the person) — field locks don't apply to them. */
const DEFAULTED = new WeakMap<object, Set<string>>();
export const givenKeys = (cells: Record<string, unknown>) => Object.keys(cells).filter((k) => !DEFAULTED.get(cells)?.has(k));

export async function prepareCells(t: Db, tableId: string, input: Record<string, unknown>, opts: { create?: boolean } = {}) {
  const fields = await loadFields(t, tableId);
  const cells = normalizeCells(fields, input);
  if (opts.create) {
    // New records start with each select field's default option (unless given a value).
    for (const f of fields) {
      const d = f.options.defaultChoiceId;
      if (d && !(f.id in cells) && f.options.choices?.some((c) => c.id === d)) {
        cells[f.id] = f.type === "multipleSelect" ? [d] : d;
        if (!DEFAULTED.has(cells)) DEFAULTED.set(cells, new Set());
        DEFAULTED.get(cells)!.add(f.id);
      }
    }
  }
  for (const [fid, v] of Object.entries(cells)) {
    const f = fields.find((x) => x.id === fid)!;
    if (f.type === "link" && Array.isArray(v)) await assertLinkTargets(t, f, v);
    if (f.type === "attachment" && Array.isArray(v)) await assertAttachments(t, tableId, f.name, v);
    if (f.type === "user" && Array.isArray(v)) await assertCollaborators(t, tableId, f.name, v);
  }
  return cells;
}

/** Cells may be keyed by field id or name; give the ids. */
async function fieldIdsOf(db: Db, tableId: string, keys: string[]): Promise<string[]> {
  const fields = await loadFields(db, tableId);
  return keys.map((k) => fields.find((f) => f.id === k || f.name === k)?.id).filter((x): x is string => !!x);
}

export async function loadFields(db: Db, tableId: string): Promise<Field[]> {
  return (await db.query(`SELECT * FROM fields WHERE table_id = $1 ORDER BY position, id`, [tableId])).map(toField);
}

/** Validate a partial cells object against the table's fields. Unknown field ids are rejected. */
export function normalizeCells(fields: Field[], input: Record<string, unknown>): Record<string, CellValue> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, CellValue> = {};
  for (const [key, raw] of Object.entries(input)) {
    const field = byId.get(key) ?? byName.get(key);
    if (!field) throw new HttpError(400, `Unknown field "${key}"`);
    try {
      out[field.id] = normalizeCell(field, raw);
    } catch (e) {
      if (e instanceof CellValidationError) throw new HttpError(422, e.message);
      throw e;
    }
  }
  return out;
}

function mergeCells(current: Record<string, CellValue>, patch: Record<string, CellValue>) {
  const next = { ...current, ...patch };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  return next;
}

async function createTable(db: Db, baseId: string, name: string, userId: string): Promise<Table> {
  const pos = await db.one<{ n: number }>(`SELECT COALESCE(MAX(position)+1,0)::int AS n FROM tables WHERE base_id=$1`, [baseId]);
  const tableId = newId("tbl");
  const nameFieldId = newId("fld");
  await db.query(`INSERT INTO tables (id, base_id, name, primary_field_id, position) VALUES ($1,$2,$3,$4,$5)`, [
    tableId, baseId, name, nameFieldId, pos!.n,
  ]);
  const defaults: [string, string, FieldType, object][] = [
    [nameFieldId, "Name", "singleLineText", {}],
    [newId("fld"), "Notes", "longText", {}],
    [newId("fld"), "Status", "singleSelect", buildOptions("singleSelect", { choices: [{ name: "Todo" }, { name: "In progress" }, { name: "Done" }] })],
  ];
  for (const [i, [id, fname, type, options]] of defaults.entries()) {
    await db.query(`INSERT INTO fields (id, table_id, name, type, options, position) VALUES ($1,$2,$3,$4,$5,$6)`, [
      id, tableId, fname, type, options, i,
    ]);
  }
  for (let i = 0; i < 3; i++) {
    await db.query(`INSERT INTO records (id, table_id, cells, created_by, updated_by) VALUES ($1,$2,'{}',$3,$3)`, [
      newId("rec"), tableId, userId,
    ]);
  }
  await db.query(`INSERT INTO views (id, table_id, name, type, config, position) VALUES ($1,$2,'Grid view','grid',$3,0)`, [
    newId("viw"), tableId, defaultViewConfig(),
  ]);
  return toTable(await db.one(`SELECT * FROM tables WHERE id=$1`, [tableId]));
}

async function loadViews(db: Db, tableId: string): Promise<View[]> {
  let rows = await db.query(`SELECT * FROM views WHERE table_id=$1 ORDER BY position, id`, [tableId]);
  if (rows.length === 0) {
    // Tables created before views existed get a default grid view.
    await db.query(`INSERT INTO views (id, table_id, name, type, config, position) VALUES ($1,$2,'Grid view','grid',$3,0)`, [
      newId("viw"), tableId, defaultViewConfig(),
    ]);
    rows = await db.query(`SELECT * FROM views WHERE table_id=$1 ORDER BY position, id`, [tableId]);
  }
  return rows.map(toView);
}

/** Store (or keep) who may edit a field's values; it lives in the field's options. */
async function setEditAccess(db: Db, field: Field, rule: EditAccess | undefined): Promise<Field> {
  if (!rule || (field.options.editAccess ?? "all") === rule) return field;
  return toField(await db.one(
    `UPDATE fields SET options = options || jsonb_build_object('editAccess', $2::text) WHERE id=$1 RETURNING *`, [field.id, rule],
  ));
}

export function registerRoutes(app: FastifyInstance, db: Db) {
  // ================= Workspaces & bases =================
  app.get("/api/workspaces", async (req) => {
    const user = requireUser(req);
    const workspaces = await db.query(
      `SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at`,
      [user.id],
    );
    const bases = await db.query(
      `SELECT b.id, b.workspace_id AS "workspaceId", b.name, b.color, b.icon, b.logo, COALESCE(p.starred, false) AS starred, p.last_opened_at AS "lastOpenedAt" FROM bases b
       JOIN workspace_members m ON m.workspace_id = b.workspace_id
       LEFT JOIN base_prefs p ON p.base_id = b.id AND p.user_id = $1
       WHERE m.user_id = $1 ORDER BY b.created_at`,
      [user.id],
    );
    // Bases someone shared with this user directly (e.g. a client), outside their own workspaces.
    const sharedBases = await db.query(
      `SELECT b.id, b.workspace_id AS "workspaceId", b.name, b.color, b.icon, b.logo, COALESCE(p.starred, false) AS starred, p.last_opened_at AS "lastOpenedAt", bm.role, w.name AS "workspaceName"
       FROM base_members bm JOIN bases b ON b.id = bm.base_id JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN base_prefs p ON p.base_id = b.id AND p.user_id = $1
       WHERE bm.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = b.workspace_id AND m.user_id = $1)
       ORDER BY bm.created_at`,
      [user.id],
    );
    return { workspaces, bases, sharedBases };
  });

  app.post("/api/workspaces/:wsId/bases", async (req) => {
    const user = requireUser(req);
    const { wsId } = req.params as { wsId: string };
    const body = z.object({ name: nameSchema, color: z.string().optional() }).parse(req.body);
    await workspaceAccess(db, user.id, wsId, "creator");
    const baseId = newId("bse");
    const table = await db.tx(async (t) => {
      await t.query(`INSERT INTO bases (id, workspace_id, name, color) VALUES ($1,$2,$3,$4)`, [
        baseId, wsId, body.name, body.color ?? "blue",
      ]);
      return createTable(t, baseId, "Table 1", user.id);
    });
    return { base: { id: baseId, workspaceId: wsId, name: body.name, color: body.color ?? "blue" }, firstTableId: table.id };
  });

  app.patch("/api/bases/:baseId", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const body = z.object({
      name: nameSchema.optional(),
      color: z.string().max(20).optional(),
      icon: z.string().regex(/^[a-z-]{1,30}$/).nullable().optional(),
    }).parse(req.body);
    await baseAccess(db, user.id, baseId, "creator");
    await db.query(`UPDATE bases SET name = COALESCE($2,name), color = COALESCE($3,color), icon = CASE WHEN $4 THEN $5 ELSE icon END WHERE id=$1`, [
      baseId, body.name ?? null, body.color ?? null, body.icon !== undefined, body.icon ?? null,
    ]);
    return { ok: true };
  });

  app.post("/api/bases/:baseId/move", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const { workspaceId } = z.object({ workspaceId: z.string() }).parse(req.body);
    await baseAccess(db, user.id, baseId, "owner");
    await workspaceAccess(db, user.id, workspaceId, "creator");
    await db.query(`UPDATE bases SET workspace_id=$2 WHERE id=$1`, [baseId, workspaceId]);
    return { ok: true };
  });

  /** Remember that this person opened the base (for "Recently opened" on the home page). */
  app.post("/api/bases/:baseId/opened", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "read");
    await db.query(
      `INSERT INTO base_prefs (user_id, base_id, last_opened_at) VALUES ($1,$2,now())
       ON CONFLICT (user_id, base_id) DO UPDATE SET last_opened_at = now()`,
      [user.id, baseId],
    );
    return { ok: true };
  });

  /** Star or unstar a base, just for this person. */
  app.put("/api/bases/:baseId/star", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const { starred } = z.object({ starred: z.boolean() }).parse(req.body);
    await baseAccess(db, user.id, baseId, "read");
    await db.query(
      `INSERT INTO base_prefs (user_id, base_id, starred) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, base_id) DO UPDATE SET starred = $3`,
      [user.id, baseId, starred],
    );
    return { ok: true };
  });

  app.delete("/api/bases/:baseId", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "owner");
    await db.query(`DELETE FROM bases WHERE id=$1`, [baseId]);
    return { ok: true };
  });

  // ================= Tables =================
  app.get("/api/bases/:baseId", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const access = await baseAccess(db, user.id, baseId, "read");
    const base = await db.one(`SELECT id, workspace_id AS "workspaceId", name, color FROM bases WHERE id=$1`, [baseId]);
    const tables = (await db.query(`SELECT * FROM tables WHERE base_id=$1 ORDER BY position, id`, [baseId])).map(toTable);
    // The client uses the role to hide controls the user isn't allowed to use (the server still checks).
    // "guest" = invited to this base only (e.g. a client), not a member of the workspace.
    return { base, tables, role: access.role, guest: access.guest };
  });

  app.post("/api/bases/:baseId/tables", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    const body = z.object({ name: nameSchema }).parse(req.body);
    await baseAccess(db, user.id, baseId, "creator");
    const table = await db.tx((t) => createTable(t, baseId, body.name, user.id));
    return { table };
  });

  app.patch("/api/tables/:tableId", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const body = z.object({ name: nameSchema.optional(), recordAccess: z.enum(EDIT_ACCESS).optional() }).parse(req.body);
    await tableAccess(db, user.id, tableId, "creator");
    await db.query(`UPDATE tables SET name=COALESCE($2,name), record_access=COALESCE($3,record_access) WHERE id=$1`, [
      tableId, body.name ?? null, body.recordAccess ?? null,
    ]);
    return { ok: true };
  });

  app.delete("/api/tables/:tableId", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    await tableAccess(db, user.id, tableId, "creator");
    const t = await db.one<{ base_id: string }>(`SELECT base_id FROM tables WHERE id=$1`, [tableId]);
    const count = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tables WHERE base_id=$1`, [t!.base_id]);
    if (count!.n <= 1) throw new HttpError(400, "A base needs at least one table");
    await db.query(`DELETE FROM tables WHERE id=$1`, [tableId]);
    return { ok: true };
  });

  /** Table schema: table, fields and views. Records are loaded per view. */
  app.get("/api/tables/:tableId", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    await tableAccess(db, user.id, tableId, "read");
    const table = toTable(await db.one(`SELECT * FROM tables WHERE id=$1`, [tableId]));
    const fields = await loadFields(db, tableId);
    const views = await loadViews(db, tableId);
    return { table, fields, views };
  });

  // ================= Views =================
  /** Records for a view, filtered and sorted on the server. Paging comes with large tables. */
  app.get("/api/views/:viewId/records", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    const tableId = await viewTableId(db, viewId);
    await tableAccess(db, user.id, tableId, "read");
    const view = toView(await db.one(`SELECT * FROM views WHERE id=$1`, [viewId]));
    let fields = await loadFields(db, tableId);
    // Formulas using TODAY()/NOW() are stored values, so refresh them once per day.
    const today = new Date().toISOString().slice(0, 10);
    const stale = fields.filter((f) => f.type === "formula" && f.options.volatile && f.options.computedOn !== today);
    if (stale.length) {
      await db.tx(async (t) => {
        for (const f of stale) {
          const updated = toField(
            await t.one(`UPDATE fields SET options = options || $2 WHERE id=$1 RETURNING *`, [f.id, { computedOn: today }]),
          );
          await recomputeField(t, new Schema(t), updated);
        }
      });
      fields = await loadFields(db, tableId);
    }
    const { sql, params } = buildViewQuery(tableId, fields, view.config);
    const records = (await db.query(sql, params)).map(toRecord);
    return { records, ...(await displayData(db, fields, records)) };
  });

  app.post("/api/tables/:tableId/views", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const body = z
      .object({ name: nameSchema, type: z.enum(VIEW_TYPES).default("grid"), copyFromViewId: z.string().optional() })
      .parse(req.body);
    await tableAccess(db, user.id, tableId, "editor");
    let config = defaultViewConfig();
    if (body.copyFromViewId) {
      const src = await db.one(`SELECT * FROM views WHERE id=$1 AND table_id=$2`, [body.copyFromViewId, tableId]);
      if (src) config = toView(src).config;
    }
    // Sensible defaults for each view type, taken from the table's fields.
    const tableFields = await loadFields(db, tableId);
    if (body.type === "kanban" && !config.stackFieldId) {
      config = { ...config, stackFieldId: tableFields.find((f) => f.type === "singleSelect")?.id ?? null };
    }
    if (body.type === "calendar" && !config.dateFieldId) {
      config = {
        ...config,
        dateFieldId: (tableFields.find((f) => f.type === "date") ?? tableFields.find((f) => isDateLike(f)))?.id ?? null,
        colorFieldId: config.colorFieldId ?? tableFields.find((f) => f.type === "singleSelect")?.id ?? null,
      };
    }
    if (body.type === "form" && config.form.fields.length === 0) {
      const table = await db.one<{ name: string; primary_field_id: string }>(`SELECT name, primary_field_id FROM tables WHERE id=$1`, [tableId]);
      const usable = tableFields.filter((f) => FORM_FIELD_TYPES.has(f.type));
      usable.sort((a, b) => (a.id === table!.primary_field_id ? -1 : b.id === table!.primary_field_id ? 1 : 0));
      config = {
        ...config,
        form: {
          ...config.form,
          title: config.form.title || table!.name,
          fields: usable.map((f) => ({ fieldId: f.id, required: f.id === table!.primary_field_id, label: "", help: "" })),
        },
      };
    }
    if (body.type === "gallery" && !config.coverFieldId) {
      config = { ...config, coverFieldId: tableFields.find((f) => f.type === "attachment")?.id ?? null };
    }
    const pos = await db.one<{ n: number }>(`SELECT COALESCE(MAX(position)+1,0)::int AS n FROM views WHERE table_id=$1`, [tableId]);
    const row = await db.one(
      `INSERT INTO views (id, table_id, name, type, config, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId("viw"), tableId, body.name, body.type, config, pos!.n],
    );
    return { view: toView(row) };
  });

  app.patch("/api/views/:viewId", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    const body = z.object({ name: nameSchema.optional(), config: viewConfigSchema.optional() }).parse(req.body);
    const tableId = await viewTableId(db, viewId);
    // Views are collaborative, as in Airtable: editors may change filters and sorts.
    await tableAccess(db, user.id, tableId, "editor");
    const row = await db.one(
      `UPDATE views SET name = COALESCE($2, name), config = COALESCE($3, config) WHERE id=$1 RETURNING *`,
      [viewId, body.name ?? null, body.config ?? null],
    );
    return { view: toView(row) };
  });

  app.delete("/api/views/:viewId", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    const tableId = await viewTableId(db, viewId);
    await tableAccess(db, user.id, tableId, "editor");
    const n = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM views WHERE table_id=$1`, [tableId]);
    if (n!.n <= 1) throw new HttpError(400, "A table needs at least one view");
    await db.query(`DELETE FROM views WHERE id=$1`, [viewId]);
    return { ok: true };
  });

  // ================= Fields =================
  /**
   * Turn a formula as typed into stored options: {fldId} references, result type, dependencies.
   * Rejects unknown fields/functions and circular references between formulas.
   */
  async function formulaOptions(t: Db, tableId: string, text: string, precision: number | undefined, selfId?: string): Promise<FieldOptions> {
    const fields = await loadFields(t, tableId);
    let compiled;
    try {
      compiled = compileFormula(text, fields, selfId);
    } catch (e) {
      if (e instanceof FormulaError) throw new HttpError(400, `Formula error: ${e.message}`);
      throw e;
    }
    if (selfId) {
      // Would this create a loop (A uses B, B uses A)?
      const byId = new Map(fields.map((f) => [f.id, f]));
      const seen = new Set<string>();
      const stack = [...compiled.dependsOn];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === selfId) throw new HttpError(400, "Formula error: this would create a loop between formulas");
        if (seen.has(id)) continue;
        seen.add(id);
        const f = byId.get(id);
        if (f?.type === "formula") stack.push(...(f.options.dependsOn ?? []));
      }
    }
    return fieldOptionsSchema.parse({
      formula: compiled.canonical,
      resultType: compiled.resultType,
      dependsOn: compiled.dependsOn,
      volatile: compiled.volatile || undefined,
      computedOn: compiled.volatile ? new Date().toISOString().slice(0, 10) : undefined,
      precision: compiled.resultType === "number" ? (precision ?? undefined) : undefined,
    });
  }

  /** After a field changes type, formulas using it may change result type: recompile and recompute them. */
  async function refreshFormulasUsing(t: Db, tableId: string, fieldId: string) {
    const users = (await loadFields(t, tableId)).filter((f) => f.type === "formula" && (f.options.dependsOn ?? []).includes(fieldId));
    for (const f of users) {
      let options: FieldOptions;
      try {
        options = await formulaOptions(t, tableId, f.options.formula ?? "", f.options.precision, f.id);
      } catch {
        continue; // leave it; it will show empty/#ERROR! values
      }
      const updated = toField(await t.one(`UPDATE fields SET options=$2 WHERE id=$1 RETURNING *`, [f.id, options]));
      await recomputeField(t, new Schema(t), updated);
      await refreshFormulasUsing(t, tableId, f.id);
    }
  }

  /** Validate link / lookup / rollup / count options against the schema. */
  async function checkStructuralOptions(t: Db, schema: Schema, tableId: string, type: FieldType, options: FieldOptions) {
    if (type === "link") {
      const target = await t.one<{ base_id: string }>(`SELECT base_id FROM tables WHERE id=$1`, [options.linkedTableId ?? ""]);
      const own = await t.one<{ base_id: string }>(`SELECT base_id FROM tables WHERE id=$1`, [tableId]);
      if (!target || target.base_id !== own!.base_id) throw new HttpError(400, "Choose a table in this base to link to");
    }
    if (type === "lookup" || type === "rollup" || type === "count") {
      const link = (await schema.fields(tableId)).find((f) => f.id === options.linkFieldId);
      if (!link || link.type !== "link") throw new HttpError(400, "Choose a link field in this table");
      if (type !== "count") {
        const target = (await schema.fields(link.options.linkedTableId!)).find((f) => f.id === options.targetFieldId);
        if (!target) throw new HttpError(400, "Choose a field from the linked table");
      }
    }
  }

  async function uniqueFieldName(t: Db, tableId: string, base: string) {
    let name = base;
    for (let i = 2; await t.one(`SELECT 1 FROM fields WHERE table_id=$1 AND name=$2`, [tableId, name]); i++) name = `${base} ${i}`;
    return name;
  }

  async function insertField(t: Db, tableId: string, name: string, type: FieldType, options: FieldOptions, id = newId("fld")) {
    const pos = await t.one<{ n: number }>(`SELECT COALESCE(MAX(position)+1,0)::int AS n FROM fields WHERE table_id=$1`, [tableId]);
    return toField(
      await t.one(`INSERT INTO fields (id, table_id, name, type, options, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
        id, tableId, name, type, options, pos!.n,
      ]),
    );
  }

  app.post("/api/tables/:tableId/fields", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const body = z
      .object({ name: nameSchema, type: z.enum(FIELD_TYPES), options: fieldOptionsInput, editAccess: z.enum(EDIT_ACCESS).optional() })
      .parse(req.body);
    await tableAccess(db, user.id, tableId, "creator");
    const created = await db.tx(async (t) => {
      const dup = await t.one(`SELECT 1 FROM fields WHERE table_id=$1 AND name=$2`, [tableId, body.name]);
      if (dup) throw new HttpError(409, `A field named "${body.name}" already exists`);
      const schema = new Schema(t);
      const options = buildOptions(body.type, body.options);
      await checkStructuralOptions(t, schema, tableId, body.type, options);

      if (body.type === "link") {
        const id = newId("fld");
        const selfLink = options.linkedTableId === tableId;
        if (!selfLink) {
          // Create the matching field on the other table, named after this table.
          const inverseId = newId("fld");
          const own = await t.one<{ name: string }>(`SELECT name FROM tables WHERE id=$1`, [tableId]);
          const invName = await uniqueFieldName(t, options.linkedTableId!, own!.name);
          await insertField(t, options.linkedTableId!, invName, "link", { linkedTableId: tableId, inverseFieldId: id }, inverseId);
          options.inverseFieldId = inverseId;
        }
        return insertField(t, tableId, body.name, "link", options, id);
      }

      const finalOptions = body.type === "formula"
        ? await formulaOptions(t, tableId, body.options?.formula ?? "", body.options?.precision)
        : options;
      const created = await insertField(t, tableId, body.name, body.type, finalOptions);
      if (COMPUTED_TYPES.has(body.type)) await recomputeField(t, new Schema(t), created);
      return created;
    });
    const field = await setEditAccess(db, created, body.editAccess);
    return { field };
  });

  app.patch("/api/fields/:fieldId", async (req) => {
    const user = requireUser(req);
    const { fieldId } = req.params as { fieldId: string };
    const body = z
      .object({ name: nameSchema.optional(), type: z.enum(FIELD_TYPES).optional(), options: fieldOptionsInput, editAccess: z.enum(EDIT_ACCESS).optional() })
      .parse(req.body);
    const tableId = await fieldTableId(db, fieldId);
    await tableAccess(db, user.id, tableId, "creator");
    const before = await db.one<{ rule: string | null }>(`SELECT options->>'editAccess' AS rule FROM fields WHERE id=$1`, [fieldId]);

    const changed = await db.tx(async (t) => {
      const old = toField(await t.one(`SELECT * FROM fields WHERE id=$1`, [fieldId]));
      const table = await t.one<{ primary_field_id: string }>(`SELECT primary_field_id FROM tables WHERE id=$1`, [tableId]);
      const type = body.type ?? old.type;
      if (fieldId === table!.primary_field_id && !PRIMARY_TYPES.has(type)) {
        throw new HttpError(400, "The primary field can't be that type");
      }
      // Attachment and person fields can swap with plain fields: values become names (files and
      // people → text) or are cleared (text → files/people — there's nothing to turn into a file).
      const SWAPPABLE = new Set<FieldType>(["attachment", "user"]);
      const plainOrSwappable = (t: FieldType) => SWAPPABLE.has(t) || !STRUCTURAL_TYPES.has(t);
      if (type !== old.type && (SWAPPABLE.has(type) || SWAPPABLE.has(old.type)) && plainOrSwappable(type) && plainOrSwappable(old.type)) {
        const name = body.name ?? old.name;
        if (name !== old.name && await t.one(`SELECT 1 FROM fields WHERE table_id=$1 AND name=$2 AND id<>$3`, [tableId, name, fieldId])) {
          throw new HttpError(409, `A field named "${name}" already exists`);
        }
        const options = buildOptions(type, body.options ?? {});
        const next: Field = { ...old, name, type, options };
        const rows = await t.query<{ id: string; cells: Record<string, CellValue> }>(`SELECT id, cells FROM records WHERE table_id=$1 AND cells ? $2`, [tableId, fieldId]);
        const ids = rows.flatMap((r) => (Array.isArray(r.cells[fieldId]) ? (r.cells[fieldId] as string[]) : typeof r.cells[fieldId] === "string" ? [r.cells[fieldId] as string] : []));
        const names: Record<string, string> = old.type === "user" ? await userNames(t, ids)
          : old.type === "attachment" ? Object.fromEntries(Object.values(await attachmentInfos(t, ids)).map((a) => [a.id, a.filename])) : {};
        await t.query(`UPDATE fields SET name=$2, type=$3, options=$4 WHERE id=$1`, [fieldId, name, type, options]);
        const schema = new Schema(t);
        for (const r of rows) {
          let after: CellValue = null;
          if (!SWAPPABLE.has(type)) {
            const v = r.cells[fieldId];
            const text = (Array.isArray(v) ? v : [v]).map((x) => names[String(x)] ?? "").filter(Boolean).join(", ");
            after = text ? safeNormalize(next, text) : null;
          }
          await writeCells(t, schema, user.id, tableId, r.id, { [fieldId]: after });
        }
        await refreshFormulasUsing(t, tableId, fieldId);
        return toField(await t.one(`SELECT * FROM fields WHERE id=$1`, [fieldId]));
      }
      if (type !== old.type && (STRUCTURAL_TYPES.has(type) || STRUCTURAL_TYPES.has(old.type))) {
        throw new HttpError(400, "Linked and calculated fields can't be converted to another type yet. Create a new field instead.");
      }
      const name = body.name ?? old.name;
      if (name !== old.name) {
        const dup = await t.one(`SELECT 1 FROM fields WHERE table_id=$1 AND name=$2 AND id<>$3`, [tableId, name, fieldId]);
        if (dup) throw new HttpError(409, `A field named "${name}" already exists`);
      }

      if (STRUCTURAL_TYPES.has(type)) {
        let options = old.options;
        if (type === "link") {
          if (body.options?.linkedTableId && body.options.linkedTableId !== old.options.linkedTableId) {
            throw new HttpError(400, "A link field can't be pointed at a different table");
          }
        } else if (type === "formula" && body.options) {
          options = await formulaOptions(
            t, tableId,
            body.options.formula ?? formulaToDisplay(old.options.formula ?? "", await loadFields(t, tableId)),
            body.options.precision ?? old.options.precision,
            fieldId,
          );
        } else if (body.options) {
          options = buildOptions(type, { ...old.options, ...body.options });
          await checkStructuralOptions(t, new Schema(t), tableId, type, options);
        }
        const updated = toField(await t.one(`UPDATE fields SET name=$2, options=$3 WHERE id=$1 RETURNING *`, [fieldId, name, options]));
        if (COMPUTED_TYPES.has(type) && body.options) {
          await recomputeField(t, new Schema(t), updated);
          if (type === "formula") await refreshFormulasUsing(t, tableId, fieldId);
        }
        return updated;
      }

      const options = buildOptions(type, body.options ?? (type === old.type ? old.options : { choices: old.options.choices }));
      const next: Field = { ...old, name, type, options };
      // Re-validate existing values if the type or the select choices changed.
      if (type !== old.type || body.options) {
        const schema = new Schema(t);
        const rows = await t.query<{ id: string; cells: Record<string, CellValue> }>(
          `SELECT id, cells FROM records WHERE table_id=$1 AND cells ? $2`,
          [tableId, fieldId],
        );
        await t.query(`UPDATE fields SET type=$2, options=$3 WHERE id=$1`, [fieldId, type, options]);
        for (const r of rows) {
          const before = r.cells[fieldId];
          const after = type !== old.type ? convertCell(old, next, before) : safeNormalize(next, before);
          // writeCells also refreshes lookups/rollups that read this field.
          await writeCells(t, schema, user.id, tableId, r.id, { [fieldId]: after });
        }
      }
      const saved = toField(
        await t.one(`UPDATE fields SET name=$2, type=$3, options=$4 WHERE id=$1 RETURNING *`, [fieldId, name, type, options]),
      );
      if (type !== old.type) await refreshFormulasUsing(t, tableId, fieldId);
      return saved;
    });
    const field = await setEditAccess(db, changed, body.editAccess ?? (before?.rule as EditAccess | null) ?? undefined);
    return { field };
  });

  app.delete("/api/fields/:fieldId", async (req) => {
    const user = requireUser(req);
    const { fieldId } = req.params as { fieldId: string };
    const tableId = await fieldTableId(db, fieldId);
    await tableAccess(db, user.id, tableId, "creator");
    const t = await db.one<{ primary_field_id: string }>(`SELECT primary_field_id FROM tables WHERE id=$1`, [tableId]);
    if (t!.primary_field_id === fieldId) throw new HttpError(400, "The primary field can't be deleted");
    const field = toField(await db.one(`SELECT * FROM fields WHERE id=$1`, [fieldId]));

    // A link field is deleted together with its other side.
    const toDelete = [field];
    if (field.type === "link" && field.options.inverseFieldId) {
      const inv = await db.one(`SELECT * FROM fields WHERE id=$1`, [field.options.inverseFieldId]);
      if (inv) toDelete.push(toField(inv));
    }
    const blockers = (await Promise.all(toDelete.map((f) => dependentFieldNames(db, f.id)))).flat();
    if (blockers.length) {
      throw new HttpError(400, `Other fields use this field: ${blockers.join(", ")}. Delete or change those first.`);
    }
    for (const f of toDelete) {
      const tbl = await db.one<{ primary_field_id: string }>(`SELECT primary_field_id FROM tables WHERE id=$1`, [f.tableId]);
      if (tbl!.primary_field_id === f.id) throw new HttpError(400, "That would delete a primary field");
    }
    await db.tx(async (tx) => {
      for (const f of toDelete) {
        await tx.query(`UPDATE records SET cells = cells - $2 WHERE table_id=$1 AND cells ? $2`, [f.tableId, f.id]);
        await tx.query(`DELETE FROM fields WHERE id=$1`, [f.id]);
      }
    });
    return { ok: true };
  });

  // ================= Records =================
  /** Validate input cells, including that linked records exist. */

  app.post("/api/tables/:tableId/records", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const body = z.object({ cells: z.record(z.unknown()).default({}) }).parse(req.body ?? {});
    const access = await tableAccess(db, user.id, tableId, "editor");
    await checkRecordAccess(db, access, tableId, "add");
    const record = await db.tx(async (t) => {
      const cells = await prepareCells(t, tableId, body.cells, { create: true });
      await checkFieldEdits(t, access, tableId, givenKeys(cells));
      const id = newId("rec");
      await t.query(`INSERT INTO records (id, table_id, cells, created_by, updated_by) VALUES ($1,$2,'{}',$3,$3)`, [id, tableId, user.id]);
      const schema = new Schema(t);
      await writeCells(t, schema, user.id, tableId, id, cells, "create");
      // New records start with Count = 0, formulas filled in, etc.
      await computeAllForRecord(t, schema, tableId, id);
      return toRecord(await t.one(`SELECT * FROM records WHERE id=$1`, [id]));
    });
    app.automations.recordChanged({ tableId, recordId: record.id, kind: "created", fieldIds: await fieldIdsOf(db, tableId, Object.keys(body.cells)) });
    return { record };
  });

  app.patch("/api/records/:recordId", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    const body = z.object({ cells: z.record(z.unknown()) }).parse(req.body);
    const tableId = await recordTableId(db, recordId);
    const access = await tableAccess(db, user.id, tableId, "editor");
    const record = await db.tx(async (t) => {
      const patch = await prepareCells(t, tableId, body.cells);
      await checkFieldEdits(t, access, tableId, Object.keys(patch));
      await writeCells(t, new Schema(t), user.id, tableId, recordId, patch);
      return toRecord(await t.one(`SELECT * FROM records WHERE id=$1`, [recordId]));
    });
    app.automations.recordChanged({ tableId, recordId, kind: "updated", fieldIds: await fieldIdsOf(db, tableId, Object.keys(body.cells)) });
    return { record };
  });

  app.delete("/api/records/:recordId", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    const tableId = await recordTableId(db, recordId);
    const access = await tableAccess(db, user.id, tableId, "editor");
    await checkRecordAccess(db, access, tableId, "delete");
    await db.tx(async (t) => {
      // Soft delete: kept for the trash / restore feature. Links to it are removed.
      await t.query(`UPDATE records SET deleted_at=now(), updated_by=$2 WHERE id=$1`, [recordId, user.id]);
      await logHistory(t, recordId, user.id, "delete", {});
      await unlinkRecord(t, new Schema(t), user.id, tableId, recordId);
    });
    return { ok: true };
  });

  /** Records of a table with their display names — used by the link picker. */
  app.get("/api/tables/:tableId/record-names", async (req) => {
    const user = requireUser(req);
    const { tableId } = req.params as { tableId: string };
    const q = z.object({ q: z.string().max(200).default("") }).parse(req.query).q.trim().toLowerCase();
    await tableAccess(db, user.id, tableId, "read");
    const schema = new Schema(db);
    const primary = await schema.primary(tableId);
    const rows = await db.query<{ id: string; cells: Record<string, CellValue> }>(
      `SELECT id, cells FROM records WHERE table_id=$1 AND deleted_at IS NULL ORDER BY autonumber LIMIT 2000`,
      [tableId],
    );
    const all = rows.map((r) => ({ id: r.id, name: primary ? cellToText(primary, r.cells[primary.id] ?? null) : "" }));
    return { records: (q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all).slice(0, 100) };
  });
}

/** Fields allowed as a table's primary (first) field. */
const PRIMARY_TYPES = new Set<FieldType>([
  "singleLineText", "longText", "number", "singleSelect", "date", "email", "url", "phone", "currency", "percent", "duration", "autonumber",
]);

/** People in a user field must be able to open the base (workspace members or people invited to it). */
async function assertCollaborators(t: Db, tableId: string, fieldName: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await t.query<{ id: string }>(
    `SELECT u.id FROM users u, tables tb JOIN bases b ON b.id = tb.base_id
     WHERE tb.id = $1 AND u.id = ANY($2::text[])
       AND (EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = b.workspace_id AND m.user_id = u.id)
         OR EXISTS (SELECT 1 FROM base_members bm WHERE bm.base_id = b.id AND bm.user_id = u.id))`,
    [tableId, ids],
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(422, `${fieldName}: that person doesn't have access to this base`);
}

function safeNormalize(field: Field, value: CellValue): CellValue {
  try {
    return normalizeCell(field, value);
  } catch {
    return null;
  }
}

/**
 * What the client needs to show link and attachment cells: names of linked records, and
 * details of attachments (their filenames also go into labels so cellToText works).
 */
export async function displayData(db: Db, fields: Field[], records: RecordRow[]) {
  const ids = (type: string) =>
    records.flatMap((r) => fields.filter((f) => f.type === type).flatMap((f) => (r.cells[f.id] as string[] | undefined) ?? []));
  const labels = await labelsFor(db, new Schema(db), ids("link"));
  const files = await attachmentInfos(db, ids("attachment"));
  for (const f of Object.values(files)) labels[f.id] = f.filename;
  Object.assign(labels, await userNames(db, [...USER_TYPES].flatMap((t) => ids(t))));
  return { labels, files };
}
