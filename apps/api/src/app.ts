import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { registerAuth } from "./auth";
import { logMailer, type Mailer } from "./mail";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { MAX_FILE_BYTES, registerFiles } from "./files";
import { registerActivity } from "./activity";
import { registerImportExport } from "./importExport";
import { registerAirtableImport, type AirtableImportOptions } from "./airtableImport";
import { registerBaseLogos } from "./baseLogos";
import { registerNotifications } from "./notifications";
import { registerMembers } from "./members";
import { registerRealtime } from "./realtime";
import { registerRoutes } from "./routes";
import { registerShare } from "./share";
import { registerTrash } from "./trash";
import { AutomationEngine, registerAutomations } from "./automations";
import { registerDashboards } from "./dashboards";
import { registerWebApp } from "./webApp";

export interface AppOptions {
  secureCookies?: boolean;
  logger?: boolean;
  /** Folder for uploaded files. */
  filesDir: string;
  /** Trust X-Forwarded-For from a reverse proxy (true, a hop count, or a list of proxy IPs). */
  trustProxy?: boolean | number | string;
  /** Outgoing email. Defaults to a quiet in-memory outbox (tests). */
  mailer?: Mailer;
  /** Public address of the web app, used in email links. */
  appUrl?: string;
  /** Expose the dev outbox at GET /api/dev/mail (never in production). */
  devMail?: boolean;
  /** Tests only: let automation webhooks call localhost. */
  allowLoopbackWebhooks?: boolean;
  /** Production: serve the built web app (apps/web/dist) from this folder. */
  webDir?: string;
  /** "open" (anyone can sign up) or "invite" (only the first account and people with an invite). */
  signups?: "open" | "invite";
  /**
   * Origins allowed to show the app in a frame (e.g. a mobile app wrapper using an iframe),
   * like "https://app.example.com". Empty: the app can't be framed. When set, the session
   * cookie becomes SameSite=None; Secure; Partitioned so it also works inside that frame.
   */
  embedOrigins?: string[];
  /** Importing from Airtable (tests point it at a stand-in API). */
  airtable?: AirtableImportOptions;
}

export function buildApp(db: Db, opts: AppOptions) {
  const mailer = opts.mailer ?? logMailer({ quiet: true });
  const appUrl = (opts.appUrl ?? "http://localhost:5180").replace(/\/+$/, "");
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    // Behind a reverse proxy (nginx, Caddy, a load balancer) set TRUST_PROXY so req.ip is the visitor's address.
    trustProxy: opts.trustProxy ?? false,
    genReqId: () => randomUUID(),
  });

  // Security headers on every API response. Attachment downloads set their own stricter CSP.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    // Attachments may be previewed (PDFs) inside the app's own pages; nothing else may be framed.
    const file = req.url.includes("/attachments/") || req.url.includes("/files/");
    const embedding = (opts.embedOrigins?.length ?? 0) > 0;
    const page = !req.url.startsWith("/api/");
    // When a wrapper may frame the app, its pages (and the files they preview) can't say DENY;
    // their CSP frame-ancestors lists exactly who may frame them instead.
    if (!(embedding && (page || file))) reply.header("x-frame-options", file ? "SAMEORIGIN" : "DENY");
    reply.header("permissions-policy", "camera=(self), microphone=(), geolocation=(), payment=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (opts.secureCookies) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!reply.hasHeader("cache-control") && req.url.startsWith("/api/") && !req.url.includes("/attachments/") && !req.url.includes("/files/")) {
      reply.header("cache-control", "no-store");
    }
  });
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.status(400).send({ error: msg });
    }
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if ((err as any).statusCode && (err as any).statusCode < 500) {
      return reply.status((err as any).statusCode).send({ error: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong" });
  });

  // Small CSRF guard (on top of SameSite=Lax cookies). Browsers can't send these cross-site
  // without a CORS preflight, which we never allow:
  //  - POST/PATCH/PUT with a JSON body
  //  - file uploads (multipart) carrying our custom X-Brill-Upload header
  // DELETE can't be sent cross-site without a preflight either, so it may have no body.
  app.addHook("onRequest", async (req) => {
    if (!["POST", "PATCH", "PUT"].includes(req.method)) return;
    const type = req.headers["content-type"]?.split(";")[0];
    if (type === "application/json") return;
    if (type === "multipart/form-data" && req.headers["x-brill-upload"] === "1") return;
    throw new HttpError(415, "Requests must be JSON");
  });

  app.decorate("automations", new AutomationEngine(db, {
    mailer, appUrl, allowLoopbackWebhooks: opts.allowLoopbackWebhooks, log: (e) => app.log.error(e, "automation failed"),
  }));
  app.after(() => {
    registerAuth(app, db, { secureCookies: opts.secureCookies ?? false, mailer, appUrl, signups: opts.signups ?? "open", embedded: (opts.embedOrigins?.length ?? 0) > 0 });
    registerRealtime(app, db);
    registerRoutes(app, db);
    const files = registerFiles(app, db, opts.filesDir);
    registerImportExport(app, db);
    registerMembers(app, db, { mailer, appUrl });
    registerActivity(app, db);
    registerTrash(app, db);
    registerAutomations(app, db);
    registerDashboards(app, db);
    registerShare(app, db, files);
    registerAirtableImport(app, db, files.saveFile, opts.airtable);
    registerBaseLogos(app, db, opts.filesDir);
    registerNotifications(app, db, { mailer, appUrl });
  });
  if (opts.devMail && mailer.outbox) {
    const outbox = mailer.outbox;
    app.get("/api/dev/mail", async () => ({ emails: outbox }));
  }
  app.get("/api/health", async (_req, reply) => {
    try {
      await db.query(`SELECT 1`);
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false, error: "database unavailable" });
    }
  });
  if (opts.webDir) registerWebApp(app, opts.webDir, opts.embedOrigins);
  return app;
}
