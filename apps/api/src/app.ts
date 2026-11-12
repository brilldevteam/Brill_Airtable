import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAuth } from "./auth";
import type { Db } from "./db";
import { HttpError } from "./errors";
import { MAX_FILE_BYTES, registerFiles } from "./files";
import { registerActivity } from "./activity";
import { registerImportExport } from "./importExport";
import { registerMembers } from "./members";
import { registerRealtime } from "./realtime";
import { registerRoutes } from "./routes";
import { registerShare } from "./share";

export interface AppOptions {
  secureCookies?: boolean;
  logger?: boolean;
  /** Folder for uploaded files. */
  filesDir: string;
}

export function buildApp(db: Db, opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.status(400).send({ error: msg });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
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

  app.after(() => {
    registerAuth(app, db, { secureCookies: opts.secureCookies ?? false });
    registerRealtime(app, db);
    registerRoutes(app, db);
    const files = registerFiles(app, db, opts.filesDir);
    registerImportExport(app, db);
    registerMembers(app, db);
    registerActivity(app, db);
    registerShare(app, db, files);
  });
  app.get("/api/health", async () => ({ ok: true }));
  return app;
}
