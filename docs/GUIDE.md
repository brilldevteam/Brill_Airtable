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

The home page has a sidebar: **Home**, **Starred**, **Shared with me**, **Workspaces**, **Import from Airtable** and **Create**. Home groups your bases by when *you* last opened them (Today, Past 7 days, Past 30 days, Earlier). Hover a base to ⭐ star it (starred bases also sit in the sidebar), or use ⋯ / right-click to rename it or pick an **icon and colour**. Switch between grid and list with the buttons on the right, and press **Ctrl+K** to jump to any base by name.

Inside a base, the top bar shows the base name and four sections: **Data** (tables), **Automations**, **Dashboards** and **Forms** (every form in the base, with its share link). Under it, the tinted row holds the tables: **+ Add table**, double-click a tab to rename it, right-click for options. The ☰ button on the view toolbar shows or hides the list of views; click the view name to rename, duplicate or delete it. Dates can be shown as Friendly (December 1, 2026), US, European, ISO or Local — set it in the field's settings.

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

**Grouping and totals (grid views).**
- **Group** (in the toolbar) groups records by a field, such as Status, Client or Assignee. You can group by up to 3 fields, for example Owner and then Done.
- Each group has a header row with its name and how many records it holds. Click the header to collapse or expand the group; your browser remembers this.
- The **bar under the grid** summarises each column. Click a column's cell in the bar and pick:
  - **Sum**, **Average**, **Median**, **Min**, **Max** or **Range** for numbers and money;
  - **Earliest**, **Latest** or **Range (days)** for dates;
  - **Checked** or **Percent checked** for checkboxes;
  - **Filled**, **Empty** or **Unique** for any field.
- Group headers show the same totals for each group. Try Projects → "By stage" and Tasks → "By owner" in the demo.

The toolbar on every view has **Filter** (AND/OR conditions with type-aware operators), **Sort** (several levels), **Hide fields** and **Row height**. Filters and sorts run on the server.

**Undo, redo and the Trash.**
- **Ctrl+Z** (Cmd+Z on a Mac) undoes your last change in a table: a cell edit, a whole paste or fill-handle drag, a new record, or a delete. Press it again to go further back, up to 100 steps.
- **Ctrl+Shift+Z** or **Ctrl+Y** redoes. While you're typing in a box, these keys undo the typing instead.
- Every delete shows a notice with an **Undo** button.
- Deleted records move to the base's **Trash** (⋯ → **Trash**). It shows what each record was, who deleted it and when.
- **Restore** puts a record back in its table *with its links*. If a linked record is also in the Trash, the link comes back once that one is restored too.
- Records are removed for good after 30 days, or straight away with **Delete forever**.

## 8. Attachments

Select an attachment cell and press Enter to open the strip. **Add** offers **Local files** (drag and drop, with progress), **Link (URL)** (the server downloads it and refuses private network addresses) and **Webcam**. Click a file to open the full-screen viewer: preview, step through files with ← and →, rename, download, delete, and add **comments on that file**. Risky file types such as HTML and SVG always download and never open in the browser.

## 9. Import and export

- **Import CSV** (toolbar ⋯): match columns to fields or create new ones. The importer guesses types, handles day-first or month-first dates, ₹ signs and thousands separators, and yes/no checkboxes. It creates missing select options, and links records by name.
- **Export CSV** downloads the current view, with its fields, filters and sort order. Values that a spreadsheet would treat as formulas are made safe.
- **Batch API** — `POST /api/tables/:id/records/batch` with `typecast` creates many records at once.
- **Import from Airtable** (home sidebar, or Create → Import bases from Airtable): create a personal access token at airtable.com/create/tokens with the scopes `schema.bases:read` and `data.records:read` and access to your bases, paste it, then pick the bases and a workspace. What comes across: tables, fields (types, options, select colours, date formats), records with their created dates, attachments (downloaded and stored here), links between tables, lookups, rollups, counts, formulas, and views (name, type, visible fields and order). A formula or rollup using something we can't recreate keeps the values Airtable showed, and the import lists it under “things to check”. Not copied: record comments, automations, interfaces, and view filters and sorts (Airtable's API doesn't share those). People in collaborator fields come across as names. The token is used only during the import and is never saved.

