import { resolve } from "node:path";
import { buildApp } from "./app";
import { openDb } from "./db";

const env = process.env;
const PORT = Number(env.PORT ?? 4000);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);
/** 127.0.0.1 by default (behind Vite or a reverse proxy); set HOST=0.0.0.0 to listen on all interfaces. */
const HOST = env.HOST ?? "127.0.0.1";
const DATA_DIR = env.DATA_DIR ?? resolve(import.meta.dirname, "../../../.data/pg");
const FILES_DIR = env.FILES_DIR ?? resolve(import.meta.dirname, "../../../.data/files");
const PRODUCTION = env.NODE_ENV === "production";
/** "true", a hop count ("1") or a comma-separated list of proxy addresses. */
const TRUST_PROXY = !env.TRUST_PROXY ? false
  : env.TRUST_PROXY === "true" ? true
  : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY)
  : env.TRUST_PROXY;
const SECURE_COOKIES = env.SECURE_COOKIES ? env.SECURE_COOKIES === "true" : PRODUCTION;

const db = await openDb(DATA_DIR);
const app = buildApp(db, { logger: true, secureCookies: SECURE_COOKIES, filesDir: FILES_DIR, trustProxy: TRUST_PROXY });

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    // Live-update streams stay open, so don't wait for them for ever.
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      await app.close();
    } finally {
      await db.close();
      process.exit(0);
    }
  });
}

await app.listen({ port: PORT, host: HOST });
