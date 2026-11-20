# How Brill Tables works — from zero to every feature

This guide walks through the whole application in the order a new user meets it, then explains what happens behind the scenes. To try everything with realistic data, load the demo base (see **1. Start it**).

---

## 1. Start it

```bash
pnpm install
pnpm dev:api        # terminal 1 — API on http://127.0.0.1:4000
pnpm dev:web        # terminal 2 — app on http://localhost:5180
pnpm seed:demo      # optional — loads the "Studio Ops (demo)" base
```

The demo loader signs in as the local test account in `dev-seed.example.json` (or creates it). Running it again replaces the demo base. It prints the link to the demo's public request form.

## 2. The building blocks

| Thing | What it is | Example in the demo |
|---|---|---|
| **Workspace** | Your team's space. Members and their roles live here. Every new account gets one. | "Dev Tester's workspace" |
| **Base** | One app or database, such as a CRM or a project tracker. | Studio Ops (demo) |
| **Table** | One list of things, like a spreadsheet tab. | Clients, Projects, Tasks, Invoices |
| **Field** | A column, with a type. | Budget (number), Due date (date) |
| **Record** | A row. | "Saffron & Salt rebrand" |
| **View** | A saved way of looking at a table: a layout plus its filters, sorts and hidden fields. | Pipeline (kanban), Deadlines (calendar) |

## 3. Signing up and your account

- **Sign up** with name, email and password (at least 10 characters; common passwords are refused). **Sign in** stays active while you use the app, ending after 30 days of inactivity and after 90 days in any case.
- Too many wrong passwords lock that account's sign-in for 15 minutes.
- **Account settings** (your initials, top right) let you change your name or password and sign out of your other devices. Changing your password signs out every other device automatically.
- **Confirm your email:** after signing up you get an email with a confirmation link. Until you click it, a yellow banner on the home page reminds you, with **Resend email**. You need a confirmed email to join teams that invite you.
- **Forgot password?** (on the sign-in screen) emails a link to choose a new password. It works once, within 1 hour, and signs you out everywhere else. The screen says the same thing whether or not the email has an account, so nobody can use it to find out who's a customer.
- **In development no real email is sent.** Open http://localhost:5180/dev/mail to read every email the app would have sent, and follow its links. In production, set the email provider settings (see the README).

## 4. Home and bases

The home page lists every workspace you belong to and its bases. You can create a base, rename it, recolour it or delete it (the owner only). Inside a base, the tabs across the top are its tables: **+ Add table**, double-click a tab to rename it, right-click to delete.

## 5. Fields (columns)

Click **+** at the end of the header row, or a column's menu, to add or edit a field.

| Type | Notes |
|---|---|
| Single line text, Long text | |
| Number | Choose the decimal places. |
| Checkbox | |
| Single select, Multiple select | Coloured options, kept in the order you set. |
| Date | With or without a time of day. |
| Email, URL, Phone | |
| **Attachment** | Files, images, video, audio and PDF, up to 25 MB each. |
| **Currency** | An amount with its symbol (₹ by default, or $, €, £, AED…). Type "₹12,500" or just 12500. |
| **Percent** | Type 40 for 40%. |
| **Rating** | 1 to 10 stars (5 by default). Click a star in the grid or record form; click it again to clear it. |
| **Duration** | Time spent, shown as 1:30 (or 1:30:00). Type "1:30", "1h 30m", "45m", or a plain number of minutes. |
| **User** | Assign people, such as who a task is for. You can only pick people who can open the base; turn on "Allow more than one person" for several. Filter "has any of" a person to see someone's work. |
| **Autonumber** | 1, 2, 3… in the order records were created. Existing records get numbers when you add the field, and numbers are never reused. |
| **Created time / Last modified time** | Filled in automatically. Last modified changes whenever someone edits the record. |
| **Created by / Last modified by** | Filled in automatically with the person's name. |
| **Link to another record** | Connects two tables, and both sides stay in sync. The demo links Projects → Client. |
| **Lookup** | Shows a field from linked records, such as a project's "Client city". |
| **Rollup** | Combines values from linked records: SUM, AVERAGE, MIN, MAX, COUNT, join. The demo uses it for "Invoiced" and "Hours logged". |
| **Count** | Counts the linked records. |
| **Formula** | Airtable-style formulas: `{Budget} - {Invoiced}`, `IF(...)`, `DATETIME_DIFF({Due}, TODAY(), 'days')`, and about 80 functions. |

Changing a field's type converts the existing values. Calculated fields (lookup, rollup, count, formula) are worked out on the server and update by themselves when their inputs change, including chains such as a formula that uses a rollup of a lookup. You can't delete a field that other calculated fields depend on.

## 6. The grid (spreadsheet)

- Type into cells. Copy and paste ranges, drag the fill handle, press **Delete** to clear cells, and use **Enter** or a double-click to open the editor.
- The first (primary) column is frozen. Drag columns to reorder them and drag edges to resize them.
- Select a row and choose **Expand record** to see the whole record as a form, with **Comments** and **History**: who changed what, from what to what, and when.
- **Search** sits in the toolbar.

## 7. Views

The left sidebar lists the table's views. Create one of five kinds; each keeps its own settings:

| View | What it's for | Demo |
|---|---|---|
| **Grid** | Spreadsheet. | Projects → "Active — by deadline" filters out delivered work and sorts by due date. |
| **Kanban** | Cards in columns by a single select. Drag cards between columns to change the value. | Projects → Pipeline; Tasks → Board |
| **Calendar** | Records on a month grid by a date field. Drag to reschedule, colour by a select field, and drag undated records in from the side panel. | Projects → Deadlines; Tasks → Schedule |
| **Gallery** | Cards with a cover image from an attachment field. | Projects → Portfolio; Clients → Client wall |
| **Form** | A form anyone can fill in. Each answer becomes a record. | Projects → New project request |

