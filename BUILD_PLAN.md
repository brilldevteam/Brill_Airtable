# Brill Tables — In-House Airtable Replacement: Build Plan

_Prepared 12 Nov 2026 for Brill Creations_

---

## 0. Read this first — two honest caveats

1. **This plan is based on Airtable's full feature set, not on your bases.** I surveyed Airtable from a fresh trial account (field types, view types, automation triggers, extensions). That account is empty, so I have not seen Brill Creations' real tables, record counts, automations or interfaces. **Phase 0 below exists to fix that** — before writing code, inventory what you actually use and cut every feature you don't.
2. **Consider self-hosting an open-source alternative before building from scratch.** Teable, NocoDB and Baserow are open-source Airtable-style apps you can run on your own server for the cost of hosting. If one of them covers ~90% of your use, you save 6+ months of development. Spend 1 week trialling them during Phase 0. Build your own only if you need custom workflows, deep integration with your other in-house systems, or full control of the product. The rest of this plan assumes you build.

---

## 1. What Airtable does (feature inventory from the survey)

| Area | What exists in Airtable | Priority for us |
|---|---|---|
| **Structure** | Workspaces → Bases → Tables → Fields → Records; Views per table | Must |
| **Field types (28)** | Single line text, Long text (rich), Attachment, Checkbox, Single select, Multiple select, User, Date (+time), Phone, Email, URL, Number, Currency, Percent, Duration, Rating, **Link to another record**, **Lookup**, **Rollup**, **Count**, **Formula**, Created time, Last modified time, Created by, Last modified by, Autonumber, Barcode, Button | Must: all except Barcode/Button (Should) |
| **AI field agents** | Analyze attachment, Research companies, Generate image/content, Deep match | Later |
| **Views** | Grid, Kanban, Calendar, Gallery, Form, List, Timeline, Gantt, Sections (folders) | Grid/Kanban/Form/Calendar/Gallery = Must; List/Timeline/Gantt = Should |
| **View config** | Hide fields, Filter (AND/OR groups), Group (multi-level), Sort, Row colour, row height, frozen columns, column summaries (sum/avg/count…), share view link, personal/locked views | Must |
| **Grid UX** | Inline editing, keyboard nav, copy/paste ranges, fill-drag, expand record, undo/redo, search, bulk edit | Must |
| **Collaboration** | Real-time multi-user edits, record comments with @mentions, record revision history, notifications | Must |
| **Permissions** | Workspace/base roles: Owner, Creator, Editor, Commenter, Read-only; field & table edit locks; public share links | Must |
| **Automation triggers** | Record matches conditions, Field changes, Form submitted, Record created, Record updated, Record enters view, Scheduled time, Webhook received, Email received, Button clicked, Comment added; Google Calendar/Forms/Sheets, Outlook | Must (core 8), Should (email/integrations) |
| **Automation actions** | Create/update/find records, Send email, Send Slack/Teams message, Call webhook, Run script, Conditional branches, Repeat for each record, Generate with AI | Must (core), Later (AI) |
| **Interfaces** | Drag-and-drop app pages: dashboards (charts, numbers), record review, lists, kanban, forms, buttons, filters for end users | Should (Phase 7) |
| **Extensions** | Chart, Pivot table, Page designer (print), Dedupe, CSV import, Batch update, Map, Org chart, Summary, Translate, Send SMS | CSV import = Must; Chart/Pivot/Print = Should; rest Later |
| **Data in/out** | CSV/Excel import, CSV export, REST API, webhooks, Google Sheets sync | Must (CSV + API) |

---

## 2. Technology choices

