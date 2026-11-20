# Brill Tables

In-house replacement for Airtable. See [docs/GUIDE.md](docs/GUIDE.md) for how everything works, [BUILD_PLAN.md](BUILD_PLAN.md) for the original plan and [SAAS_PLAN.md](SAAS_PLAN.md) for turning it into a SaaS product.

## Status: Phase 1 (foundation) — first working slice

Works today:
- Sign up / sign in (email + password; hashed session ids with 30-day idle / 90-day absolute expiry; sign-in rate limits and account lockout; common passwords refused)
- Account settings: change name or password (signs out other devices), sign out of other devices
- **Emails**: confirm your address at sign-up (banner + "Resend email" until you do), **forgot password** (link valid 1 hour, once; signs out every device; never reveals whether an account exists), and **invite emails**. In development the API doesn't send anything: open **http://localhost:5180/dev/mail** to see every email and click its links. For real email set `MAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM`, and `APP_URL` to the app's public address.
- Workspaces → bases → tables → fields → records
- Create, rename, delete bases and tables (double-click a tab to rename, right-click to delete)
- Field types: single line text, long text, number (decimal places), checkbox, single select, multiple select, date (optional time), email, URL, phone, **currency** (₹/$/€… symbol), **percent**, **rating** (stars), **duration** (h:mm), **user** (assign people who can open the base), **autonumber**, **created time**, **last modified time**, **created by**, **last modified by**
- Add, edit, delete fields; changing a field's type converts existing values
- Spreadsheet grid: inline editing, copy/paste, fill handle, frozen primary column, column resize, add/delete records, Delete key clears cells, search
- Permission checks on every API call (owner / creator / editor / commenter / read)
- **Views** (left sidebar): several saved views per table, each with its own settings; create, rename (double-click), duplicate, delete
  - **Filter** with AND/OR conditions and type-aware operators (contains, is, =, <, is any of, has all of, is before/after, today/tomorrow…); runs on the server as SQL
  - **Sort** by several fields (select fields sort in option order, empty values last)
  - **Hide fields**, drag to **reorder columns**, **resize columns**, **row height** — all saved per view
  - **Group** a grid by up to 3 fields (click a group header to collapse it), and a **summary bar** under the grid: Sum, Average, Median, Min, Max, Range, Earliest/Latest, Filled/Empty/Unique, Percent checked… per column. Group headers show the same totals for each group.
- **Kanban view**: cards stacked by a single select field, drag between stacks, add a card in a stack
- **Calendar view**: month grid (weeks start Monday) placed by a date field (or date formula); drag events to reschedule (time of day is kept), click a day's + to add a record there, colour events by a single select, "+N more" for busy days, and a side panel of records without a date that you can drag onto the calendar.
- **Gallery view**: cards with a cover from an attachment field (images, or the first frame of a video), crop or fit, small/medium/large cards, and the view's visible fields.
- **Expand record**: click a Kanban card, or select one grid row → "Expand record", to edit every field in a form

- **Linked records**: "Link to another record" fields between tables (or within one table). Linking from either side updates both sides; the other table gets a matching field automatically. Pick records with a searchable picker in the grid or the record form.
- **Lookup** (show a field from linked records), **Rollup** (SUM, AVERAGE, MIN, MAX, COUNT, COUNTALL, ARRAYJOIN, unique join) and **Count** fields. They are calculated on the server and update automatically when linked data changes, including chains such as a lookup of a lookup. They can be filtered and sorted (rollups and counts as numbers).
- Safety rules: you can't delete a field that lookups or rollups use, deleting a link field also deletes its other side, deleting a record removes it from all links, and calculated fields can't be typed into.

- **Formula fields** with Airtable-style syntax (`{Qty} * {Price}`, `IF(...)`, `DATETIME_DIFF({Due}, TODAY(), 'days')`) and ~80 functions: logic, text (incl. regex), numbers, dates (DATEADD, DATETIME_DIFF, DATETIME_FORMAT, WORKDAY…), lists and record info. The editor checks the formula as you type and shows the result type. Formulas are stored by field id (renaming fields never breaks them), calculated on the server, recalculated when their inputs change (including lookups, rollups and other formulas), and filter/sort as their result type. Formulas using TODAY()/NOW() refresh once a day. Errors show as `#ERROR!` in text formulas and as empty in number/date formulas. The engine is in `packages/shared/src/formula`.

