import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { scheduleBackups } from "./backups";
import { buildApp } from "./app";
import { openDb } from "./db";
import { mailerFromEnv } from "./mail";

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

/** Public address of the web app, used in links inside emails. */
const APP_URL = env.APP_URL ?? "http://localhost:5180";
if (!APP_URL.startsWith("http://") && !APP_URL.startsWith("https://")) throw new Error(`APP_URL must start with http:// or https://, got "${APP_URL}"`);
const mailer = mailerFromEnv(env);
/** The built web app. Served by the API when present (production); in development Vite serves it. */
const WEB_DIR = env.WEB_DIR ?? resolve(import.meta.dirname, "../../web/dist");
const SERVE_WEB = env.SERVE_WEB ? env.SERVE_WEB === "true" : PRODUCTION && existsSync(resolve(WEB_DIR, "index.html"));
const SIGNUPS = env.SIGNUPS === "invite" ? "invite" : "open";
const BACKUP_DIR = env.BACKUP_DIR ?? resolve(DATA_DIR, "../backups");
const BACKUP_KEEP = Number(env.BACKUP_KEEP ?? 14);
if (PRODUCTION && !env.APP_URL) throw new Error("Set APP_URL to the site's address, e.g. https://airtable.brillcrew.com");

const db = await openDb(DATA_DIR);
const app = buildApp(db, {
  logger: true, secureCookies: SECURE_COOKIES, filesDir: FILES_DIR, trustProxy: TRUST_PROXY,
  mailer, appUrl: APP_URL, devMail: !PRODUCTION && !!mailer.outbox,
  webDir: SERVE_WEB ? WEB_DIR : undefined, signups: SIGNUPS,
});
const stopBackups = PRODUCTION || env.BACKUP_DIR
  ? scheduleBackups(db, { dir: BACKUP_DIR, keep: BACKUP_KEEP, hour: Number(env.BACKUP_HOUR ?? 2), log: (m, e) => (e ? app.log.error(e, m) : app.log.info(m)) })
  : () => {};

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    // Live-update streams stay open, so don't wait for them for ever.
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      stopBackups();
      await app.close();
    } finally {
      await db.close();
      process.exit(0);
    }
  });
}

await app.listen({ port: PORT, host: HOST });