**One language end to end: TypeScript.** The same formula engine, field validation and types then run in the browser and on the server, and one team can work across the whole stack.

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React 18 + Vite + TypeScript** | Mature, huge hiring pool |
| Grid component | **Glide Data Grid** (canvas-based) | Handles 100k+ rows smoothly; DOM grids slow down past ~5k rows |
| UI kit | Tailwind CSS + Radix UI / shadcn | Fast, accessible building blocks |
| State / data | TanStack Query + Zustand | Server cache + local UI state |
| Kanban / drag | dnd-kit | Kanban cards, field reordering |
| Calendar / timeline | FullCalendar (+ a custom Gantt or Frappe Gantt) | Calendar, Timeline, Gantt views |
| Charts (interfaces) | Apache ECharts | Dashboards, pivot charts |
| Rich text | Tiptap | Long text & comments with @mentions |
| Backend | **Node.js 22 + Fastify** (plain, modular files) | Fast and simple; runs TypeScript directly with tsx. Chosen over NestJS during Phase 1 to avoid its decorator/build setup |
| API | REST (OpenAPI docs) + WebSocket | REST for the public API, WS for real-time |
| Database | **PostgreSQL 16** | JSONB, strong indexing, transactions, full-text search |
| ORM / queries | Drizzle ORM (or Kysely) | Typed SQL, dynamic queries for filters |
| Real-time | Socket.IO + Redis adapter | Broadcast cell changes to everyone viewing a table |
| Job queue | **BullMQ on Redis** | Automations, scheduled triggers, imports, emails |
| Formula engine | Own parser (Chevrotain), shared TS package | Airtable-compatible formula syntax |
| File storage | Local disk folder (behind a storage interface, so S3/MinIO can be swapped in later) + thumbnails via `sharp` | Attachments, image previews |
| Auth | Email + password (argon2), Google SSO, sessions in Redis | Simple and in-house |
| Email | Nodemailer via your SMTP (or Postmark/SES) | Automation "send email", notifications |
| Script sandbox | `isolated-vm` | Safe "Run script" automation action |
| Deploy | **No Docker.** Native installs on one Windows or Linux server: PostgreSQL, Redis (Memurai on Windows), Node processes kept alive by PM2, Caddy for HTTPS. Local dev uses **PGlite** (Postgres embedded in Node, zero install) | Simple, no containers |
| Monitoring | Grafana + Prometheus + Loki, Sentry (self-hosted or cloud) | Errors, logs, metrics |
| Backups | WAL-G continuous Postgres backups + nightly MinIO sync to off-site storage | **Your business data — non-negotiable** |
| CI/CD | GitHub Actions → build images → deploy | Automated tests on every change |

---

## 3. Architecture

```
            ┌───────────────────────── Browser (React SPA) ─────────────────────────┐
            │  Grid · Kanban · Calendar · Gallery · Form · Interfaces · Admin       │
            │  Shared TS packages: field types, formula engine, validation          │
            └───────────────┬──────────────────────────────┬────────────────────────┘
                            │ HTTPS (REST)                 │ WebSocket
                     ┌──────▼──────────────────────────────▼──────┐
                     │        Caddy (TLS, reverse proxy)          │
                     └──────┬─────────────────────────────────────┘
                     ┌──────▼─────────────────────────────────────┐
                     │  API server (NestJS)                       │
                     │  auth · schema · records · views · comments│
                     │  permissions · public API · realtime hub   │
                     └──┬───────────┬──────────────┬──────────────┘
                        │           │              │ enqueue events
                 ┌──────▼───┐ ┌─────▼─────┐  ┌─────▼──────────────────┐
                 │PostgreSQL│ │  Redis    │  │ Worker (same codebase) │
                 │ data +   │ │ pub/sub,  │◄─┤ automations, scheduler,│
                 │ metadata │ │ sessions, │  │ imports, emails,       │
                 └──────────┘ │ BullMQ    │  │ recompute, thumbnails  │
                              └───────────┘  └─────────┬──────────────┘
                                              ┌────────▼────────┐
                                              │ File storage    │
                                              │ (local disk)    │
                                              └─────────────────┘
```

