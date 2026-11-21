import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";

/**
 * Nightly database backups (production). PGlite writes a consistent, compressed snapshot of the
 * whole database while the app keeps running. Files: brill-db-YYYY-MM-DD.tar.gz, the newest
 * `keep` are kept. Uploaded files (FILES_DIR) are separate — back that folder up with the server.
 */
export function scheduleBackups(db: Db, opts: { dir: string; keep: number; hour: number; log: (msg: string, err?: unknown) => void }) {
  if (!db.backup) return () => {};
  mkdirSync(opts.dir, { recursive: true });

  const run = async () => {
    try {
      const data = await db.backup!();
      const name = `brill-db-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      writeFileSync(join(opts.dir, name), data);
      const old = readdirSync(opts.dir).filter((f) => /^brill-db-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort().reverse().slice(opts.keep);
      for (const f of old) rmSync(join(opts.dir, f), { force: true });
      opts.log(`Database backup written: ${name} (${Math.round(data.length / 1024)} KB)`);
    } catch (e) {
      opts.log("Database backup failed", e);
    }
  };

  // Next run at the chosen hour (server time), then every 24 h.
  const now = new Date();
  const next = new Date(now);
  next.setHours(opts.hour, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  let daily: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void run();
    daily = setInterval(run, 24 * 3600_000);
    daily.unref();
  }, next.getTime() - now.getTime());
  first.unref();
  return () => {
    clearTimeout(first);
    if (daily) clearInterval(daily);
  };
}
