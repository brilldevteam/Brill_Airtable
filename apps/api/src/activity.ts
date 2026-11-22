import { newId, type CellValue } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordTableId, tableAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { attachmentInfos } from "./files";
import { labelsFor, Schema } from "./links";
import { addNotifications, mentionedIds } from "./notifications";

/** Record comments and change history, shown together in the record's activity panel. */
export function registerActivity(app: FastifyInstance, db: Db) {
  app.get("/api/records/:recordId/comments", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    await tableAccess(db, user.id, await recordTableId(db, recordId), "read");
    const rows = await db.query(
      `SELECT c.id, c.body, c.created_at AS "createdAt", c.user_id AS "userId", u.name AS "userName"
       FROM record_comments c JOIN users u ON u.id = c.user_id WHERE c.record_id=$1 ORDER BY c.created_at`,
      [recordId],
    );
    return { comments: rows.map((c: any) => ({ ...c, createdAt: new Date(c.createdAt).toISOString() })) };
  });

  app.post("/api/records/:recordId/comments", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    await tableAccess(db, user.id, await recordTableId(db, recordId), "commenter");
    const c = await db.one(
      `INSERT INTO record_comments (id, record_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [newId("cmt"), recordId, user.id, body],
    );
    const mentioned = mentionedIds(body);
    if (mentioned.length) {
      await addNotifications(db, mentioned, {
        kind: "mention", tableId: await recordTableId(db, recordId), recordId, actorId: user.id, data: { comment: body.slice(0, 500) },
      });
    }
    return { comment: { id: c.id, body, createdAt: new Date(c.created_at).toISOString(), userId: user.id, userName: user.name } };
  });

  app.delete("/api/record-comments/:commentId", async (req) => {
    const user = requireUser(req);
    const { commentId } = req.params as { commentId: string };
    const c = await db.one(`SELECT * FROM record_comments WHERE id=$1`, [commentId]);
    if (!c) throw new HttpError(404, "Not found");
    await tableAccess(db, user.id, await recordTableId(db, c.record_id), "read");
    if (c.user_id !== user.id) throw new HttpError(403, "You can only delete your own comments");
    await db.query(`DELETE FROM record_comments WHERE id=$1`, [commentId]);
    return { ok: true };
  });

  /** Change history, newest first, with names for any linked records / files mentioned. */
  app.get("/api/records/:recordId/history", async (req) => {
    const user = requireUser(req);
    const { recordId } = req.params as { recordId: string };
    await tableAccess(db, user.id, await recordTableId(db, recordId), "read");
    const rows = await db.query(
      `SELECT h.id, h.kind, h.changes, h.created_at AS "createdAt", h.user_id AS "userId", u.name AS "userName"
       FROM record_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.record_id=$1 ORDER BY h.id DESC LIMIT 200`,
      [recordId],
    );
    // Collect ids that might be linked records or attachments, to show names.
    const ids = new Set<string>();
    for (const r of rows) {
      for (const ch of Object.values(r.changes as Record<string, { from: CellValue; to: CellValue }>)) {
        for (const v of [ch.from, ch.to]) if (Array.isArray(v)) v.forEach((x) => ids.add(String(x)));
      }
    }
    const labels = await labelsFor(db, new Schema(db), [...ids].filter((x) => x.startsWith("rec")));
    const files = await attachmentInfos(db, [...ids].filter((x) => x.startsWith("att")));
    for (const f of Object.values(files)) labels[f.id] = f.filename;
    return {
      entries: rows.map((r: any) => ({ ...r, id: String(r.id), createdAt: new Date(r.createdAt).toISOString() })),
      labels,
    };
  });
}