Start as a **modular monolith**: one codebase, deployed as two processes (`api` and `worker`). Don't start with microservices.

### 3.1 Data model (the core design decision)

Airtable lets users create tables and fields at runtime, so we store **metadata + records**, not one SQL table per user table.

```sql
workspaces(id, name, created_at)
workspace_members(workspace_id, user_id, role)            -- owner/creator/editor/commenter/read
users(id, email, name, password_hash, avatar_url)
bases(id, workspace_id, name, icon, color)
tables(id, base_id, name, primary_field_id, position)
fields(id, table_id, name, type, options JSONB, position, description)
     -- options: select choices, number precision, link target table, formula text, etc.
records(id, table_id, cells JSONB, autonumber BIGSERIAL,
        created_at, created_by, updated_at, updated_by, deleted_at)
     -- cells: { "fldABC": "Acme", "fldDEF": 42, "fldGHI": ["recX","recY"] }
-- Links: implemented WITHOUT a separate record_links table. Both sides store the linked
-- record ids in cells (kept in sync in one transaction); lookups/rollups/counts are stored
-- in cells too and recomputed by apps/api/src/links.ts. Add a record_links table later
-- only if link-heavy queries get slow.
views(id, table_id, name, type, config JSONB, position, locked, owner_id)
     -- config: filters, sorts, groups, hidden fields, column widths, colours, kanban stack field...
comments(id, record_id, user_id, body, mentions, created_at)
record_history(id, record_id, user_id, changes JSONB, created_at)
attachments(id, record_id, field_id, storage_key, filename, mime, size, width, height)
automations(id, base_id, name, enabled, trigger JSONB, actions JSONB)
automation_runs(id, automation_id, status, input, log, started_at, finished_at)
share_links(id, view_id or interface_id, token, password_hash, expires_at)
interfaces(id, base_id, name, pages JSONB)
api_tokens(id, user_id, name, scopes, token_hash, last_used_at)
```

- **Indexes:** GIN index on `records.cells`; expression indexes on hot fields when needed; `(table_id, deleted_at)`.
- **Filter / sort / group** are compiled from the view's JSON config into SQL on JSONB (`cells->>'fld…'`), with typed casts per field type.
- **Links** live in `record_links` (needed for fast lookup/rollup and two-way links), mirrored into `cells` for fast reads.
- **Computed fields** (formula, lookup, rollup, count): computed on write and **stored** in `cells`. A dependency graph (field → fields that depend on it, across linked tables) decides what to recompute; big recomputes go to the worker.
- **Soft delete + history** give undo and a "trash" for restoring records.
- This approach comfortably handles tens of millions of cells — far more than an in-house business typically needs.

### 3.2 Real-time collaboration
1. Client sends a cell change → API validates it against the field type and the user's permissions → writes in a transaction → recomputes dependent fields.
2. API publishes `{tableId, recordId, changes, version}` on Redis → every API instance pushes it over WebSocket to clients viewing that table.
3. Clients apply it optimistically; conflicts are last-write-wins **per cell**, which is what Airtable does too. No complex CRDTs needed.

### 3.3 Formula engine
- Shared TS package: tokenizer → parser (Chevrotain) → AST → type checker → evaluator.
- Implement Airtable's functions in tiers: **logic** (IF, SWITCH, AND, OR, NOT, BLANK, ERROR), **text** (CONCATENATE, &, LEFT, RIGHT, MID, LEN, FIND, SUBSTITUTE, UPPER, LOWER, TRIM, REGEX_*), **number** (ROUND, SUM, AVERAGE, MIN, MAX, ABS, MOD, INT, CEILING, FLOOR), **date** (TODAY, NOW, DATEADD, DATETIME_DIFF, DATETIME_FORMAT, WORKDAY, WEEKDAY, YEAR/MONTH/DAY), **array** (ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT), RECORD_ID, CREATED_TIME, LAST_MODIFIED_TIME.
- Rollup aggregations reuse the same function set (SUM(values), ARRAYJOIN(values), etc.).
- Fields are referenced internally by **field ID**, so renaming a field never breaks a formula.
- **Golden test suite:** copy your real Airtable formulas and their outputs into tests, so results match exactly.

