/**
 * Restore the database from a nightly backup (brill-db-YYYY-MM-DD.tar.gz).
 *
 *   pm2 stop brill-tables
 *   pnpm --filter @brill/api restore-backup /path/to/brill-db-2026-11-20.tar.gz /path/to/data/pg
 *   pm2 start brill-tables
 *
 * The current database folder is kept as "<folder>.before-restore-<time>", never deleted.
 */
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const [file, dataDirArg] = process.argv.slice(2);
if (!file || !dataDirArg) {
  console.error("Usage: restore-backup <backup.tar.gz> <database folder (DATA_DIR)>");
  process.exit(1);
}
const dataDir = resolve(dataDirArg);
const backup = readFileSync(resolve(file));

if (existsSync(dataDir)) {
  const kept = `${dataDir}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(dataDir, kept);
  console.log(`Current database moved to ${kept}`);
}
const pg = await PGlite.create({ dataDir, loadDataDir: new Blob([backup]) });
const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
console.log(`Restored ${dataDir} — ${r.rows[0].n} records. Start the app again.`);
await pg.close();
