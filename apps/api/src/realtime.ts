import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { baseAccess } from "./access";
import { requireUser } from "./auth";
import type { Db } from "./db";

/**
 * Live updates. After any successful change, everyone viewing the same base gets a small
 * event over Server-Sent Events ("records in table X changed") and refetches what they show.
 * Events carry ids only, never data — the refetch goes through the normal permission checks.
 *
 * The bus is in-memory, which is right for one server process. Running several API processes
 * later means swapping this for Redis pub/sub.
 */

export type ChangeScope = "records" | "schema" | "views" | "comments";
export interface ChangeEvent {
  scope: ChangeScope;
  baseId: string;
  tableId?: string;
  recordId?: string;
  /** Browser tab that made the change (it already shows it, so it ignores its own events). */
  clientId?: string;
  userId: string;
}

export const bus = new EventEmitter();
bus.setMaxListeners(0);

declare module "fastify" {
  interface FastifyRequest {
    changeTarget?: { baseId: string; tableId?: string; recordId?: string; scope: ChangeScope };
  }
}

/** Work out which base / table a mutating request touches, from its URL params (before it runs). */
async function resolveTarget(db: Db, req: FastifyRequest): Promise<FastifyRequest["changeTarget"]> {
  const p = req.params as Record<string, string>;
  const url = req.routeOptions.url ?? req.url;
  const scope: ChangeScope =
    /comments/.test(url) ? "comments" : /\/views/.test(url) ? "views" : /\/(fields|bases\/:baseId$|bases\/:baseId\/tables|tables\/:tableId$)/.test(url) ? "schema" : "records";

  let tableId: string | undefined;
  let recordId: string | undefined = p.recordId;
  if (p.tableId) tableId = p.tableId;
  else if (p.recordId) tableId = (await db.one(`SELECT table_id FROM records WHERE id=$1`, [p.recordId]))?.table_id;
  else if (p.fieldId) tableId = (await db.one(`SELECT table_id FROM fields WHERE id=$1`, [p.fieldId]))?.table_id;
  else if (p.viewId) tableId = (await db.one(`SELECT table_id FROM views WHERE id=$1`, [p.viewId]))?.table_id;
  else if (p.id && url.startsWith("/api/attachments")) tableId = (await db.one(`SELECT table_id FROM attachments WHERE id=$1`, [p.id]))?.table_id;
  else if (p.commentId && url.startsWith("/api/record-comments")) {
    const r = await db.one(`SELECT r.id, r.table_id FROM record_comments c JOIN records r ON r.id = c.record_id WHERE c.id=$1`, [p.commentId]);
    tableId = r?.table_id;
    recordId = r?.id;
  }
  const baseId = p.baseId ?? (tableId ? (await db.one(`SELECT base_id FROM tables WHERE id=$1`, [tableId]))?.base_id : undefined);
  return baseId ? { baseId, tableId, recordId, scope } : undefined;
}

export function registerRealtime(app: FastifyInstance, db: Db) {
  app.addHook("preHandler", async (req) => {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method) || !req.url.startsWith("/api/") || req.url.startsWith("/api/auth")) return;
    try {
      req.changeTarget = await resolveTarget(db, req);
    } catch {
      // Never block a request because of live updates.
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const t = req.changeTarget;
    if (!t || reply.statusCode >= 400 || !req.user) return;
    const header = req.headers["x-client-id"];
    const event: ChangeEvent = { ...t, userId: req.user.id, clientId: typeof header === "string" ? header.slice(0, 64) : undefined };
    bus.emit(`base:${t.baseId}`, event);
  });

  /** The event stream for one base. */
  app.get("/api/bases/:baseId/events", async (req, reply) => {
    const user = requireUser(req);
    const { baseId } = req.params as { baseId: string };
    await baseAccess(db, user.id, baseId, "read");

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const send = (e: ChangeEvent) => {
      const { userId, ...rest } = e;
      res.write(`data: ${JSON.stringify({ ...rest, byMe: userId === user.id })}\n\n`);
    };
    const channel = `base:${baseId}`;
    bus.on(channel, send);
    // Comments keep proxies from closing an idle connection.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      bus.off(channel, send);
    });
  });
}
