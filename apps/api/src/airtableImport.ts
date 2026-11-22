import type { CellValue, FieldType } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { MAX_FILE_BYTES } from "./files";
import { safeFetch, type FetchedFile } from "./safeFetch";

/**
 * Import whole bases from Airtable, so a team can move over and carry on where they left off.
 *
 * The person pastes an Airtable personal access token (scopes: schema.bases:read and
 * data.records:read). It lives only in memory for the length of the import and is never stored
 * or logged. We read each base's schema and records through Airtable's Web API and rebuild it
 * here through our own API (as that person), so every rule — access, links, formulas — applies.
 *
 * What comes across: tables, fields (types, options, select colours, date formats), records with
 * their created time, attachments (downloaded and stored here), links between records, lookups,
 * rollups, counts and formulas, and views (name, type, visible fields and order). Anything we
 * can't recreate as a live field (e.g. a formula using a function we don't have) is kept as a
 * plain field holding the values Airtable showed, and listed as a note on the import.
 */

// ------------------------------------------------------------------ Airtable API

export interface AtField { id: string; name: string; type: string; options?: any; description?: string }
export interface AtView { id: string; name: string; type: string; visibleFieldIds?: string[] }
export interface AtTable { id: string; name: string; primaryFieldId: string; fields: AtField[]; views: AtView[] }
export interface AtRecord { id: string; createdTime: string; fields: Record<string, any> }

export class AirtableClient {
  private last = 0;
  constructor(
    private token: string,
    private baseUrl = "https://api.airtable.com",
    private fetchImpl: typeof fetch = fetch,
    private minGapMs = 220, // Airtable allows 5 requests a second per base
  ) {}