## 9b. Notifications and @mentions

- **Bell** (top right): shows when someone @mentions you in a record's comments, or adds you to a person field that notifies. Unread ones are highlighted; click one to open the record. The same notification is emailed to you (once).
- **@mention**: in a record's comments, type `@` and pick a teammate or a client who has access to the base.
- **Assignee-style fields**: in a Person field's settings, tick *Notify people when they're added*.
- **Select options** (Status, etc.): Edit field shows each option as a coloured pill — rename it, click the dot to change its colour, drag to reorder, × to remove, *Add option*, *Alphabetize*, and a **default** for new records.
- A field can be changed to or from **Attachment** or **Person**. Text can't become files or people, so those values are cleared (you're warned first); files and people turned into text keep their names.

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

## 11b. Automations

Click **⚡ Automations** in a base's header (creators and owners only). Each automation is **When … then …**:

| When (trigger) | Example |
|---|---|
| A record is created | A new lead is added |
| A record is updated (any field, or only fields you tick) | Someone changes the Reviewer |
| A record matches conditions | Status becomes "Review". It runs once each time a record *starts* matching, not on every later edit. Records that already matched when you switched it on don't run. |
| A form is submitted (choose the form) | A client sends the project request form |

| Then (actions, in order) | Notes |
|---|---|
| Update the record | Set fields to fixed values or `{Field}` tokens. Select options, linked records, people and dates can be given by name. |
| Create a record | In any table of the base, for example a log entry or a task. |
| Send an email | **To** can mix addresses with `{Email}` or people tokens such as `{Assignee}`. Subject and message can use any `{Field}` and `{Record URL}`. |
| Send a webhook | Sends a POST with the record's fields as JSON to Zapier, Make, n8n, Slack and similar tools. Private and local network addresses are refused. |

- Use the **{ }** button in any text box to insert a field.
- **Test** runs the actions straight away on the newest record.
- **Run history** shows every run and the result of each step, for example "Emailed client@…" or "The webhook answered 500".
- If a step fails, the rest of that run stops.
- Automations that change records can trigger other automations, up to 3 levels deep, but never themselves, so loops stop on their own.
- The demo base has two examples, switched off.

## 11c. Dashboards

Switch a base from **Data** to **Dashboards** (top left of the tab bar). The demo base has **Studio overview**.

- **Create:** **New dashboard** makes one. **Edit dashboard** → **Add widget** adds widgets:

  | Widget | Shows |
  |---|---|
  | **Number** | How many records, or the sum, average, minimum or maximum of a number or money field. For example "Waiting to be paid ₹2,40,000". |
  | **Chart** | Bar, column, line or donut, grouped by any field: a status, a person, a client, or a date by day, week or month. Bars can count records or add up a field. |
  | **Record list** | A few records with the fields you pick, such as the next deadlines. |
  | **Text** | A heading or note. |

- **Which records:** every widget reads a table. Under **Records**, choose *All records* or *Only those in* one of the table's views. The widget then uses that view's filters, and its sort for lists. For example, point a widget at the "Unpaid" view to total only unpaid invoices.
- **Arranging:** in edit mode, each widget has buttons to move it, make it wider or narrower (quarter, half, three quarters, full width), open its settings, or remove it.
- **How charts behave:**
  - Select options keep their colours.
  - Months or days with nothing in them show as zero, so a timeline has no gaps.
  - Smaller groups are added up as "Other".
  - Hovering a bar or slice shows its value and its share of the total.
- **Updates and access:**
  - Dashboards update by themselves as records change.
  - Everyone in the base can view them, including clients invited to just that base; they see the whole base's data anyway.
  - Creators and owners can change them.

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
  - `pnpm test` runs 133 automated tests across API and engine.
  - `pnpm typecheck` checks types across the whole project.
  - `pnpm seed:demo` exercises the HTTP API end to end.

## 13. What isn't built yet

Scheduled automations, public dashboard links, Google sign-in, two-factor sign-in, record paging for very large tables, and production hosting. [SAAS_PLAN.md](../SAAS_PLAN.md) covers these and the move to a SaaS product.