### 3.4 Automations engine
- Each record write emits a domain event (`record.created`, `record.updated` with changed field IDs, `form.submitted`, `comment.added`, `button.clicked`) into BullMQ.
- The worker matches events against enabled automations' triggers (conditions are evaluated with the same filter engine as views).
- Scheduled triggers use BullMQ repeatable jobs (cron). Webhook triggers get a unique URL per automation. Email triggers use an inbound mailbox polled over IMAP.
- Actions run in sequence with outputs passed forward (`{{trigger.record.fields.Status}}`), plus conditional branches and "repeat for each".
- Every run is logged in `automation_runs` with inputs, outputs and errors. Failures retry with backoff, and the base owner gets an alert.
- "Run script" runs user JavaScript in `isolated-vm` with a time and memory limit and a small API (`table.selectRecords`, `fetch`, etc.).

### 3.5 Permissions
- Roles at workspace level, overridable per base: **Owner > Creator** (edit schema) **> Editor** (edit data) **> Commenter > Read-only**.
- Optional per-field and per-table edit locks.
- Public share links per view, form or interface, optionally with password and expiry.
- Every API call goes through one permission guard. Write tests for this module first.

---

## 4. Delivery phases

Team assumption: **2 full-stack TypeScript developers + 1 part-time designer/QA**, with someone from operations as product owner. Durations scale roughly linearly with team size.

| Phase | Weeks | Scope | Done when |
|---|---|---|---|
| **0. Discovery** | 2 | Log in to the real Brill Creations Airtable; export the schema of every base via the Airtable API (`schema.bases:read`); list each automation, interface and integration and who uses it; trial Teable/NocoDB/Baserow; decide build vs self-host; cut the feature list to what's actually used | Signed-off scope list + build/self-host decision |
| **1. Foundation** | 4 | Repo (monorepo: `apps/web`, `apps/api`, `packages/shared`), CI, PGlite dev database, auth (email + Google), workspaces/bases/tables/fields CRUD, records CRUD, basic Grid view with text/number/select/date/checkbox fields | Team can create a base and enter data in a grid |
| **2. Grid & fields** | 5 | All standard field types, attachments (MinIO + thumbnails), link/lookup/rollup/count with dependency recompute, filter/sort/group/hide/colour/row height/frozen columns/summaries, copy-paste, fill, undo/redo, search, expanded record view, CSV import/export | A real Brill table can be rebuilt with identical fields |
| **3. Formula engine** | 3 | Parser, ~80 Airtable functions, formula editor with autocomplete and error messages, golden tests from your formulas | All your existing formulas give the same results |
| **4. More views** | 4 | Kanban, Calendar, Gallery, Form (public link, validation, file upload), List, Timeline/Gantt (if used), view sections, personal & locked views | Each view your team uses today exists |
| **5. Collaboration & security** | 3 | Real-time sync, comments with @mentions, notifications (in-app + email), revision history, trash/restore, roles & permissions, share links, audit log | Multiple users work at once safely |
| **6. Automations** | 5 | Engine, the core 8 triggers, actions (create/update/find records, email, Slack/Teams, webhook, script, conditions, repeat), run history UI, then email trigger and Google/Outlook integrations if used | Every Brill automation is rebuilt and running |
| **7. Interfaces & reporting** | 4 | Interface designer: pages with grid/kanban/record detail/form/chart/number/button elements, user filters; pivot table; print/PDF page designer | Your interfaces/dashboards are rebuilt |
| **8. API, migration & cutover** | 3 | Public REST API + tokens + outbound webhooks; **migration tool** (Airtable API → our DB: schema, records, links, attachments, comments); parallel run; training; go-live | Airtable switched to read-only, then cancelled |
| **Later** | — | AI fields (Claude API: summarise, classify, extract from attachments), mobile PWA, offline, map/org-chart, dedupe, more integrations | — |

