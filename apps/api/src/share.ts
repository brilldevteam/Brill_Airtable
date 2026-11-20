import {
  FORM_FIELD_TYPES,
  newId,
  normalizeCell,
  orderedFieldIds,
  viewConfigSchema,
  CellValidationError,
  type CellValue,
  type Field,
} from "@brill/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tableAccess, viewTableId } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { limiter } from "./rateLimit";
import { streamAttachment, type SaveFile } from "./files";
import { computeAllForRecord, Schema, writeCells } from "./links";
import { bus } from "./realtime";
import { displayData, loadFields, prepareCells, toRecord } from "./routes";
import { buildViewQuery } from "./viewQuery";

/**
 * Public share links — no sign-in needed:
 *  - a form view's link shows the form and creates a record per submission
 *  - any other view's link shows that view read-only (only its visible fields, with its filters)
 * The token in the link is the only key, so it's long and random; regenerating it kills the old link.
 */

const newToken = () => randomBytes(18).toString("base64url");

const submitLimit = limiter(20, 10 * 60_000, "Too many submissions — please wait a few minutes and try again");
const uploadLimit = limiter(40, 10 * 60_000, "Too many uploads — please wait a few minutes and try again");
const clientKey = (req: FastifyRequest, token: string) => `${req.ip}|${token}`;

interface Share { id: string; view_id: string; token: string; enabled: boolean }