The toolbar on every view has **Filter** (AND/OR conditions with type-aware operators), **Sort** (several levels), **Hide fields** and **Row height**. Filters and sorts run on the server.

## 8. Attachments

Select an attachment cell and press Enter to open the strip. **Add** offers **Local files** (drag and drop, with progress), **Link (URL)** (the server downloads it and refuses private network addresses) and **Webcam**. Click a file to open the full-screen viewer: preview, step through files with ← and →, rename, download, delete, and add **comments on that file**. Risky file types such as HTML and SVG always download and never open in the browser.

## 9. Import and export

- **Import CSV** (toolbar ⋯): match columns to fields or create new ones. The importer guesses types, handles day-first or month-first dates, ₹ signs and thousands separators, and yes/no checkboxes. It creates missing select options, and links records by name.
- **Export CSV** downloads the current view, with its fields, filters and sort order. Values that a spreadsheet would treat as formulas are made safe.
- **Batch API** — `POST /api/tables/:id/records/batch` with `typecast` creates many records at once. A future Airtable migration tool will use it.

## 10. Teamwork

- **Share** (in the base header) → invite people by email with a role:

| Role | Can |
|---|---|
| Owner | Everything, including deleting bases and managing members. |
| Creator | Build tables, fields and views, and manage public links. |
| Editor | Add and edit records and views. |
| Commenter | Read and comment. |
| Read only | Read. |

  Every invite is **emailed**, to existing users and new people alike. They join only when they click **Accept invite** while signed in with that email address, after confirming it, so nobody is added to a workspace without saying yes. The owner also sees the link, to send it another way if needed. It works only for that email and expires in 14 days. The screens hide what your role can't do, and the server enforces it on every request.
- **Sharing one base with a client.** In **Share**, pick **Only this base**, enter the client's email and a role (usually **Editor**). They get an email, create an account, confirm it and click **Accept invite**. They land in that base, and their home page lists it under **Shared with you**. They never see your other bases, and the sharing panel hides your team's email addresses from them. A "Guest" badge in the toolbar reminds everyone that they're an outside person.
- **Locking fields.** Open a field's **Edit field** and set **Who can edit this field**:
  - **Everyone who can edit**: the default.
  - **Workspace team only (not clients)**: people invited to just this base can see the field but can't change it.
  - **Creators and owners only.**

  Locked fields show 🔒 in the grid header and a **Locked** tag in the record form. Typical setup for client approvals:
  1. Attach the reel to a **Reel** (attachment) field and lock it to the team.
  2. Lock **Status** too.
  3. Leave **Caption** open. The client plays the reel, types the caption and comments. Your team sees it live, and **History** shows who wrote it.
- **Who can add and delete records.** The table's menu (the ▾ next to its name) sets this per table, with the same three choices. Choose "Workspace team only" to stop clients creating or deleting rows.
- **Live updates**: teammates' changes appear within about a second, without a refresh. The green "● Live" dot shows the connection.

## 11. Public links

- **Forms** — in a form view, **Share form** creates a link (`/f/…`) that anyone can fill in without an account, including file uploads. Submissions are rate-limited per visitor.
- **Shared views** — any other view can be shared read-only (⋯ → Share view, `/v/…`). Viewers see only its visible fields and only the records its filters allow. You can regenerate the link (which kills the old one) or turn it off.

---

## 12. Behind the scenes

```
Browser (React + Vite)            API (Node + Fastify)                Storage
 ├─ Glide Data Grid (canvas)  ──►  ├─ auth: argon2 passwords,         ├─ PostgreSQL (PGlite in dev)
 ├─ TanStack Query cache           │  hashed sessions, rate limits    │   records = JSONB cells
 ├─ live updates (SSE)  ◄────────  ├─ access check on every route     └─ files on disk (.data/files)
 └─ /f /v public pages             ├─ view query compiler (filters → SQL)
                                   ├─ dependency engine (links, lookups, rollups, formulas)
                                   ├─ formula engine (packages/shared)
                                   └─ realtime event bus
```

- **One language end to end:** TypeScript. Field types, validation, view settings and the formula engine live in `packages/shared` and are used by both the API and the browser.
- **Records** are stored as one JSON document of cells per row, keyed by field ID, so renaming a field never breaks anything.
- **Calculations happen on the server** when data changes, and the results are stored. That makes reading, filtering and sorting fast, because filters run as SQL on the stored values.
- **Security:**
  - The CSRF guard accepts only JSON requests and uploads with a custom header.
  - Sessions are cookie-based: httpOnly, SameSite, and stored only as a hash.
  - Every API response carries security headers (nosniff, no framing, no caching).
  - The server checks your role on every route, and other workspaces' IDs return "not found".
  - URL fetches are protected against SSRF.
  - Spreadsheet exports are protected against formula injection.
- **Quality:**
  - `pnpm test` runs 115 automated tests across API and engine.
  - `pnpm typecheck` checks types across the whole project.
  - `pnpm seed:demo` exercises the HTTP API end to end.

## 13. What isn't built yet

Group-by in the grid, automations, interfaces (dashboards), trash and restore, undo, Google sign-in, two-factor sign-in, record paging for very large tables, and production hosting. [SAAS_PLAN.md](../SAAS_PLAN.md) covers these and the move to a SaaS product.
