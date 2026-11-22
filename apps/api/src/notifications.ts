import { newId } from "@brill/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";
import { layout, type Mailer } from "./mail";

/**
 * In-app notifications (the bell), also sent by email:
 *  - "mention":  someone @mentioned you in a record's comments
 *  - "assigned": you were added to a person field that notifies (e.g. Assignee)
 * Rows are written in the same transaction as the change that caused them; a small background
 * loop emails what hasn't been emailed yet, so a slow mail provider never slows an edit down.
 */

export type NotificationKind = "mention" | "assigned";

/** Queue notifications for people (never for the person who did it). */
export async function addNotifications(
  db: Db, userIds: string[],
  n: { kind: NotificationKind; tableId: string; recordId: string; actorId: string | null; data: Record<string, string> },
) {
  const to = [...new Set(userIds)].filter((id) => id && id !== n.actorId);
  if (!to.length) return;
  const t = await db.one<{ base_id: string }>(`SELECT base_id FROM tables WHERE id=$1`, [n.tableId]);
  if (!t) return;
  for (const userId of to) {
    // Only people who can open the base (workspace members or invited to it, e.g. clients).
    const ok = await db.one(
      `SELECT 1 FROM bases b WHERE b.id=$2 AND (
         EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=b.workspace_id AND m.user_id=$1)
         OR EXISTS (SELECT 1 FROM base_members bm WHERE bm.base_id=b.id AND bm.user_id=$1))`,
      [userId, t.base_id],
    );
    if (!ok) continue;
    await db.query(
      `INSERT INTO notifications (id, user_id, kind, base_id, table_id, record_id, actor_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId("ntf"), userId, n.kind, t.base_id, n.tableId, n.recordId, n.actorId, n.data],
    );
  }
}

/** "@[Quinn QA](usrAbc…)" tokens in a comment → the user ids. */
export function mentionedIds(body: string): string[] {
  return [...body.matchAll(/@\[[^\]\n]{1,100}\]\((usr[A-Za-z0-9]{6,30})\)/g)].map((m) => m[1]);
}
/** The comment as plain text, mentions shown as "@Name". */
export const plainComment = (body: string) => body.replace(/@\[([^\]\n]{1,100})\]\(usr[A-Za-z0-9]{6,30}\)/g, "@$1");

interface Row {
  id: string; kind: NotificationKind; data: Record<string, string>; created_at: string; read_at: string | null;
  base_id: string; table_id: string; record_id: string; base_name: string; table_name: string; record_name: string | null; actor_name: string | null;
}
const SELECT = `SELECT n.id, n.kind, n.data, n.created_at, n.read_at, n.base_id, n.table_id, n.record_id,
    b.name AS base_name, t.name AS table_name, r.cells->>t.primary_field_id AS record_name, u.name AS actor_name
  FROM notifications n JOIN bases b ON b.id=n.base_id JOIN tables t ON t.id=n.table_id
  LEFT JOIN records r ON r.id=n.record_id LEFT JOIN users u ON u.id=n.actor_id`;

function describe(r: Row) {
  const who = r.actor_name ?? "Someone";
  const rec = r.record_name || "a record";
  const title = r.kind === "mention" ? `${who} mentioned you on “${rec}”` : `${who} added you to “${rec}”`;
  const body = r.kind === "mention" ? plainComment(r.data.comment ?? "") : `${r.data.field ?? "A person field"} · ${r.table_name}`;
  return { title, body };
}
const linkOf = (r: Pick<Row, "base_id" | "table_id" | "record_id">) => `/base/${r.base_id}/${r.table_id}?record=${r.record_id}`;

export function registerNotifications(app: FastifyInstance, db: Db, opts: { mailer: Mailer; appUrl: string }) {
  app.get("/api/notifications", async (req) => {
    const user = requireUser(req);
    const rows = await db.query<Row>(`${SELECT} WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`, [user.id]);
    const unread = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [user.id]);
    return {
      unread: unread?.n ?? 0,
      notifications: rows.map((r) => ({
        id: r.id, kind: r.kind, ...describe(r), baseName: r.base_name, link: linkOf(r),
        read: !!r.read_at, createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  });

  /** Mark some (or all) as read. */
  app.post("/api/notifications/read", async (req) => {
    const user = requireUser(req);
    const body = z.object({ ids: z.array(z.string()).max(200).optional() }).parse(req.body ?? {});
    if (body.ids) await db.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2) AND read_at IS NULL`, [user.id, body.ids]);
    else await db.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [user.id]);
    return { ok: true };
  });

  // Email what hasn't been emailed (recent ones only, in case the server was down a while).
  let busy = false;
  const sendPending = async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = await db.query<Row & { email: string; user_name: string; user_id: string }>(
        `${SELECT.replace("SELECT n.id,", "SELECT n.user_id, ru.email, ru.name AS user_name, n.id,")} JOIN users ru ON ru.id=n.user_id
         WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND n.created_at > now() - interval '1 day' ORDER BY n.created_at LIMIT 50`,
      );
      for (const r of rows) {
        await db.query(`UPDATE notifications SET emailed_at=now() WHERE id=$1`, [r.id]);
        // Still allowed to see it? (They may have been removed since.)
        const allowed = await baseAccess(db, r.user_id, r.base_id, "read").then(() => true, () => false);
        if (!allowed) continue;
        const { title, body } = describe(r);
        const url = (opts.appUrl || "") + linkOf(r);
        await opts.mailer.send({
          to: r.email,
          subject: title,
          ...layout(title, [body, `In ${r.base_name} › ${r.table_name}.`].filter(Boolean), { label: "Open the record", url },
            "You're getting this because someone mentioned you or added you to a record in Brill Tables."),
        }).catch((e) => app.log.warn(e, "notification email failed"));
      }
    } catch (e) {
      app.log.warn(e, "notification emails");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void sendPending(), 15_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  app.decorate("sendPendingNotifications", sendPending);
}

declare module "fastify" {
  interface FastifyInstance { sendPendingNotifications: () => Promise<void> }
}
