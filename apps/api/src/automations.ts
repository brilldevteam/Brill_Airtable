import {
  actionSchema, cellToText, newId, triggerSchema, USER_TYPES, viewConfigSchema,
  type Action, type AutomationRun, type CellValue, type Field, type Trigger,
} from "@brill/shared";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { baseAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { typecastCells } from "./importExport";
import { computeAllForRecord, labelsFor, Schema, userNames, writeCells } from "./links";
import { layout, type Mailer } from "./mail";
import { bus } from "./realtime";
import { loadFields, prepareCells } from "./routes";
import { makeLookup } from "./safeFetch";
import { buildViewQuery } from "./viewQuery";

/**
 * Automations engine.
 *
 * Record changes (from the API, forms, imports and other automations) are reported here with
 * recordChanged(). Matching automations run one at a time in the background, after the change
 * is saved, so people never wait for emails or webhooks. Every run is logged with each step's
 * result. Automations changing records can trigger other automations, up to 3 levels deep
 * (and never themselves), so loops stop on their own.
 */

export interface RecordEvent {
  tableId: string;
  recordId: string;
  kind: "created" | "updated";
  /** Fields the change set. */
  fieldIds: string[];
  /** Set when a public form created the record. */
  formViewId?: string | null;
  depth?: number;
  sourceAutomationId?: string;
}

interface Row {
  id: string; base_id: string; name: string; enabled: boolean; trigger: unknown; actions: unknown; created_by: string | null;
  created_at: string; updated_at: string;
}
type Cells = Record<string, CellValue>;
const MAX_DEPTH = 3;
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

declare module "fastify" {
  interface FastifyInstance {
    automations: AutomationEngine;
  }
}

export class AutomationEngine {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private db: Db,
    private opts: { mailer: Mailer; appUrl: string; allowLoopbackWebhooks?: boolean; log?: (e: unknown) => void },
  ) {}

  /** Report a change; matching automations run in the background. */
  recordChanged(ev: RecordEvent) {
    if ((ev.depth ?? 0) > MAX_DEPTH) return;
    this.enqueue(() => this.handle(ev));
  }

  /** Resolves when every queued run has finished (used by tests and "Test" runs). */
  idle() {
    return this.chain.then(() => undefined);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch((e) => this.opts.log?.(e));
    return p;
  }

  private async handle(ev: RecordEvent) {
    const rows = await this.db.query<Row>(
      `SELECT * FROM automations WHERE enabled AND trigger->>'tableId' = $1 ORDER BY created_at`, [ev.tableId],
    );
    for (const a of rows) {
      if (a.id === ev.sourceAutomationId) continue;
      const trigger = triggerSchema.parse(a.trigger);
      let fire = false;
      switch (trigger.type) {
        case "recordCreated": fire = ev.kind === "created"; break;
        case "formSubmitted": fire = ev.kind === "created" && !!ev.formViewId && ev.formViewId === trigger.viewId; break;
        case "recordUpdated":
          fire = ev.kind === "updated" && (trigger.fieldIds.length === 0 || ev.fieldIds.some((f) => trigger.fieldIds.includes(f)));
          break;
        case "recordMatches": {
          // Fires when a record *starts* matching, not on every edit while it matches.
          const now = await this.matches(trigger, ev.recordId);
          const was = !!(await this.db.one(`SELECT 1 FROM automation_matches WHERE automation_id=$1 AND record_id=$2`, [a.id, ev.recordId]));
          if (now && !was) {
            await this.db.query(`INSERT INTO automation_matches (automation_id, record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.id, ev.recordId]);
            fire = true;
          } else if (!now && was) {
            await this.db.query(`DELETE FROM automation_matches WHERE automation_id=$1 AND record_id=$2`, [a.id, ev.recordId]);
          }
          break;
        }
      }
      if (fire) await this.run(a, ev.recordId, false, ev.depth ?? 0);
    }
  }

  /** Does the record match the trigger's conditions? (Same rules as view filters.) */
  private async matches(trigger: Trigger, recordId: string): Promise<boolean> {
    const fields = await loadFields(this.db, trigger.tableId);
    const config = viewConfigSchema.parse({ filters: { conjunction: trigger.conjunction, conditions: trigger.conditions } });
    const { sql, params } = buildViewQuery(trigger.tableId, fields, config);
    return !!(await this.db.one(`SELECT 1 FROM (${sql}) q WHERE q.id = $${params.length + 1}`, [...params, recordId]));
  }

  /** Remember which records match now, so only records that start matching later fire. */
  async resetMatches(automationId: string) {
    await this.db.query(`DELETE FROM automation_matches WHERE automation_id=$1`, [automationId]);
    const a = await this.db.one<Row>(`SELECT * FROM automations WHERE id=$1`, [automationId]);
    if (!a?.enabled) return;
    const trigger = triggerSchema.parse(a.trigger);
    if (trigger.type !== "recordMatches") return;
    const fields = await loadFields(this.db, trigger.tableId);
    const config = viewConfigSchema.parse({ filters: { conjunction: trigger.conjunction, conditions: trigger.conditions } });
    const { sql, params } = buildViewQuery(trigger.tableId, fields, config);
    await this.db.query(
      `INSERT INTO automation_matches (automation_id, record_id) SELECT $${params.length + 1}, q.id FROM (${sql}) q ON CONFLICT DO NOTHING`,
      [...params, automationId],
    );
  }

  /** Run now on a record, outside the trigger (the "Test" button). */
  testRun(automationId: string, recordId: string) {
    return this.enqueue(async () => {
      const a = await this.db.one<Row>(`SELECT * FROM automations WHERE id=$1`, [automationId]);
      if (!a) throw new HttpError(404, "Not found");
      return this.run(a, recordId, true, 0);
    });
  }

  private async run(a: Row, recordId: string, test: boolean, depth: number): Promise<AutomationRun> {
    const trigger = triggerSchema.parse(a.trigger);
    const actions = z.array(actionSchema).parse(a.actions);
    const steps: AutomationRun["steps"] = [];
    let status: AutomationRun["status"] = "success";
    const ctx = await this.context(trigger.tableId, recordId);
    for (const action of actions) {
      try {
        if (!ctx) throw new Error("The record was deleted before the automation ran");
        const message = await this.exec(a, trigger, action, ctx, depth);
        steps.push({ action: action.type, ok: true, message });
      } catch (e) {
        steps.push({ action: action.type, ok: false, message: (e as Error).message || "Failed" });
        status = "failed";
        break; // later steps usually depend on earlier ones, like in Airtable
      }
    }
    const run: AutomationRun = {
      id: newId("run"), automationId: a.id, recordId, recordName: ctx?.name ?? "", status, steps, test, startedAt: new Date().toISOString(),
    };
    await this.db.query(
      `INSERT INTO automation_runs (id, automation_id, record_id, record_name, status, steps, test) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [run.id, a.id, recordId, run.recordName, status, JSON.stringify(steps), test],
    );
    // Keep the latest 200 runs per automation.
    await this.db.query(
      `DELETE FROM automation_runs WHERE automation_id=$1 AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id=$1 ORDER BY started_at DESC LIMIT 200)`,
      [a.id],
    );
    return run;
  }

  /** The triggering record, its table's fields, and display names for links and people. */
  private async context(tableId: string, recordId: string) {
    const rec = await this.db.one<{ id: string; cells: Cells; table_id: string }>(
      `SELECT id, cells, table_id FROM records WHERE id=$1 AND deleted_at IS NULL`, [recordId],
    );
    if (!rec) return null;
    const fields = await loadFields(this.db, tableId);
    const ids = (pred: (f: Field) => boolean) => fields.filter(pred).flatMap((f) => (rec.cells[f.id] as string[] | undefined) ?? []);
    const labels = {
      ...(await labelsFor(this.db, new Schema(this.db), ids((f) => f.type === "link"))),
      ...(await userNames(this.db, ids((f) => USER_TYPES.has(f.type)))),
    };
    const userIds = ids((f) => USER_TYPES.has(f.type));
    const emails = userIds.length
      ? Object.fromEntries((await this.db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1::text[])`, [userIds])).map((u) => [u.id, u.email]))
      : {};
    const table = await this.db.one<{ primary_field_id: string; base_id: string; name: string }>(
      `SELECT primary_field_id, base_id, name FROM tables WHERE id=$1`, [tableId],
    );
    const primary = fields.find((f) => f.id === table!.primary_field_id);
    return {
      rec, fields, labels, emails, baseId: table!.base_id, tableName: table!.name,
      name: primary ? cellToText(primary, rec.cells[primary.id] ?? null, labels) : "",
    };
  }

  /** Fill {Field name} tokens from the record. In "emails" mode people fields give email addresses. */
  private render(template: string, ctx: NonNullable<Awaited<ReturnType<AutomationEngine["context"]>>>, mode: "text" | "emails" = "text") {
    return template.replace(/\{([^{}]+)\}/g, (whole, raw: string) => {
      const name = raw.trim().toLowerCase();
      if (name === "record id") return ctx.rec.id;
      if (name === "record url") return `${this.opts.appUrl}/base/${ctx.baseId}/${ctx.rec.table_id}`;
      const f = ctx.fields.find((x) => x.name.toLowerCase() === name);
      if (!f) return whole;
      const v = ctx.rec.cells[f.id] ?? null;
      if (mode === "emails" && USER_TYPES.has(f.type)) return ((v as string[] | null) ?? []).map((id) => ctx.emails[id] ?? "").join(", ");
      return cellToText(f, v, ctx.labels);
    });
  }

  private async exec(
    a: Row, trigger: Trigger, action: Action, ctx: NonNullable<Awaited<ReturnType<AutomationEngine["context"]>>>, depth: number,
  ): Promise<string> {
    const userId = a.created_by;
    const rendered = (fields: Record<string, string>) =>
      Object.fromEntries(Object.entries(fields).map(([fid, tpl]) => {
        const s = this.render(tpl, ctx).trim();
        return [fid, s === "" ? null : s];
      }));
    switch (action.type) {
      case "updateRecord": {
        const input = rendered(action.fields);
        if (!Object.keys(input).length) return "Nothing to change";
        const changed = await this.db.tx(async (t) => {
          const fields = await loadFields(t, trigger.tableId);
          const typed = await typecastCells(t, trigger.tableId, fields, input, { dateOrder: "dmy", userId: userId ?? "" });
          const cells = await prepareCells(t, trigger.tableId, typed);
          await writeCells(t, new Schema(t), userId, trigger.tableId, ctx.rec.id, cells);
          return Object.keys(cells);
        });
        this.announce(ctx.baseId, trigger.tableId, ctx.rec.id);
        this.recordChanged({ tableId: trigger.tableId, recordId: ctx.rec.id, kind: "updated", fieldIds: changed, depth: depth + 1, sourceAutomationId: a.id });
        const names = changed.map((id) => ctx.fields.find((f) => f.id === id)?.name).filter(Boolean);
        return `Updated ${names.join(", ") || "the record"}`;
      }
      case "createRecord": {
        const target = await this.db.one<{ base_id: string; name: string }>(`SELECT base_id, name FROM tables WHERE id=$1`, [action.tableId]);
        if (!target || target.base_id !== ctx.baseId) throw new Error("The table to create the record in no longer exists");
        const input = rendered(action.fields);
        const id = newId("rec");
        const changed = await this.db.tx(async (t) => {
          const fields = await loadFields(t, action.tableId);
          const typed = await typecastCells(t, action.tableId, fields, input, { dateOrder: "dmy", userId: userId ?? "" });
          const cells = await prepareCells(t, action.tableId, typed, { create: true });
          await t.query(`INSERT INTO records (id, table_id, cells, created_by, updated_by) VALUES ($1,$2,'{}',$3,$3)`, [id, action.tableId, userId]);
          const schema = new Schema(t);
          await writeCells(t, schema, userId, action.tableId, id, cells, "create");
          await computeAllForRecord(t, schema, action.tableId, id);
          return Object.keys(cells);
        });
        this.announce(ctx.baseId, action.tableId, id);
        this.recordChanged({ tableId: action.tableId, recordId: id, kind: "created", fieldIds: changed, depth: depth + 1, sourceAutomationId: a.id });
        return `Created a record in ${target.name}`;
      }
      case "sendEmail": {
        const to = [...new Set(this.render(action.to, ctx, "emails").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s)))];
        if (!to.length) throw new Error("No valid email address in To");
        if (to.length > MAX_RECIPIENTS) throw new Error(`Too many recipients (at most ${MAX_RECIPIENTS})`);
        const subject = this.render(action.subject, ctx).replace(/[\r\n]+/g, " ").slice(0, 300) || "(no subject)";
        const body = this.render(action.body, ctx);
        // Each line of the message becomes a paragraph (emails would otherwise run lines together).
        const content = layout(subject, body.split(/\n+/).map((p) => p.trim()).filter(Boolean), {
          label: `Open ${ctx.tableName}`, url: this.render("{Record URL}", ctx),
        }, "Sent by a Brill Tables automation.");
        for (const addr of to) await this.opts.mailer.send({ to: addr, subject, ...content });
        return `Emailed ${to.join(", ")}`;
      }
      case "webhook": {
        const payload = {
          automation: { id: a.id, name: a.name },
          baseId: ctx.baseId,
          table: { id: trigger.tableId, name: ctx.tableName },
          record: {
            id: ctx.rec.id,
            fields: Object.fromEntries(ctx.fields.map((f) => [f.name, cellToText(f, ctx.rec.cells[f.id] ?? null, ctx.labels)])),
          },
          sentAt: new Date().toISOString(),
        };
        const status = await postJson(action.url, payload, !!this.opts.allowLoopbackWebhooks);
        if (status >= 400) throw new Error(`The webhook answered ${status}`);
        return `Webhook answered ${status}`;
      }
    }
  }

  /** Tell people looking at the base (live updates). */
  private announce(baseId: string, tableId: string, recordId: string) {
    bus.emit(`base:${baseId}`, { scope: "records", baseId, tableId, recordId, userId: "automation" });
  }
}

/** POST JSON to an outside address — never to private or local networks; no redirects; 10 s limit. */
function postJson(url: string, body: unknown, allowLoopback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("That webhook URL isn't valid")); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return reject(new Error("Webhooks must use http or https"));
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "POST",
      lookup: makeLookup(allowLoopback) as any,
      timeout: 10_000,
      headers: { "content-type": "application/json", "content-length": data.length, "user-agent": "BrillTables-Automations/1.0" },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("The webhook didn't answer within 10 seconds")));
    req.on("error", (e) => reject(new Error(e.message.includes("isn't allowed") ? e.message : `Couldn't reach the webhook (${e.message})`)));
    req.end(data);
  });
}

// ---------------- API ----------------
const nameSchema = z.string().trim().min(1).max(120);
const bodySchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  trigger: triggerSchema.optional(),
  actions: z.array(actionSchema).max(10).optional(),
});

export function registerAutomations(app: FastifyInstance, db: Db) {
  const engine = app.automations;

  /** Creators and owners of the workspace manage automations (not people invited to just the base). */
  async function manage(userId: string, baseId: string) {
    const a = await baseAccess(db, userId, baseId, "creator");
    if (a.guest) throw new HttpError(403, "Only the workspace's creators and owners can manage automations");
  }
  async function own(userId: string, automationId: string) {
    const a = await db.one<Row>(`SELECT * FROM automations WHERE id=$1`, [automationId]);
    if (!a) throw new HttpError(404, "Not found");
    await manage(userId, a.base_id);
    return a;
  }
  /** Tables, form views and fields an automation refers to must be in its base. */
  async function validate(baseId: string, trigger: Trigger | undefined, actions: Action[] | undefined) {
    const tables = new Set((await db.query<{ id: string }>(`SELECT id FROM tables WHERE base_id=$1`, [baseId])).map((r) => r.id));
    if (trigger) {
      if (!tables.has(trigger.tableId)) throw new HttpError(400, "Choose a table in this base");
      if (trigger.type === "formSubmitted") {
        const v = await db.one(`SELECT 1 FROM views WHERE id=$1 AND table_id=$2 AND type='form'`, [trigger.viewId ?? "", trigger.tableId]);
        if (!v) throw new HttpError(400, "Choose a form in that table");
      }
    }
    for (const act of actions ?? []) {
      if (act.type === "createRecord" && !tables.has(act.tableId)) throw new HttpError(400, "Create a record: choose a table in this base");
    }
  }
  const toApi = (r: Row & { last_status?: string | null; last_at?: string | null }) => ({
    id: r.id, baseId: r.base_id, name: r.name, enabled: r.enabled,
    trigger: triggerSchema.parse(r.trigger), actions: z.array(actionSchema).parse(r.actions),
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    lastRun: r.last_at ? { status: r.last_status, at: new Date(r.last_at).toISOString() } : null,
  });

  app.get("/api/bases/:baseId/automations", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await manage(user.id, baseId);
    const rows = await db.query(
      `SELECT a.*, l.status AS last_status, l.started_at AS last_at FROM automations a
       LEFT JOIN LATERAL (SELECT status, started_at FROM automation_runs r WHERE r.automation_id = a.id AND NOT r.test ORDER BY started_at DESC LIMIT 1) l ON true
       WHERE a.base_id=$1 ORDER BY a.created_at`,
      [baseId],
    );
    return { automations: rows.map(toApi) };
  });

  app.post("/api/bases/:baseId/automations", async (req) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await manage(user.id, baseId);
    const body = bodySchema.extend({ trigger: triggerSchema }).parse(req.body);
    await validate(baseId, body.trigger, body.actions);
    const row = await db.one<Row>(
      `INSERT INTO automations (id, base_id, name, enabled, trigger, actions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [newId("aut"), baseId, body.name ?? "Untitled automation", body.enabled ?? false, body.trigger, JSON.stringify(body.actions ?? []), user.id],
    );
    await engine.resetMatches(row!.id);
    return { automation: toApi(row!) };
  });

  app.patch("/api/automations/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const cur = await own(user.id, id);
    const body = bodySchema.parse(req.body);
    await validate(cur.base_id, body.trigger, body.actions);
    const row = await db.one<Row>(
      `UPDATE automations SET name=COALESCE($2,name), enabled=COALESCE($3,enabled), trigger=COALESCE($4,trigger),
         actions=COALESCE($5,actions), updated_at=now() WHERE id=$1 RETURNING *`,
      [id, body.name ?? null, body.enabled ?? null, body.trigger ?? null, body.actions ? JSON.stringify(body.actions) : null],
    );
    if (body.trigger || body.enabled !== undefined) await engine.resetMatches(id);
    return { automation: toApi(row!) };
  });

  app.delete("/api/automations/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await own(user.id, id);
    await db.query(`DELETE FROM automations WHERE id=$1`, [id]);
    return { ok: true };
  });

  app.get("/api/automations/:id/runs", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await own(user.id, id);
    const rows = await db.query<any>(`SELECT * FROM automation_runs WHERE automation_id=$1 ORDER BY started_at DESC LIMIT 50`, [id]);
    return {
      runs: rows.map((r): AutomationRun => ({
        id: r.id, automationId: r.automation_id, recordId: r.record_id, recordName: r.record_name ?? "", status: r.status,
        steps: r.steps, test: r.test, startedAt: new Date(r.started_at).toISOString(),
      })),
    };
  });

  /** Run the actions now on one record (the latest one if none is given), whatever the trigger. */
  app.post("/api/automations/:id/test", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await own(user.id, id);
    const { recordId } = z.object({ recordId: z.string().optional() }).parse(req.body ?? {});
    const trigger = triggerSchema.parse(a.trigger);
    const rec = recordId
      ? await db.one<{ id: string }>(`SELECT id FROM records WHERE id=$1 AND table_id=$2 AND deleted_at IS NULL`, [recordId, trigger.tableId])
      : await db.one<{ id: string }>(`SELECT id FROM records WHERE table_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [trigger.tableId]);
    if (!rec) throw new HttpError(400, "Add a record to the table first, then test");
    return { run: await engine.testRun(id, rec.id) };
  });
}