- **Attachment fields** (Airtable-style): select a cell and press Enter (or double-click) for the strip with 📎 add, thumbnails and expand. The add dialog has **Local files** (drag-and-drop, progress bars), **Link (URL)** (the server downloads it, refusing private/local addresses) and **Webcam** (take a photo). Click a file for the full-screen **viewer**: images, videos (with seeking), audio and PDFs preview inline; ←/→ to move between files; rename, remove, download; and a **comments** panel per file. Thumbnails also show in the record form and as Kanban card covers. 25 MB per file. Files are stored on disk in `.data/files` (set `FILES_DIR` to change); risky file types (HTML, SVG…) are always downloaded, never opened in the browser.
- **CSV import** (toolbar ⋯ → Import CSV): match columns to fields or create new ones (types are guessed), day-first or month-first dates, ₹/commas in numbers, yes/no checkboxes; new select options and linked records (matched by name) are created automatically. **CSV export** downloads the current view (its fields, filters and sorts).
- **Batch API** `POST /api/tables/:id/records/batch` with `typecast` — the base for the Airtable migration tool.

- **Team sharing** (Share button on a base): members and roles — Owner, Creator (builds tables/fields), Editor (edits records), Commenter, Read only. Every invite is emailed and must be accepted by someone signed in with that email, after confirming it — nobody is added without saying yes. The owner also gets the link to send another way (works only for that email, expires in 14 days). The screens hide what a role can't do; the server enforces it.
- **Client sharing** (Share → **Only this base**): invite a client to one base. They see only that base (under "Shared with you"), never your other bases, and don't see your team's email addresses. **Field locks** (Edit field → *Who can edit*: everyone / workspace team only / creators only) let a client write the caption while only your team changes the reel, status or budget; a table's menu sets who can add and delete records. The server enforces both on every write, including paste, import and the API.
- **Live updates**: changes by teammates (or your other tabs) appear within a second, no refresh — the "● Live" dot in the top bar shows the connection. One server process (in-memory events); several processes would need Redis.
- **Form view**: build a form (title, description, which fields, question labels, help text, required, order, button text, thank-you message) and share it with **Share form** — anyone with the link can answer at `/f/<token>` without an account, including uploading files. Each answer becomes a record. Link fields and calculated fields can't be on a public form. Submissions are rate-limited per visitor.
- **Shared views**: any other view can be shared read-only (⋯ → Share view) at `/v/<token>` — only that view's visible fields, with its filters; images and files from visible attachment fields load through the link. Creators/owners can make a new link (the old one stops working) or turn it off.
- **Trash and undo**: deleted records go to the base's **Trash** (⋯ → Trash) for 30 days — restore them with their links, or delete them for good. **Ctrl+Z** undoes your last change in a table (cell edits, pastes and fills as one step, new and deleted records) and **Ctrl+Shift+Z** / **Ctrl+Y** redoes it; a notice after each delete has an Undo button.
- **Automations** (⚡ Automations on a base): *when* a record is created, updated (any field or chosen fields), starts matching conditions, or a form is submitted — *then* update the record, create a record in any table, send an email, or call a webhook. Text can use `{Field name}` tokens (and `{Record URL}`); people fields in an email's To use their addresses. Runs in the background after the change is saved, with a run history (each step's result) and a **Test** button. Automations can trigger other automations up to 3 levels deep but never themselves. Creators and owners manage them.
- **Dashboards** (Data | **Dashboards** switch in a base): pages of **numbers** (count, sum, average, min, max), **charts** (bar, column, line, donut — grouped by any field, dates by day/week/month with empty periods shown as zero, top N + Other) and **record lists**, plus text notes. Each widget reads a table, optionally through one of its views (its filters and sort). Live: they refresh as records change. Everyone in the base can look (including clients invited to it); creators and owners arrange them.
- **Record activity**: the record popup has **Comments** and **History** (who changed which field, from what to what, and when).

Not yet: scheduled automations, sharing a dashboard by public link. Link fields can only be filtered by "is empty / is not empty" for now. These follow the phases in the plan.

## Requirements

- Node.js 22+
- pnpm 11 (`npm install -g pnpm`)
- **No Docker and no database install needed for development**: the API uses PGlite, a full PostgreSQL that runs inside Node and stores its data in `.data/pg`.

## Run it

```bash
pnpm install
```

In two terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Open http://localhost:5180 and create an account.

To load a realistic demo base (clients, projects, tasks, invoices — every field and view type), with the API running:

```bash
pnpm seed:demo
```

Production settings (environment variables for the API): `PORT`, `HOST` (default 127.0.0.1), `DATA_DIR`, `FILES_DIR`, `NODE_ENV=production` (secure cookies + HSTS), `SECURE_COOKIES`, `TRUST_PROXY` (behind nginx/Caddy/a load balancer), `APP_URL` (used in email links), `MAIL_PROVIDER` / `RESEND_API_KEY` / `MAIL_FROM`. `GET /api/health` checks the database.

## Tests

```bash
pnpm test
```

```bash
pnpm typecheck
```

## Layout

```
apps/api        Fastify API (auth, bases, tables, fields, records) + PGlite database
apps/web        React + Vite frontend, Glide Data Grid for the spreadsheet
packages/shared Field types, validation and value conversion shared by both
```

To reset the dev database, stop the API and delete the `.data` folder.

`dev-seed.example.json` holds a local-only test account used during development.