export function registerShare(app: FastifyInstance, db: Db, files: { saveFile: SaveFile; pathOf: (id: string, thumb?: boolean) => string }) {
  // ---------------- managing links (signed in, creators+) ----------------
  app.get("/api/views/:viewId/share", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    await tableAccess(db, user.id, await viewTableId(db, viewId), "read");
    const s = await db.one<Share>(`SELECT * FROM share_links WHERE view_id=$1`, [viewId]);
    return { share: s ? { token: s.token, enabled: s.enabled } : null };
  });

  /** Turn the link on (creating it if needed), or regenerate it. */
  app.post("/api/views/:viewId/share", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    const { regenerate } = z.object({ regenerate: z.boolean().default(false) }).parse(req.body ?? {});
    await tableAccess(db, user.id, await viewTableId(db, viewId), "creator");
    const existing = await db.one<Share>(`SELECT * FROM share_links WHERE view_id=$1`, [viewId]);
    if (!existing) {
      const token = newToken();
      await db.query(`INSERT INTO share_links (id, view_id, token, created_by) VALUES ($1,$2,$3,$4)`, [newId("shr"), viewId, token, user.id]);
      return { share: { token, enabled: true } };
    }
    const token = regenerate ? newToken() : existing.token;
    await db.query(`UPDATE share_links SET token=$2, enabled=true WHERE id=$1`, [existing.id, token]);
    return { share: { token, enabled: true } };
  });

  app.delete("/api/views/:viewId/share", async (req) => {
    const user = requireUser(req);
    const { viewId } = req.params as { viewId: string };
    await tableAccess(db, user.id, await viewTableId(db, viewId), "creator");
    await db.query(`UPDATE share_links SET enabled=false WHERE view_id=$1`, [viewId]);
    return { ok: true };
  });

  // ---------------- public side ----------------
  async function shared(token: string) {
    const row = await db.one(
      `SELECT s.id AS share_id, s.enabled, v.*, t.name AS table_name, t.primary_field_id, t.base_id, b.name AS base_name, b.color AS base_color
       FROM share_links s JOIN views v ON v.id = s.view_id JOIN tables t ON t.id = v.table_id JOIN bases b ON b.id = t.base_id
       WHERE s.token=$1`,
      [token],
    );
    if (!row || !row.enabled) throw new HttpError(404, "This link isn't active. Ask the person who shared it for a new one.");
    return { ...row, config: viewConfigSchema.parse(row.config ?? {}) };
  }

  /** The form's fields, in order, limited to what a public form may contain. */
  async function formFields(view: any) {
    const all = await loadFields(db, view.table_id);
    const byId = new Map(all.map((f) => [f.id, f]));
    return (view.config.form.fields as { fieldId: string; required: boolean; label: string; help: string }[])
      .map((ff) => ({ ff, field: byId.get(ff.fieldId) }))
      .filter((x): x is { ff: typeof x.ff; field: Field } => !!x.field && FORM_FIELD_TYPES.has(x.field.type));
  }

  app.get("/api/public/forms/:token", async (req) => {
    const { token } = req.params as { token: string };
    const view = await shared(token);
    if (view.type !== "form") throw new HttpError(404, "This link isn't a form");
    const f = view.config.form;
    return {
      base: { name: view.base_name, color: view.base_color },
      form: {
        title: f.title || view.table_name,
        description: f.description,
        submitText: f.submitText,
        successMessage: f.successMessage,
        allowAnother: f.allowAnother,
        fields: (await formFields(view)).map(({ ff, field }) => ({
          id: field.id,
          type: field.type,
          label: ff.label || field.name,
          help: ff.help,
          required: ff.required,
          // Only what's needed to draw the input — never other records.
          options: {
            choices: field.options.choices,
            precision: field.options.precision,
            includeTime: field.options.includeTime,
            symbol: field.options.symbol,
            max: field.options.max,
            durationFormat: field.options.durationFormat,
          },
        })),
      },
    };
  });

  /** Upload a file for a form answer. It can only be used in a submission to the same form. */
  app.post("/api/public/forms/:token/attachments", async (req) => {
    const { token } = req.params as { token: string };
    const view = await shared(token);
    if (view.type !== "form") throw new HttpError(404, "This link isn't a form");
    if (!(await formFields(view)).some(({ field }) => field.type === "attachment")) throw new HttpError(400, "This form doesn't take files");
    uploadLimit(clientKey(req, token));
    if (!req.isMultipart()) throw new HttpError(415, "Send files as multipart/form-data");
    const saved = [];
    for await (const part of req.files({ limits: { files: 10 } })) {
      saved.push(await files.saveFile(view.table_id, null, part.filename, part.mimetype, part.file, view.share_id));
    }
    if (!saved.length) throw new HttpError(400, "No files were sent");
    // Only return what the form page needs (no internal URLs — the uploader can't open files back).
    return { attachments: saved.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mime: a.mime })) };
  });

  app.post("/api/public/forms/:token/submit", async (req) => {
    const { token } = req.params as { token: string };
    const { cells: input } = z.object({ cells: z.record(z.unknown()) }).parse(req.body);
    const view = await shared(token);
    if (view.type !== "form") throw new HttpError(404, "This link isn't a form");
    submitLimit(clientKey(req, token));

    const fields = await formFields(view);
    const allowed = new Map(fields.map((x) => [x.field.id, x]));
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new HttpError(400, "The form has changed — please reload the page");

    const cells: Record<string, CellValue> = {};
    const problems: string[] = [];
    for (const { ff, field } of fields) {
      let v: CellValue = null;
      try {
        v = normalizeCell(field, input[field.id] ?? null);
      } catch (e) {
        if (e instanceof CellValidationError) problems.push(`${ff.label || field.name}: ${e.message.split(": ").slice(1).join(": ")}`);
        else throw e;
      }
      if (ff.required && (v === null || (Array.isArray(v) && v.length === 0))) problems.push(`${ff.label || field.name} is required`);
      if (field.type === "attachment" && Array.isArray(v) && v.length) {
        // Files must have been uploaded through this form and not used yet.
        const ok = await db.query(
          `SELECT id FROM attachments a WHERE a.id = ANY($1::text[]) AND a.share_id=$2 AND a.table_id=$3
           AND NOT EXISTS (SELECT 1 FROM records r WHERE r.table_id=$3 AND r.cells ? $4 AND r.cells->$4 ? a.id)`,
          [v, view.share_id, view.table_id, field.id],
        );
        if (ok.length !== v.length) problems.push(`${ff.label || field.name}: please upload the files again`);
      }
      if (v !== null) cells[field.id] = v;
    }
    if (problems.length) throw new HttpError(422, problems.join(". "));

    const id = await db.tx(async (t) => {
      const recId = newId("rec");
      await t.query(`INSERT INTO records (id, table_id, cells) VALUES ($1,$2,'{}')`, [recId, view.table_id]);
      const schema = new Schema(t);
      const prepared = await prepareCells(t, view.table_id, cells);
      await writeCells(t, schema, null, view.table_id, recId, prepared, "create"); // no user: submitted by the public
      await computeAllForRecord(t, schema, view.table_id, recId);
      return recId;
    });
    bus.emit(`base:${view.base_id}`, { scope: "records", baseId: view.base_id, tableId: view.table_id, recordId: id, userId: "public-form" });
    return { ok: true };
  });

  /** A read-only shared view: only its visible fields, with its filters and sorts. */
  app.get("/api/public/views/:token", async (req) => {
    const { token } = req.params as { token: string };
    const view = await shared(token);
    if (view.type === "form") throw new HttpError(404, "This link is a form");
    const all = await loadFields(db, view.table_id);
    const hidden = new Set(view.config.hiddenFieldIds);
    const visible = orderedFieldIds(view.config, all.map((f) => f.id), view.primary_field_id)
      .filter((id) => id === view.primary_field_id || !hidden.has(id))
      .map((id) => all.find((f) => f.id === id)!)
      .filter(Boolean);
    const visibleIds = new Set(visible.map((f) => f.id));
    const { sql, params } = buildViewQuery(view.table_id, all, view.config);
    const records = (await db.query(sql, params)).map(toRecord).map((r) => ({
      id: r.id,
      // Strip hidden fields so they never leave the server.
      cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => visibleIds.has(k))),
    }));
    const { labels, files: info } = await displayData(db, visible, records as any);
    const publicFiles = Object.fromEntries(
      Object.values(info).map((a) => {
        const base = `/api/public/views/${token}/files/${a.id}/${encodeURIComponent(a.filename)}`;
        return [a.id, { ...a, url: base, thumbUrl: a.thumbUrl ? `${base}?thumb=1` : null }];
      }),
    );
    return {
      base: { name: view.base_name, color: view.base_color },
      table: { name: view.table_name, primaryFieldId: view.primary_field_id },
      view: {
        name: view.name,
        type: view.type,
        config: {
          coverFieldId: view.config.coverFieldId, coverFit: view.config.coverFit, cardSize: view.config.cardSize,
          stackFieldId: view.config.stackFieldId, dateFieldId: view.config.dateFieldId,
        },
      },
      fields: visible,
      records,
      labels,
      files: publicFiles,
    };
  });

  /** Files shown in a shared view (only from its visible attachment fields). */
  app.get("/api/public/views/:token/files/:id/:name", async (req, reply) => {
    const { token, id } = req.params as { token: string; id: string };
    const q = req.query as { thumb?: string; download?: string };
    const view = await shared(token);
    if (view.type === "form") throw new HttpError(404, "Not found");
    const row = await db.one(`SELECT * FROM attachments WHERE id=$1 AND table_id=$2`, [id, view.table_id]);
    if (!row) throw new HttpError(404, "Not found");
    const hidden = new Set(view.config.hiddenFieldIds);
    const attFields = (await loadFields(db, view.table_id)).filter((f) => f.type === "attachment" && !hidden.has(f.id));
    let used = false;
    for (const f of attFields) {
      if (await db.one(`SELECT 1 FROM records WHERE table_id=$1 AND deleted_at IS NULL AND cells->$2 ? $3 LIMIT 1`, [view.table_id, f.id, id])) {
        used = true;
        break;
      }
    }
    if (!used) throw new HttpError(404, "Not found");
    if (q.thumb === "1" && !row.has_thumb) throw new HttpError(404, "No thumbnail");
    return streamAttachment(row, q.thumb === "1", q.download === "1", req, reply, files.pathOf);
  });
}