**Total: ~33 weeks (≈ 8 months) to full replacement** with 2 developers. A usable internal **MVP after Phase 3 (~14 weeks)** lets your team move simple bases off Airtable early.

### Migration approach (Phase 8 detail)
1. Script reads every base's schema via the Airtable Meta API and creates the matching tables/fields (mapping each Airtable field type to ours).
2. Copies records in pages of 100, keeping an `airtable_record_id → our_id` map, then a second pass sets links.
3. Downloads attachments to file storage (Airtable attachment URLs expire, so do this in one run).
4. Recomputes formulas/rollups and **diffs our results against Airtable's values**; any mismatch is a bug to fix before go-live.
5. Rebuild automations by hand (Airtable's API doesn't export them) using the Phase 0 inventory.
6. Run both systems in parallel for 2 weeks, then switch Airtable to read-only, keep a full export as an archive, and cancel.

---

## 5. Repository layout

```
brill-tables/
├── apps/
│   ├── web/              React + Vite frontend
│   ├── api/              NestJS API + WebSocket gateway
│   └── worker/           BullMQ processors (automations, imports, recompute)
├── packages/
│   ├── shared/           field-type definitions, validation (zod), types
│   ├── formula/          formula parser + evaluator (+ golden tests)
│   ├── query/            view config → SQL compiler (filters/sorts/groups)
│   └── ui/               shared components
├── tools/airtable-migrate/   migration CLI
├── infra/                PM2 ecosystem file, Caddyfile, backup scripts
└── docs/
```
Use pnpm workspaces + Turborepo. Testing: Vitest (unit), Playwright (end-to-end), plus a load test (k6) for a 100k-record table.

---

## 6. Hosting & running costs (rough)

| Item | Estimate |
|---|---|
| Server: 8 vCPU / 16–32 GB RAM / 500 GB SSD (Hetzner, OVH, DigitalOcean, or on-prem) | ~$40–120 / month |
| Off-site backup storage | ~$5–20 / month |
| Email sending | ~$0–15 / month |
| Domain + TLS | Free–$15 / year (Let's Encrypt via Caddy) |

**Main cost is people, not servers:** ~8 developer-months to build, plus ongoing maintenance of roughly 20–30% of one developer. Compare that against your current Airtable bill (seats × plan price × 12) **before** committing. If the subscription is small, self-hosting an open-source alternative is usually the better deal.

---

## 7. Risks & how to handle them

| Risk | Mitigation |
|---|---|
| Underestimating scope (Airtable is huge) | Phase 0 cut-list; build only what Brill uses |
| Formula results differ from Airtable | Golden tests from real formulas; migration diff step |
| Grid feels slow | Canvas grid, server-side paging (load visible rows only), virtual scrolling, load test early |
| Data loss | Continuous Postgres backups, tested restores every month, soft-delete, record history |
| Key-person dependency | Docs, tests, 2+ devs who know each module |
| Security | Single permission guard, rate limiting, OWASP checks, dependency scanning, HTTPS only, 2FA for admins |

---

## 8. Immediate next steps

1. **Get access to the real Brill Creations Airtable** — sign in on the real account, or create a read-only API token (`schema.bases:read`, `data.records:read`). That gives the exact list of bases, tables, fields and record counts for Phase 0.
2. Screenshot or list every **automation** and **interface** (the API can't export these).
3. Write down your current Airtable bill (seats, plan) to make the build-vs-self-host decision.
4. Trial Teable / NocoDB / Baserow for one week with a copy of one real base.
5. If building: set up the monorepo skeleton (Phase 1), starting with the data model in §3.1.
