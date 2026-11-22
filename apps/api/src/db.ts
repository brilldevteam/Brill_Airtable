import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal database interface. In development it is backed by PGlite (real Postgres
 * running inside Node, stored in a folder). In production swap in node-postgres
 * against a natively installed PostgreSQL — the SQL stays the same.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** A compressed snapshot of the whole database (PGlite only). */
  backup?(): Promise<Uint8Array>;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

function wrap(q: Queryable, txFn: Db["tx"], close: Db["close"]): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows[0] as T | undefined;
    },
    tx: txFn,
    close,
  };
}

/** dataDir: folder path, or "memory://" for an in-memory database (tests). */
export async function openDb(dataDir: string): Promise<Db> {
  if (!dataDir.startsWith("memory://")) mkdirSync(dirname(dataDir), { recursive: true });
  const pg = await PGlite.create(dataDir);
  const close = () => pg.close();
  const tx: Db["tx"] = (fn) =>
    pg.transaction((t) => {
      // Nested tx() calls reuse the same transaction.
      const inner: Db = wrap(t as unknown as Queryable, (f) => f(inner), close);
      return fn(inner);
    });
  const db: Db = wrap(pg as unknown as Queryable, tx, close);
  db.backup = async () => new Uint8Array(await (await pg.dumpDataDir("gzip")).arrayBuffer());
  await migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  /* 001 core schema */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','creator','editor','commenter','read')),
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE bases (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    primary_field_id TEXT,
    position INT NOT NULL DEFAULT 0
  );
  CREATE TABLE fields (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '{}',
    position INT NOT NULL DEFAULT 0,
    UNIQUE (table_id, name)
  );
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    cells JSONB NOT NULL DEFAULT '{}',
    autonumber BIGSERIAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT REFERENCES users(id),
    deleted_at TIMESTAMPTZ
  );
  CREATE INDEX records_table_idx ON records (table_id, autonumber) WHERE deleted_at IS NULL;
  CREATE INDEX records_cells_gin ON records USING GIN (cells);
  `,
  /* 002 views */ `
  CREATE TABLE views (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'grid',
    config JSONB NOT NULL DEFAULT '{}',
    position INT NOT NULL DEFAULT 0
  );
  CREATE INDEX views_table_idx ON views (table_id, position)
  `,
  /* 003 attachments (file bytes live on disk; see files.ts) */ `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    width INT,
    height INT,
    has_thumb BOOLEAN NOT NULL DEFAULT false,
    created_by TEXT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX attachments_table_idx ON attachments (table_id)
  `,
  /* 004 comments on attachments */ `
  CREATE TABLE attachment_comments (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX attachment_comments_idx ON attachment_comments (attachment_id, created_at)
  `,
  /* 005 collaboration: invites, record comments, record history */ `
  CREATE TABLE workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','creator','editor','commenter','read')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ
  );
  CREATE INDEX workspace_invites_ws_idx ON workspace_invites (workspace_id);
  CREATE TABLE record_comments (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX record_comments_idx ON record_comments (record_id, created_at);
  CREATE TABLE record_history (
    id BIGSERIAL PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
    changes JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX record_history_idx ON record_history (record_id, id)
  `,
  /* 006 public share links (forms and read-only views) */ `
  CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    view_id TEXT NOT NULL UNIQUE REFERENCES views(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE attachments ADD COLUMN share_id TEXT
  `,
  /* 007 hashed sessions with idle + absolute expiry; indexes for access checks */ `
  DELETE FROM sessions;
  ALTER TABLE sessions ADD COLUMN absolute_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '90 days';
  ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
  CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);
  CREATE INDEX IF NOT EXISTS bases_workspace_idx ON bases (workspace_id);
  CREATE INDEX IF NOT EXISTS tables_base_idx ON tables (base_id)
  `,
  /* 008 email verification and password reset */ `
  ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
  UPDATE users SET email_verified_at = now();
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, kind)
  `,
  /* 009 base-only members (e.g. clients), base invites, record add/delete restrictions */ `
  CREATE TABLE base_members (
    base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('creator','editor','commenter','read')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (base_id, user_id)
  );
  CREATE INDEX base_members_user_idx ON base_members (user_id);
  ALTER TABLE workspace_invites ADD COLUMN base_id TEXT REFERENCES bases(id) ON DELETE CASCADE;
  ALTER TABLE tables ADD COLUMN record_access TEXT NOT NULL DEFAULT 'all' CHECK (record_access IN ('all','team','creators'))
  `,
  /* 010 trash: restoring is logged in record history; deleted records are listed per table */ `
  ALTER TABLE record_history DROP CONSTRAINT IF EXISTS record_history_kind_check;
  ALTER TABLE record_history ADD CONSTRAINT record_history_kind_check CHECK (kind IN ('create','update','delete','restore'));
  CREATE INDEX records_deleted_idx ON records (table_id, deleted_at) WHERE deleted_at IS NOT NULL
  `,
  /* 011 trash: links to records still in the trash, re-made when those are restored */ `
  ALTER TABLE records ADD COLUMN trash_links JSONB
  `,
  /* 012 automations: trigger + actions per base, a run log, and which records currently match */ `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    trigger JSONB NOT NULL,
    actions JSONB NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX automations_base_idx ON automations (base_id);
  CREATE INDEX automations_table_idx ON automations ((trigger->>'tableId')) WHERE enabled;
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    record_id TEXT,
    record_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('success','failed')),
    steps JSONB NOT NULL DEFAULT '[]',
    test BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX automation_runs_idx ON automation_runs (automation_id, started_at DESC);
  CREATE TABLE automation_matches (
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    PRIMARY KEY (automation_id, record_id)
  )
  `,
  /* 013 dashboards: widget pages per base */ `
  CREATE TABLE dashboards (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    widgets JSONB NOT NULL DEFAULT '[]',
    position INT NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX dashboards_base_idx ON dashboards (base_id, position)
  `,
  /* 014 changing an account's email: the new address is confirmed by a link sent to it */ `
  ALTER TABLE email_tokens DROP CONSTRAINT IF EXISTS email_tokens_kind_check;
  ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_kind_check CHECK (kind IN ('verify','reset','email'));
  ALTER TABLE email_tokens ADD COLUMN new_email TEXT
  `,
  /* 015 a dashboard can belong to one table (it goes when the table does) */ `
  ALTER TABLE dashboards ADD COLUMN table_id TEXT REFERENCES tables(id) ON DELETE CASCADE
  `,
];

async function migrate(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const done = new Set((await db.query<{ version: number }>(`SELECT version FROM schema_migrations`)).map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (t) => {
      for (const stmt of MIGRATIONS[i].split(";").map((s) => s.trim()).filter(Boolean)) await t.query(stmt);
      await t.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
    });
  }
}
