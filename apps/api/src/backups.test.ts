import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db";

describe("database backups", () => {
  it("a snapshot restores into a new folder with the same data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brill-backup-"));
    const db = await openDb(join(dir, "pg"));
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ('usrBackupTest0001', 'b@x.test', 'Backup', 'x')`);
    const snapshot = await db.backup!();
    expect(snapshot.length).toBeGreaterThan(1000);
    // gzip magic number
    expect([snapshot[0], snapshot[1]]).toEqual([0x1f, 0x8b]);
    await db.close();

    const restored = await PGlite.create({ dataDir: join(dir, "restored"), loadDataDir: new Blob([snapshot]) });
    const r = await restored.query<{ name: string }>(`SELECT name FROM users WHERE id='usrBackupTest0001'`);
    expect(r.rows[0]?.name).toBe("Backup");
    await restored.close();
  }, 60_000);
});