  async get(path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl + path, { headers: { Authorization: `Bearer ${this.token}` } });
      } catch {
        if (attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error("Couldn't reach Airtable. Check the server's internet connection and try again.");
      }
      if (res.status === 429 && attempt < 4) { await sleep(30_000); continue; }
      if (res.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      const body: any = await res.json().catch(() => ({}));
      if (res.ok) return body;
      if (res.status === 401) throw new HttpError(400, "Airtable didn't accept that token. Check it was copied in full and hasn't expired.");
      if (res.status === 403) {
        throw new HttpError(400, "That token can't read this. Give it the scopes schema.bases:read and data.records:read, and access to the bases you want.");
      }
      if (res.status === 404) throw new HttpError(400, "Airtable couldn't find that base or table (has the token got access to it?).");
      throw new Error(`Airtable said: ${body?.error?.message ?? body?.error?.type ?? res.status}`);
    }
  }

  async listBases(): Promise<{ id: string; name: string; permissionLevel: string }[]> {
    const out: { id: string; name: string; permissionLevel: string }[] = [];
    let offset: string | undefined;
    do {
      const page = await this.get(`/v0/meta/bases${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`);
      out.push(...(page.bases ?? []));
      offset = page.offset;
    } while (offset);
    return out;
  }

  async tables(baseId: string): Promise<AtTable[]> {
    try {
      return (await this.get(`/v0/meta/bases/${baseId}/tables?include%5B%5D=visibleFieldIds`)).tables;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return (await this.get(`/v0/meta/bases/${baseId}/tables`)).tables;
    }
  }

  async *records(baseId: string, tableId: string): AsyncGenerator<AtRecord[]> {
    let offset: string | undefined;
    do {
      const q = `pageSize=100&returnFieldsByFieldId=true${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
      const page = await this.get(`/v0/${baseId}/${tableId}?${q}`);
      yield page.records ?? [];
      offset = page.offset;
    } while (offset);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ field mapping

const BASE_COLORS = ["blue", "teal", "purple", "orange", "red", "cyan"];
const OUR_COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];
/** Airtable colours look like "blueLight2" or "tealBright"; we keep the hue. */
export function mapColor(c: string | undefined): string {
  const hue = (c ?? "").replace(/(Light|Dark|Bright)\d*$/, "").replace(/\d+$/, "").toLowerCase();
  return OUR_COLORS.includes(hue) ? hue : "blue";
}

const DATE_FORMATS = new Set(["local", "friendly", "us", "european", "iso"]);
function dateOpts(o: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const df = o?.dateFormat?.name;
  if (DATE_FORMATS.has(df)) out.dateFormat = df;
  const tf = o?.timeFormat?.name;
  if (tf === "12hour") out.timeFormat = "12";
  if (tf === "24hour") out.timeFormat = "24";
  return out;
}

export interface FieldSpec { type: FieldType; options: Record<string, unknown> }

/** Airtable fields we can create directly (not links or calculated ones). null = not a plain field. */
export function plainSpec(f: AtField): FieldSpec | null {
  const o = f.options ?? {};
  switch (f.type) {
    case "singleLineText": return { type: "singleLineText", options: {} };
    case "email": return { type: "email", options: {} };
    case "url": return { type: "url", options: {} };
    case "phoneNumber": return { type: "phone", options: {} };
    case "multilineText":
    case "richText": return { type: "longText", options: {} };
    case "number": return { type: "number", options: { precision: clampPrecision(o.precision) } };
    case "autoNumber": return { type: "number", options: { precision: 0 } };
    case "currency": return { type: "currency", options: { precision: clampPrecision(o.precision ?? 2), symbol: String(o.symbol ?? "$").slice(0, 5) } };
    case "percent": return { type: "percent", options: { precision: clampPrecision(o.precision) } };
    case "duration": return { type: "duration", options: { durationFormat: o.durationFormat === "h:mm" ? "h:mm" : "h:mm:ss" } };
    case "rating": return { type: "rating", options: { max: Math.min(10, Math.max(1, Number(o.max) || 5)) } };
    case "checkbox": return { type: "checkbox", options: {} };
    case "singleSelect":
    case "multipleSelects":
      return {
        type: f.type === "singleSelect" ? "singleSelect" : "multipleSelect",
        options: { choices: uniqueChoices(o.choices ?? []).map((c: any) => ({ name: c.name, color: mapColor(c.color) })) },
      };
    case "date": return { type: "date", options: dateOpts(o) };
    case "dateTime": return { type: "date", options: { includeTime: true, ...dateOpts(o) } };
    case "createdTime": return { type: "createdTime", options: dateOpts(o.result?.options ?? o) };
    case "lastModifiedTime": return { type: "date", options: { includeTime: true, ...dateOpts(o.result?.options ?? o) } };
    case "multipleAttachments": return { type: "attachment", options: {} };
    case "singleCollaborator":
    case "multipleCollaborators":
    case "createdBy":
    case "lastModifiedBy":
    case "barcode":
    case "externalSyncSource":
      return { type: "singleLineText", options: {} };
    case "button": return { type: "url", options: {} };
    case "aiText": return { type: "longText", options: {} };
    case "multipleRecordLinks":
    case "formula":
    case "rollup":
    case "multipleLookupValues":
    case "count":
      return null;
    default:
      return { type: "singleLineText", options: {} };
  }
}

function uniqueChoices(choices: any[]) {
  const seen = new Set<string>();
  return choices.filter((c) => c?.name && !seen.has(c.name) && seen.add(c.name));
}
const clampPrecision = (p: unknown) => Math.min(8, Math.max(0, Number(p) || 0));

/** For a calculated field we keep as plain values: what plain type fits its result. */
export function snapshotSpec(f: AtField): FieldSpec {
  const r = f.options?.result;
  if (f.type === "count") return { type: "number", options: { precision: 0 } };
  if (r && f.type !== "multipleLookupValues") {
    const inner = plainSpec({ ...f, type: r.type, options: r.options });
    if (inner && ["number", "currency", "percent", "duration", "checkbox", "date", "rating"].includes(inner.type)) return inner;
  }
  return { type: "longText", options: {} };
}

/** Text for a value of any shape (collaborators, lookups of links, barcodes…). */
export function valueText(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if ("error" in v && Object.keys(v).length <= 2) return "#ERROR!";
    return String(v.name ?? v.text ?? v.value ?? v.label ?? v.filename ?? v.email ?? v.url ?? "");
  }
  return String(v);
}

/** An Airtable cell value as we store it, for a field created with `spec`. */
export function convertValue(atType: string, spec: FieldSpec, v: any): CellValue {
  if (v === null || v === undefined || v === "") return null;
  switch (spec.type) {
    case "percent":
      // Airtable keeps 0.5 for 50%; we keep 50.
      return typeof v === "number" ? Math.round(v * 100 * 1e8) / 1e8 : null;
    case "number":
    case "currency":
    case "duration":
    case "rating": {
      const n = Array.isArray(v) ? Number(v[0]) : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox": return (Array.isArray(v) ? v.some(Boolean) : !!v) || null;
    case "singleSelect": return typeof v === "string" ? v : valueText(v) || null;
    case "multipleSelect": return Array.isArray(v) ? v.map(String) : [String(v)];
    case "date": {
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s !== "string") return null;
      return spec.options.includeTime ? s : s.slice(0, 10);
    }
    case "createdTime": return null; // comes from the record's created time
    case "url": return atType === "button" ? (v?.url ?? null) : String(v);
    case "longText":
      if (atType === "aiText") return v?.value ?? null;
      return valueText(v) || null;
    default:
      return valueText(v) || null;
  }
}

/** "SUM(values)" → our rollup aggregation. null: not one we have. */
export function rollupAggregation(formula: string | undefined): string | null {
  const f = (formula ?? "").replace(/\s+/g, "").toUpperCase();
  const map: Record<string, string> = {
    "SUM(VALUES)": "sum", "AVERAGE(VALUES)": "avg", "MIN(VALUES)": "min", "MAX(VALUES)": "max",
    "COUNT(VALUES)": "count", "COUNTA(VALUES)": "count", "COUNTALL(VALUES)": "countAll",
    "ARRAYJOIN(VALUES)": "join", "ARRAYJOIN(VALUES,\",\")": "join", "ARRAYJOIN(VALUES,\", \")": "join", "CONCATENATE(VALUES)": "join",
    "ARRAYJOIN(ARRAYUNIQUE(VALUES))": "joinUnique", "ARRAYUNIQUE(VALUES)": "joinUnique",
  };
  return map[f] ?? null;
}

/** Airtable formulas name fields by id ({fldAbc}); ours name them by field name. */
export function convertFormula(formula: string, names: Map<string, string>): string | null {
  let missing = false;
  const out = formula.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (_, id) => {
    const n = names.get(id);
    if (!n) { missing = true; return _; }
    return `{${n}}`;
  });
  return missing ? null : out;
}

// ------------------------------------------------------------------ the import job

export interface ImportJob {
  id: string;
  userId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** What is happening right now, in words. */
  step: string;
  bases: {
    airtableId: string;
    name: string;
    status: "waiting" | "running" | "done" | "failed";
    baseId?: string;
    tables: number;
    records: number;
    files: number;
    notes: string[];
    error?: string;
  }[];
}

export interface AirtableImportOptions {
  apiUrl?: string;
  /** Tests: serve files without the network. */
  fetchFile?: (url: string) => Promise<FetchedFile>;
  minGapMs?: number;
}

type SaveFile = (tableId: string, userId: string | null, filename: string, mime: string, stream: FetchedFile["stream"]) => Promise<{ id: string }>;

export function registerAirtableImport(app: FastifyInstance, db: Db, saveFile: SaveFile, opts: AirtableImportOptions = {}) {
  const jobs = new Map<string, ImportJob>();
  const client = (token: string) => new AirtableClient(token, opts.apiUrl, fetch, opts.minGapMs);
  const tokenSchema = z.string().trim().min(10, "Paste your Airtable personal access token").max(400);

  /** Which bases can this token read? */
  app.post("/api/import/airtable/bases", async (req) => {
    requireUser(req);
    const { token } = z.object({ token: tokenSchema }).parse(req.body);
    const bases = await client(token).listBases();
    return { bases: bases.map((b) => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel })) };
  });

  /** Start importing bases into a workspace. Runs in the background; poll the job. */
  app.post("/api/import/airtable", async (req) => {
    const user = requireUser(req);
    const body = z.object({
      token: tokenSchema,
      workspaceId: z.string(),
      bases: z.array(z.object({ id: z.string().regex(/^app[A-Za-z0-9]{14}$/), name: z.string().max(255) })).min(1).max(50),
    }).parse(req.body);
    const sid = req.cookies["brill_sid"];
    if (!sid) throw new HttpError(401, "Sign in first");
    const role = await db.one<{ role: string }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [body.workspaceId, user.id]);
    if (!role || !["owner", "creator"].includes(role.role)) throw new HttpError(403, "You need to be a creator in that workspace to import bases");
    if ([...jobs.values()].some((j) => j.userId === user.id && j.status === "running")) {
      throw new HttpError(409, "An import is already running — wait for it to finish");
    }
    const job: ImportJob = {
      id: randomUUID(), userId: user.id, status: "running", startedAt: new Date().toISOString(), step: "Starting…",
      bases: body.bases.map((b) => ({ airtableId: b.id, name: b.name, status: "waiting", tables: 0, records: 0, files: 0, notes: [] })),
    };
    jobs.set(job.id, job);
    void runJob(job, body.token, body.workspaceId, sid).catch((e) => {
      job.status = "failed";
      job.error = (e as Error).message;
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      // Forget finished jobs after a day.
      setTimeout(() => jobs.delete(job.id), 24 * 3600_000).unref();
    });
    return { job };
  });

  app.get("/api/import/jobs/:id", async (req) => {
    const user = requireUser(req);
    const job = jobs.get((req.params as { id: string }).id);
    if (!job || job.userId !== user.id) throw new HttpError(404, "Not found");
    return { job };
  });

  async function runJob(job: ImportJob, token: string, workspaceId: string, sid: string) {
    const at = client(token);
    for (const b of job.bases) {
      b.status = "running";
      try {
        await importBase(job, b, at, workspaceId, sid);
        b.status = "done";
      } catch (e) {
        b.status = "failed";
        b.error = (e as Error).message;
      }
    }
    job.step = "Finished";
    job.status = job.bases.every((b) => b.status === "failed") ? "failed" : "done";
    if (job.status === "failed") job.error = job.bases[0]?.error;
  }

  async function importBase(job: ImportJob, jb: ImportJob["bases"][number], at: AirtableClient, workspaceId: string, sid: string) {
    /** Call our own API as the person importing. */
    const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as any, cookies: { brill_sid: sid } });
      const body = res.body ? res.json() : {};
      if (res.statusCode >= 400) throw new HttpError(res.statusCode, body.error ?? `Request failed (${res.statusCode})`);
      return body;
    };
    const note = (s: string) => { if (jb.notes.length < 200) jb.notes.push(s); };

    job.step = `Reading “${jb.name}” from Airtable…`;
    const tables = await at.tables(jb.airtableId);
    if (!tables.length) throw new Error("This base has no tables");

    // 1. The base and its tables, emptied of our default fields and records.
    const created = await api("POST", `/api/workspaces/${workspaceId}/bases`, { name: jb.name.slice(0, 255) || "Imported base", color: BASE_COLORS[Math.abs(hash(jb.airtableId)) % BASE_COLORS.length] });
    jb.baseId = created.base.id;
    const tableMap = new Map<string, string>(); // Airtable table → ours
    for (const [i, t] of tables.entries()) {
      const id = i === 0 ? created.firstTableId : (await api("POST", `/api/bases/${jb.baseId}/tables`, { name: t.name })).table.id;
      if (i === 0) await api("PATCH", `/api/tables/${id}`, { name: t.name });
      tableMap.set(t.id, id);
      const ours = await api("GET", `/api/tables/${id}`);
      await db.query(`DELETE FROM records WHERE table_id=$1`, [id]);
      for (const f of ours.fields) if (f.id !== ours.table.primaryFieldId) await api("DELETE", `/api/fields/${f.id}`);
      jb.tables++;
    }

    // Field map: Airtable field → our field, how its values are written, and its name here.
    type Mapped = { id: string; tableId: string; spec?: FieldSpec; mode: "plain" | "snapshot" | "linkSide" | "linkInverse" | "computed" | "skip"; name: string };
    const fieldMap = new Map<string, Mapped>();
    const atFields = new Map<string, { table: AtTable; field: AtField }>();
    for (const t of tables) for (const f of t.fields) atFields.set(f.id, { table: t, field: f });
    const createField = async (tableId: string, name: string, type: string, options: Record<string, unknown>) =>
      (await api("POST", `/api/tables/${tableId}/fields`, { name: name.slice(0, 255), type, options })).field;
    const PRIMARY_OK = new Set(["singleLineText", "longText", "number", "singleSelect", "date", "email", "url", "phone", "currency", "percent", "duration"]);

    // 2. Primary fields and plain fields.
    job.step = `Creating fields for “${jb.name}”…`;
    for (const t of tables) {
      const tableId = tableMap.get(t.id)!;
      const ours = await api("GET", `/api/tables/${tableId}`);
      const primaryId = ours.table.primaryFieldId as string;
      const pf = t.fields.find((f) => f.id === t.primaryFieldId) ?? t.fields[0];
      const spec = pf && plainSpec(pf);
      if (pf && spec && PRIMARY_OK.has(spec.type)) {
        await api("PATCH", `/api/fields/${primaryId}`, { name: pf.name, type: spec.type, options: spec.options });
        fieldMap.set(pf.id, { id: primaryId, tableId, spec, mode: "plain", name: pf.name });
      } else if (pf) {
        // A calculated or special primary field: keep what it showed, as text.
        await api("PATCH", `/api/fields/${primaryId}`, { name: pf.name });
        fieldMap.set(pf.id, { id: primaryId, tableId, spec: { type: "singleLineText", options: {} }, mode: "snapshot", name: pf.name });
        if (pf.type !== "singleLineText") note(`${t.name} › ${pf.name}: the primary field was a ${pf.type} field; its values were copied as text.`);
      }
      for (const f of t.fields) {
        if (fieldMap.has(f.id)) continue;
        const s = plainSpec(f);
        if (!s) continue;
        try {
          const field = await createField(tableId, f.name, s.type, s.options);
          fieldMap.set(f.id, { id: field.id, tableId, spec: s, mode: "plain", name: field.name });
          if (["singleCollaborator", "multipleCollaborators", "createdBy", "lastModifiedBy"].includes(f.type)) {
            note(`${t.name} › ${f.name}: people were copied as their names (invite them to use person fields here).`);
          }
        } catch (e) {
          note(`${t.name} › ${f.name}: couldn't be created (${(e as Error).message}).`);
        }
      }
    }

    // 3. Links between tables (we create one side; the other side appears by itself).
    for (const t of tables) {
      const tableId = tableMap.get(t.id)!;
      for (const f of t.fields) {
        if (f.type !== "multipleRecordLinks" || fieldMap.has(f.id)) continue;
        const target = tableMap.get(f.options?.linkedTableId);
        if (!target) { note(`${t.name} › ${f.name}: links to a table that isn't in this base; skipped.`); continue; }
        try {
          const field = await createField(tableId, f.name, "link", { linkedTableId: target });
          fieldMap.set(f.id, { id: field.id, tableId, mode: "linkSide", name: field.name });
          const inv = f.options?.inverseLinkFieldId as string | undefined;
          if (inv && atFields.has(inv)) {
            if (field.options.inverseFieldId) {
              const invName = atFields.get(inv)!.field.name;
              await api("PATCH", `/api/fields/${field.options.inverseFieldId}`, { name: invName.slice(0, 255) }).catch(() => undefined);
              fieldMap.set(inv, { id: field.options.inverseFieldId, tableId: target, mode: "linkInverse", name: invName });
            } else {
              // A table linked to itself: one field here covers both directions.
              fieldMap.set(inv, { id: field.id, tableId, mode: "skip", name: f.name });
            }
          }
        } catch (e) {
          note(`${t.name} › ${f.name}: link couldn't be created (${(e as Error).message}).`);
        }
      }
    }

    // 4. Records, with their files. Links are filled in once every record exists.
    const recMap = new Map<string, string>(); // Airtable record → ours
    const pendingLinks: { recordId: string; cells: Record<string, string[]> }[] = [];
    const calcValues = new Map<string, Map<string, unknown>>(); // calculated field → our record → value
    for (const t of tables) {
      const tableId = tableMap.get(t.id)!;
      for await (const page of at.records(jb.airtableId, t.id)) {
        job.step = `Copying records of “${t.name}” (${jb.records.toLocaleString()} so far)…`;
        const batch: { cells: Record<string, CellValue> }[] = [];
        const links: Record<string, string[]>[] = [];
        for (const r of page) {
          const cells: Record<string, CellValue> = {};
          const linkCells: Record<string, string[]> = {};
          for (const [fid, v] of Object.entries(r.fields ?? {})) {
            const m = fieldMap.get(fid);
            const af = atFields.get(fid)?.field;
            if (!af) continue;
            if (m?.mode === "linkSide" && Array.isArray(v)) { linkCells[m.id] = v.map(String); continue; }
            if (!m || m.mode === "linkInverse" || m.mode === "skip") continue;
            if (m.spec?.type === "attachment") {
              const ids: string[] = [];
              for (const a of Array.isArray(v) ? v : []) {
                const id = await copyFile(tableId, job.userId, a, note, `${t.name} › ${af.name}`);
                if (id) { ids.push(id); jb.files++; }
              }
              if (ids.length) cells[m.id] = ids;
              continue;
            }
            const val = convertValue(af.type, m.spec!, v);
            if (val !== null) cells[m.id] = val;
          }
          batch.push({ cells });
          links.push(linkCells);
        }
        if (!batch.length) continue;
        let res: { ids: string[] };
        try {
          res = await api("POST", `/api/tables/${tableId}/records/batch`, { records: batch });
        } catch {
          // One bad value shouldn't sink the page: add them one at a time, dropping what's refused.
          res = { ids: [] };
          for (const rec of batch) {
            try {
              res.ids.push((await api("POST", `/api/tables/${tableId}/records/batch`, { records: [rec], typecast: true })).ids[0]);
            } catch (e) {
              res.ids.push((await api("POST", `/api/tables/${tableId}/records/batch`, { records: [{ cells: {} }] })).ids[0]);
              note(`${t.name}: a record lost some values (${(e as Error).message}).`);
            }
          }
        }
        for (const [i, r] of page.entries()) {
          const id = res.ids[i];
          recMap.set(r.id, id);
          if (r.createdTime) await db.query(`UPDATE records SET created_at=$2 WHERE id=$1`, [id, r.createdTime]);
          if (Object.keys(links[i]).length) pendingLinks.push({ recordId: id, cells: links[i] });
          // Remember what calculated fields showed, in case we can't recreate them.
          for (const [fid, v] of Object.entries(r.fields ?? {})) {
            const af = atFields.get(fid)?.field;
            if (af && ["formula", "rollup", "multipleLookupValues", "count"].includes(af.type) && !fieldMap.has(fid)) {
              if (!calcValues.has(fid)) calcValues.set(fid, new Map());
              calcValues.get(fid)!.set(id, v);
            }
          }
        }
        jb.records += page.length;
      }
    }

    job.step = `Linking records in “${jb.name}”…`;
    for (const p of pendingLinks) {
      const cells = Object.fromEntries(Object.entries(p.cells).map(([fid, ids]) => [fid, ids.map((x) => recMap.get(x)).filter(Boolean)]));
      try {
        await api("PATCH", `/api/records/${p.recordId}`, { cells });
      } catch (e) {
        note(`A record's links couldn't be set (${(e as Error).message}).`);
      }
    }

    // 5. Calculated fields, in an order where what they read already exists.
    job.step = `Recreating formulas, lookups and rollups in “${jb.name}”…`;
    const nameOf = () => new Map([...fieldMap].map(([k, v]) => [k, v.name]));
    let pending = tables.flatMap((t) => t.fields.filter((f) => !fieldMap.has(f.id) && ["formula", "rollup", "multipleLookupValues", "count"].includes(f.type)).map((f) => ({ t, f })));
    const snapshots: { t: AtTable; f: AtField; why: string }[] = [];
    while (pending.length) {
      const next: typeof pending = [];
      for (const { t, f } of pending) {
        const tableId = tableMap.get(t.id)!;
        const o = f.options ?? {};
        const link = fieldMap.get(o.recordLinkFieldId);
        const target = fieldMap.get(o.fieldIdInLinkedTable);
        let attempt: (() => Promise<any>) | null = null;
        let waitFor = false;
        if (f.type === "count") {
          if (!link) waitFor = true;
          else attempt = () => createField(tableId, f.name, "count", { linkFieldId: link.id });
        } else if (f.type === "multipleLookupValues" || f.type === "rollup") {
          if (!link || !target) waitFor = !!atFields.get(o.fieldIdInLinkedTable) && !!atFields.get(o.recordLinkFieldId);
          else if (f.type === "multipleLookupValues") attempt = () => createField(tableId, f.name, "lookup", { linkFieldId: link.id, targetFieldId: target.id });
          else {
            const agg = rollupAggregation(o.formula);
            if (agg) attempt = () => createField(tableId, f.name, "rollup", { linkFieldId: link.id, targetFieldId: target.id, aggregation: agg, precision: o.result?.options?.precision });
          }
        } else {
          const refs: string[] = o.referencedFieldIds ?? [];
          if (refs.some((id) => !fieldMap.has(id) && atFields.has(id))) waitFor = true;
          else {
            const text = convertFormula(o.formula ?? "", nameOf());
            if (text) attempt = () => createField(tableId, f.name, "formula", { formula: text, precision: o.result?.options?.precision });
          }
        }
        if (waitFor) { next.push({ t, f }); continue; }
        if (!attempt) { snapshots.push({ t, f, why: "uses something we can't recreate yet" }); continue; }
        try {
          const field = await attempt();
          fieldMap.set(f.id, { id: field.id, tableId, mode: "computed", name: field.name });
        } catch (e) {
          snapshots.push({ t, f, why: (e as Error).message });
        }
      }
      if (next.length === pending.length) { // nothing moved: they depend on each other or on skipped fields
        for (const p of next) snapshots.push({ ...p, why: "depends on fields that couldn't be recreated" });
        break;
      }
      pending = next;
    }
    // What couldn't be recreated keeps the values Airtable showed.
    const snapPatches = new Map<string, Record<string, CellValue>>();
    for (const { t, f, why } of snapshots) {
      const tableId = tableMap.get(t.id)!;
      const spec = snapshotSpec(f);
      let field;
      try {
        field = await createField(tableId, f.name, spec.type, spec.options);
      } catch {
        field = await createField(tableId, `${f.name} (values)`, spec.type, spec.options).catch(() => null);
      }
      if (!field) continue;
      fieldMap.set(f.id, { id: field.id, tableId, spec, mode: "snapshot", name: field.name });
      note(`${t.name} › ${f.name}: kept as values, not a live ${f.type === "multipleLookupValues" ? "lookup" : f.type} (${why}).`);
      for (const [recId, v] of calcValues.get(f.id) ?? []) {
        const val = convertValue(f.type, spec, v);
        if (val === null) continue;
        const p = snapPatches.get(recId) ?? {};
        p[field.id] = val;
        snapPatches.set(recId, p);
      }
    }
    for (const [recId, cells] of snapPatches) await api("PATCH", `/api/records/${recId}`, { cells }).catch(() => undefined);

    // 6. Views: same names and types, with Airtable's visible fields and their order.
    job.step = `Setting up views in “${jb.name}”…`;
    const VIEW_TYPES: Record<string, string> = { grid: "grid", kanban: "kanban", gallery: "gallery", calendar: "calendar", form: "form" };
    for (const t of tables) {
      const tableId = tableMap.get(t.id)!;
      const ours = await api("GET", `/api/tables/${tableId}`);
      const allOurs: string[] = ours.fields.map((f: any) => f.id);
      const order = t.fields.map((f) => fieldMap.get(f.id)).filter((m): m is Mapped => !!m && m.mode !== "skip" && m.tableId === tableId).map((m) => m.id);
      const fieldOrder = [...new Set([...order, ...allOurs])];
      let first = true;
      for (const v of t.views ?? []) {
        const type = VIEW_TYPES[v.type] ?? "grid";
        if (!VIEW_TYPES[v.type]) note(`${t.name} › view “${v.name}”: ${v.type} views aren't here yet; made a grid view instead.`);
        let view;
        if (first && type === "grid") view = ours.views[0];
        else view = (await api("POST", `/api/tables/${tableId}/views`, { name: v.name.slice(0, 255), type })).view;
        const visible = v.visibleFieldIds?.map((id) => fieldMap.get(id)?.id).filter(Boolean) as string[] | undefined;
        const config = {
          ...view.config,
          fieldOrder,
          ...(visible && type !== "form" ? { hiddenFieldIds: allOurs.filter((id) => !visible.includes(id) && id !== ours.table.primaryFieldId) } : {}),
        };
        await api("PATCH", `/api/views/${view.id}`, { name: v.name.slice(0, 255), config });
        first = false;
      }
      if (first === true) await api("PATCH", `/api/views/${ours.views[0].id}`, { config: { ...ours.views[0].config, fieldOrder } });
    }
    job.step = `“${jb.name}” is ready`;
  }

  /** Download one Airtable attachment and store it here. Airtable's links expire, so this happens straight away. */
  async function copyFile(tableId: string, userId: string, a: any, note: (s: string) => void, where: string): Promise<string | null> {
    if (!a?.url) return null;
    if (typeof a.size === "number" && a.size > MAX_FILE_BYTES) {
      note(`${where}: “${a.filename}” is over ${MAX_FILE_BYTES / 1024 / 1024} MB and was left in Airtable.`);
      return null;
    }
    try {
      const fetched = await (opts.fetchFile ?? ((u: string) => safeFetch(u, { timeoutMs: 120_000 })))(a.url);
      const saved = await saveFile(tableId, userId, a.filename || fetched.filename, a.type || fetched.mime, fetched.stream);
      return saved.id;
    } catch (e) {
      note(`${where}: “${a.filename}” couldn't be downloaded (${(e as Error).message}).`);
      return null;
    }
  }
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
