/**
 * Loads a demo base ("Studio Ops (demo)") into a running Brill Tables API, using
 * only the public HTTP API — so it also works as an end-to-end smoke test.
 *
 *   pnpm seed:demo                      (API must be running: pnpm dev:api)
 *
 * Env: API_URL (default http://127.0.0.1:4000), DEMO_EMAIL / DEMO_PASSWORD / DEMO_NAME
 * (default: the local test account in dev-seed.example.json). Running it again
 * replaces the previous demo base.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const seed = JSON.parse(readFileSync(new URL("../../../dev-seed.example.json", import.meta.url), "utf8"));
const EMAIL = process.env.DEMO_EMAIL ?? seed.email;
const PASSWORD = process.env.DEMO_PASSWORD ?? seed.password;
const NAME = process.env.DEMO_NAME ?? seed.name;
const BASE_NAME = "Studio Ops (demo)";

let cookie = "";
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? text}`);
  return data as T;
}

async function upload(tableId: string, name: string, png: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), name);
  const res = await fetch(`${API}/api/tables/${tableId}/attachments`, {
    method: "POST", headers: { cookie, "x-brill-upload": "1" }, body: form,
  });
  if (!res.ok) throw new Error(`upload ${name} → ${res.status}: ${await res.text()}`);
  return (await res.json()).attachments[0].id;
}

/** A simple generated cover image: gradient, initials and a title. */
async function cover(title: string, c1: string, c2: string, w = 1200, h = 800): Promise<Buffer> {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const initials = title.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.82}" cy="${h * 0.18}" r="${h * 0.42}" fill="#ffffff" opacity="0.10"/>
    <circle cx="${w * 0.1}" cy="${h * 0.95}" r="${h * 0.3}" fill="#000000" opacity="0.08"/>
    <text x="${w * 0.07}" y="${h * 0.5}" font-family="Segoe UI, Arial, sans-serif" font-size="${h * 0.3}" font-weight="700" fill="#ffffff" opacity="0.95">${esc(initials)}</text>
    <text x="${w * 0.07}" y="${h * 0.8}" font-family="Segoe UI, Arial, sans-serif" font-size="${h * 0.075}" font-weight="600" fill="#ffffff">${esc(title)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

type Field = { id: string; name: string; type: string; options: any };
async function fieldsOf(tableId: string): Promise<Field[]> {
  return (await call("GET", `/api/tables/${tableId}`)).fields;
}
async function addField(tableId: string, name: string, type: string, options?: object): Promise<Field> {
  return (await call("POST", `/api/tables/${tableId}/fields`, { name, type, options })).field;
}
const choices = (...names: [string, string][]) => names.map(([name, color]) => ({ name, color }));

/** Turn the default table (Name / Notes / Status + 3 blank rows) into a clean one. */
async function setUpTable(tableId: string, name: string, notes: string | null, status: [string, string][] | null) {
  await call("PATCH", `/api/tables/${tableId}`, { name });
  const t = await call("GET", `/api/tables/${tableId}`);
  const recs = (await call("GET", `/api/views/${t.views[0].id}/records`)).records;
  for (const r of recs) await call("DELETE", `/api/records/${r.id}`);
  const [, notesF, statusF] = t.fields as Field[];
  if (notes) await call("PATCH", `/api/fields/${notesF.id}`, { name: notes });
  else await call("DELETE", `/api/fields/${notesF.id}`);
  if (status) await call("PATCH", `/api/fields/${statusF.id}`, { options: { choices: choices(...status) } });
  else await call("DELETE", `/api/fields/${statusF.id}`);
  return t.views[0].id as string;
}

async function batch(tableId: string, rows: Record<string, unknown>[]) {
  const fields = await fieldsOf(tableId);
  const byName = new Map(fields.map((f) => [f.name, f.id]));
  const records = rows.map((r) => ({
    cells: Object.fromEntries(Object.entries(r).map(([k, v]) => {
      const id = byName.get(k);
      if (!id) throw new Error(`No field "${k}"`);
      return [id, v];
    })),
  }));
  return (await call("POST", `/api/tables/${tableId}/records/batch`, { records, typecast: true, dateOrder: "dmy" })).ids as string[];
}

async function addView(tableId: string, name: string, type: string, patch?: (f: Map<string, Field>) => object) {
  const { view } = await call("POST", `/api/tables/${tableId}/views`, { name, type });
  if (patch) {
    const f = new Map((await fieldsOf(tableId)).map((x) => [x.name, x]));
    await call("PATCH", `/api/views/${view.id}`, { config: { ...view.config, ...patch(f) } });
  }
  return view.id as string;
}
const choiceId = (f: Field, name: string) => f.options.choices.find((c: any) => c.name === name).id;

async function main() {
  // ---------- sign in (or create the account) ----------
  try {
    await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  } catch {
    await call("POST", "/api/auth/register", { email: EMAIL, password: PASSWORD, name: NAME });
  }
  const ws = await call("GET", "/api/workspaces");
  const wsId = ws.workspaces.find((w: any) => w.role === "owner")?.id ?? ws.workspaces[0].id;
  for (const b of ws.bases.filter((b: any) => b.name === BASE_NAME)) await call("DELETE", `/api/bases/${b.id}`);

  const { base, firstTableId } = await call("POST", `/api/workspaces/${wsId}/bases`, { name: BASE_NAME, color: "purple" });
  console.log(`Base ${base.id}`);

  // ---------- tables ----------
  const clientsT = firstTableId;
  const clientsGrid = await setUpTable(clientsT, "Clients", "About", [["Active", "green"], ["Prospect", "yellow"], ["Paused", "gray"]]);
  const projectsT = (await call("POST", `/api/bases/${base.id}/tables`, { name: "Projects" })).table.id;
  const projectsGrid = await setUpTable(projectsT, "Projects", "Brief", [
    ["Lead", "gray"], ["Briefing", "cyan"], ["In progress", "blue"], ["Review", "orange"], ["Delivered", "green"],
  ]);
  const tasksT = (await call("POST", `/api/bases/${base.id}/tables`, { name: "Tasks" })).table.id;
  const tasksGrid = await setUpTable(tasksT, "Tasks", "Details", [["To do", "gray"], ["Doing", "blue"], ["Blocked", "red"], ["Done", "green"]]);
  const invoicesT = (await call("POST", `/api/bases/${base.id}/tables`, { name: "Invoices" })).table.id;
  const invoicesGrid = await setUpTable(invoicesT, "Invoices", null, [["Draft", "gray"], ["Sent", "blue"], ["Paid", "green"], ["Overdue", "red"]]);

  // Clients
  await addField(clientsT, "Industry", "singleSelect", { choices: choices(["Fashion", "pink"], ["Food & drink", "orange"], ["Tech", "blue"], ["Real estate", "teal"], ["Wellness", "green"]) });
  await addField(clientsT, "Contact", "singleLineText");
  await addField(clientsT, "Email", "email");
  await addField(clientsT, "Phone", "phone");
  await addField(clientsT, "City", "singleLineText");
  await addField(clientsT, "Website", "url");
  await addField(clientsT, "Logo", "attachment");
  await addField(clientsT, "Client since", "date");

  // Projects
  const projClient = await addField(projectsT, "Client", "link", { linkedTableId: clientsT });
  await addField(projectsT, "Services", "multipleSelect", { choices: choices(["Branding", "purple"], ["Website", "blue"], ["Social media", "pink"], ["Photography", "orange"], ["Video", "red"], ["Packaging", "teal"]) });
  await addField(projectsT, "Budget", "currency", { symbol: "₹", precision: 0 });
  await addField(projectsT, "Progress", "percent");
  await addField(projectsT, "Client rating", "rating", { max: 5 });
  await addField(projectsT, "Start date", "date");
  await addField(projectsT, "Due date", "date");
  const coverF = await addField(projectsT, "Cover", "attachment");
  await addField(projectsT, "Retainer", "checkbox");
  // Client sharing: clients may write the caption, but only the team changes the cover, status and budget.
  await addField(projectsT, "Caption", "longText");
  for (const name of ["Status", "Budget"]) {
    const f = (await fieldsOf(projectsT)).find((x) => x.name === name)!;
    await call("PATCH", `/api/fields/${f.id}`, { editAccess: "team" });
  }
  await call("PATCH", `/api/fields/${coverF.id}`, { editAccess: "team" });
  const clientsF = new Map((await fieldsOf(clientsT)).map((f) => [f.name, f]));
  await addField(projectsT, "Client city", "lookup", { linkFieldId: projClient.id, targetFieldId: clientsF.get("City")!.id });

  // Tasks
  const taskProject = await addField(tasksT, "Project", "link", { linkedTableId: projectsT });
  await addField(tasksT, "Owner", "singleSelect", { choices: choices(["Aisha", "purple"], ["Rahul", "blue"], ["Meera", "pink"], ["Karthik", "teal"]) });
  await addField(tasksT, "Priority", "singleSelect", { choices: choices(["High", "red"], ["Medium", "yellow"], ["Low", "gray"]) });
  await addField(tasksT, "Due", "date");
  await addField(tasksT, "Hours", "number", { precision: 1 });
  await addField(tasksT, "Done", "checkbox");
  await addField(tasksT, "Task no.", "autonumber");
  await addField(tasksT, "Time spent", "duration");
  await addField(tasksT, "Assignee", "user");
  await addField(tasksT, "Created", "createdTime");
  await addField(tasksT, "Last edited by", "lastModifiedBy");
  await addField(tasksT, "Days left", "formula", { formula: "IF(AND({Due}, NOT({Done})), DATETIME_DIFF({Due}, TODAY(), 'days'))" });
  await addField(tasksT, "Flag", "formula", {
    formula: "IF({Done}, '✓ Done', IF(AND({Due}, DATETIME_DIFF({Due}, TODAY(), 'days') < 0), '⚠ Overdue', IF({Priority} = 'High', '● Urgent', '')))",
  });

  // Invoices
  const invProject = await addField(invoicesT, "Project", "link", { linkedTableId: projectsT });
  await addField(invoicesT, "Amount", "currency", { symbol: "₹", precision: 0 });
  await addField(invoicesT, "Issued", "date");
  await addField(invoicesT, "Due", "date");
  await addField(invoicesT, "Invoice PDF", "attachment");

  // Rollups / counts / formulas that need the links above
  const tasksF = new Map((await fieldsOf(tasksT)).map((f) => [f.name, f]));
  const invF = new Map((await fieldsOf(invoicesT)).map((f) => [f.name, f]));
  const projF0 = new Map((await fieldsOf(projectsT)).map((f) => [f.name, f]));
  const projTasksLink = projF0.get("Tasks")!;
  const projInvLink = projF0.get("Invoices")!;
  await addField(projectsT, "Task count", "count", { linkFieldId: projTasksLink.id });
  await addField(projectsT, "Hours logged", "rollup", { linkFieldId: projTasksLink.id, targetFieldId: tasksF.get("Hours")!.id, aggregation: "sum" });
  await addField(projectsT, "Invoiced", "rollup", { linkFieldId: projInvLink.id, targetFieldId: invF.get("Amount")!.id, aggregation: "sum" });
  await addField(projectsT, "Left to invoice", "formula", { formula: "{Budget} - {Invoiced}" });
  await addField(projectsT, "Days to deadline", "formula", { formula: "IF({Due date}, DATETIME_DIFF({Due date}, TODAY(), 'days'))" });
  await addField(projectsT, "Team", "lookup", { linkFieldId: projTasksLink.id, targetFieldId: tasksF.get("Owner")!.id });
  const clientsProjLink = (await fieldsOf(clientsT)).find((f) => f.name === "Projects")!;
  const projF1 = new Map((await fieldsOf(projectsT)).map((f) => [f.name, f]));
  await addField(clientsT, "Total budget", "rollup", { linkFieldId: clientsProjLink.id, targetFieldId: projF1.get("Budget")!.id, aggregation: "sum" });
  await addField(clientsT, "Project count", "count", { linkFieldId: clientsProjLink.id });
  void taskProject; void invProject;

  // ---------- records ----------
  const clients: [string, string, string, string, string, string, string, string, string, string, number][] = [
    ["Saffron & Salt", "Active", "Food & drink", "Neha Kapoor", "hello@saffronsalt.example", "+91 98450 11223", "Bengaluru", "https://saffronsalt.example", "#f97316", "#dc2626", -420],
    ["Northwind Apparel", "Active", "Fashion", "Arjun Mehta", "arjun@northwind.example", "+91 99001 44556", "Mumbai", "https://northwind.example", "#ec4899", "#8b5cf6", -300],
    ["Lumen Labs", "Active", "Tech", "Priya Raman", "priya@lumenlabs.example", "+91 90080 77889", "Chennai", "https://lumenlabs.example", "#3b82f6", "#06b6d4", -210],
    ["Greenleaf Homes", "Prospect", "Real estate", "Vikram Shah", "vikram@greenleaf.example", "+91 97400 22331", "Pune", "https://greenleaf.example", "#10b981", "#0f766e", -30],
    ["Kaya Wellness", "Active", "Wellness", "Ananya Iyer", "ananya@kaya.example", "+91 96320 55667", "Kochi", "https://kaya.example", "#a855f7", "#f43f5e", -150],
    ["Bluefin Coffee", "Paused", "Food & drink", "Sameer Khan", "sameer@bluefin.example", "+91 91234 99887", "Hyderabad", "https://bluefin.example", "#0ea5e9", "#1e3a8a", -500],
  ];
  const clientIds = await batch(clientsT, clients.map(([name, status, industry, contact, email, phone, city, web, , , since]) => ({
    Name: name, Status: status, Industry: industry, Contact: contact, Email: email, Phone: phone, City: city, Website: web,
    "Client since": day(since), About: `${name} has worked with the studio since ${day(since).slice(0, 4)}.`,
  })));
  const clientsF2 = new Map((await fieldsOf(clientsT)).map((f) => [f.name, f]));
  for (const [i, c] of clients.entries()) {
    const att = await upload(clientsT, `${c[0].toLowerCase().replace(/\W+/g, "-")}-logo.png`, await cover(c[0], c[8], c[9], 600, 600));
    await call("PATCH", `/api/records/${clientIds[i]}`, { cells: { [clientsF2.get("Logo")!.id]: [att] } });
  }

  const projects: [string, string, string, string[], number, number, number, boolean, string, string, string][] = [
    ["Saffron & Salt rebrand", "Saffron & Salt", "In progress", ["Branding", "Packaging"], 450000, -40, 12, false, "#f97316", "#b91c1c", "New identity, menu system and takeaway packaging for 4 outlets."],
    ["Monsoon menu shoot", "Saffron & Salt", "Review", ["Photography"], 120000, -14, 3, false, "#f59e0b", "#ea580c", "Seasonal menu photography — 40 dishes, 2 shoot days."],
    ["Northwind AW26 campaign", "Northwind Apparel", "In progress", ["Photography", "Video", "Social media"], 780000, -25, 20, false, "#ec4899", "#7c3aed", "Autumn/winter lookbook, a 30s film and launch social posts."],
    ["Northwind social retainer", "Northwind Apparel", "In progress", ["Social media"], 90000, -90, 45, true, "#db2777", "#9333ea", "Monthly content calendar, 16 posts and 8 reels a month."],
    ["Lumen Labs website", "Lumen Labs", "Briefing", ["Website", "Branding"], 620000, 5, 60, false, "#3b82f6", "#0891b2", "Marketing site with product pages, docs landing and blog."],
    ["Lumen product launch video", "Lumen Labs", "Lead", ["Video"], 300000, 20, 75, false, "#2563eb", "#4f46e5", "Explainer video for the v2 launch."],
    ["Greenleaf brochure", "Greenleaf Homes", "Lead", ["Branding"], 150000, 10, 40, false, "#10b981", "#047857", "Print brochure and site hoardings for a new project."],
    ["Kaya app launch kit", "Kaya Wellness", "Delivered", ["Social media", "Video"], 240000, -70, -10, false, "#a855f7", "#e11d48", "Launch reels, app-store screenshots and press kit."],
    ["Kaya studio photos", "Kaya Wellness", "Review", ["Photography"], 85000, -10, 1, false, "#c084fc", "#db2777", "Interior and class photography for the new studio."],
    ["Bluefin packaging refresh", "Bluefin Coffee", "Delivered", ["Packaging", "Branding"], 210000, -160, -60, false, "#0ea5e9", "#1e40af", "Bag and cup redesign across 6 blends."],
  ];
  const projectIds = await batch(projectsT, projects.map(([name, client, status, services, budget, start, due, retainer, , , brief]) => ({
    Name: name, Client: client, Status: status, Services: services, Budget: budget, "Start date": day(start), "Due date": day(due),
    Retainer: retainer, Brief: brief,
    Progress: status === "Delivered" ? 100 : status === "Review" ? 85 : status === "In progress" ? 50 : status === "Briefing" ? 15 : 0,
    "Client rating": status === "Delivered" ? 5 : status === "Review" ? 4 : null,
  })));
  const projF = new Map((await fieldsOf(projectsT)).map((f) => [f.name, f]));
  for (const [i, p] of projects.entries()) {
    const att = await upload(projectsT, `${p[0].toLowerCase().replace(/\W+/g, "-")}.png`, await cover(p[0], p[8], p[9]));
    await call("PATCH", `/api/records/${projectIds[i]}`, { cells: { [projF.get("Cover")!.id]: [att] } });
  }

  const owners = ["Aisha", "Rahul", "Meera", "Karthik"];
  const taskNames: [string, string, string, string][] = [
    ["Moodboard & references", "Saffron & Salt rebrand", "Done", "Medium"],
    ["Logo concepts (3 routes)", "Saffron & Salt rebrand", "Done", "High"],
    ["Packaging dielines", "Saffron & Salt rebrand", "Doing", "High"],
    ["Menu typography", "Saffron & Salt rebrand", "To do", "Medium"],
    ["Retouch hero dishes", "Monsoon menu shoot", "Doing", "High"],
    ["Client review call", "Monsoon menu shoot", "To do", "Medium"],
    ["Casting & locations", "Northwind AW26 campaign", "Done", "High"],
    ["Shoot day 1", "Northwind AW26 campaign", "Done", "High"],
    ["Film edit v1", "Northwind AW26 campaign", "Doing", "High"],
    ["Colour grade", "Northwind AW26 campaign", "To do", "Medium"],
    ["Launch post copy", "Northwind AW26 campaign", "Blocked", "Low"],
    ["November content calendar", "Northwind social retainer", "Done", "Medium"],
    ["December content calendar", "Northwind social retainer", "To do", "Medium"],
    ["Sitemap & wireframes", "Lumen Labs website", "Doing", "High"],
    ["Kick-off workshop", "Lumen Labs website", "Done", "Medium"],
    ["Script draft", "Lumen product launch video", "To do", "Low"],
    ["Proposal & estimate", "Greenleaf brochure", "Doing", "Medium"],
    ["Final asset handover", "Kaya app launch kit", "Done", "Low"],
    ["Select final images", "Kaya studio photos", "To do", "High"],
    ["Print proofs check", "Bluefin packaging refresh", "Done", "Low"],
  ];
  const offsets = [-30, -22, 2, 9, -1, 3, -18, -12, 1, 6, -3, -16, 12, 4, -5, 18, 2, -12, 0, -64];
  await batch(tasksT, taskNames.map(([name, project, status, priority], i) => ({
    Name: name, Project: project, Status: status, Priority: priority, Owner: owners[i % owners.length],
    Due: day(offsets[i]), Hours: [3, 6, 8, 4, 5, 1, 7, 10, 12, 4, 2, 3, 3, 9, 2, 4, 3, 2, 3, 1][i],
    "Time spent": `${Math.floor([3, 6, 8, 4, 5, 1, 7, 10, 12, 4, 2, 3, 3, 9, 2, 4, 3, 2, 3, 1][i] * 0.8)}:${["00", "15", "30", "45"][i % 4]}`,
    Assignee: i % 3 === 0 ? EMAIL : null,
    Done: status === "Done", Details: status === "Blocked" ? "Waiting for the client to approve the film edit." : "",
  })));

  const invoices: [string, string, number, string, number][] = [
    ["INV-2026-041", "Saffron & Salt rebrand", 225000, "Paid", -38],
    ["INV-2026-047", "Monsoon menu shoot", 60000, "Sent", -12],
    ["INV-2026-043", "Northwind AW26 campaign", 390000, "Paid", -24],
    ["INV-2026-039", "Northwind social retainer", 90000, "Overdue", -45],
    ["INV-2026-048", "Northwind social retainer", 90000, "Sent", -14],
    ["INV-2026-031", "Kaya app launch kit", 240000, "Paid", -72],
    ["INV-2026-022", "Bluefin packaging refresh", 210000, "Paid", -150],
    ["INV-2026-050", "Lumen Labs website", 186000, "Draft", 0],
  ];
  await batch(invoicesT, invoices.map(([no, project, amount, status, issued]) => ({
    Name: no, Project: project, Amount: amount, Status: status, Issued: day(issued), Due: day(issued + 30),
  })));

  // ---------- views ----------
  const pf = (await fieldsOf(projectsT));
  const P = new Map(pf.map((f) => [f.name, f]));
  await call("PATCH", `/api/views/${projectsGrid}`, {
    name: "All projects",
    config: (await call("GET", `/api/tables/${projectsT}`)).views[0].config,
  });
  await addView(projectsT, "Active — by deadline", "grid", (f) => ({
    filters: { conjunction: "and", conditions: [{ id: "c1", fieldId: f.get("Status")!.id, operator: "isNoneOf", value: [choiceId(f.get("Status")!, "Delivered")] }] },
    sorts: [{ fieldId: f.get("Due date")!.id, direction: "asc" }],
    hiddenFieldIds: ["Brief", "Cover", "Client city", "Team"].map((n) => f.get(n)!.id),
  }));
  await addView(projectsT, "By stage", "grid", (f) => ({
    groupBy: [{ fieldId: f.get("Status")!.id, direction: "asc" }],
    summaries: { [f.get("Budget")!.id]: "sum", [f.get("Progress")!.id]: "avg", [f.get("Client rating")!.id]: "avg", [f.get("Due date")!.id]: "earliest" },
  }));
  await addView(projectsT, "Pipeline", "kanban", (f) => ({ stackFieldId: f.get("Status")!.id, coverFieldId: f.get("Cover")!.id }));
  await addView(projectsT, "Deadlines", "calendar", (f) => ({ dateFieldId: f.get("Due date")!.id, colorFieldId: f.get("Status")!.id }));
  await addView(projectsT, "Portfolio", "gallery", (f) => ({
    coverFieldId: f.get("Cover")!.id, cardSize: "medium",
    hiddenFieldIds: pf.filter((x) => !["Name", "Client", "Status", "Services"].includes(x.name)).map((x) => x.id),
  }));
  const formView = await addView(projectsT, "New project request", "form", (f) => ({
    form: {
      title: "Start a project with Brill Studio",
      description: "Tell us a little about what you need. We reply within one working day.",
      fields: [
        { fieldId: f.get("Name")!.id, required: true, label: "Project name", help: "A short working title is fine." },
        { fieldId: f.get("Services")!.id, required: true, label: "What do you need?", help: "" },
        { fieldId: f.get("Budget")!.id, required: false, label: "Budget (₹)", help: "A rough range helps us plan." },
        { fieldId: f.get("Due date")!.id, required: false, label: "When do you need it?", help: "" },
        { fieldId: f.get("Brief")!.id, required: true, label: "Brief", help: "Goals, audience, references…" },
        { fieldId: f.get("Cover")!.id, required: false, label: "Reference files", help: "Moodboards, decks or photos." },
      ],
      submitText: "Send request",
      successMessage: "Thanks! We've got your brief and will be in touch within one working day.",
      allowAnother: true,
    },
  }));
  const share = await call("POST", `/api/views/${formView}/share`, {});

  await call("PATCH", `/api/views/${tasksGrid}`, { name: "All tasks" });
  await addView(tasksT, "Open tasks", "grid", (f) => ({
    filters: { conjunction: "and", conditions: [{ id: "c1", fieldId: f.get("Done")!.id, operator: "isNotChecked" }] },
    sorts: [{ fieldId: f.get("Due")!.id, direction: "asc" }],
  }));
  await addView(tasksT, "By owner", "grid", (f) => ({
    groupBy: [{ fieldId: f.get("Owner")!.id, direction: "asc" }, { fieldId: f.get("Done")!.id, direction: "asc" }],
    summaries: { [f.get("Hours")!.id]: "sum", [f.get("Time spent")!.id]: "sum", [f.get("Done")!.id]: "percentChecked" },
  }));
  await addView(tasksT, "Board", "kanban", (f) => ({ stackFieldId: f.get("Status")!.id }));
  await addView(tasksT, "By priority", "kanban", (f) => ({ stackFieldId: f.get("Priority")!.id }));
  await addView(tasksT, "Schedule", "calendar", (f) => ({ dateFieldId: f.get("Due")!.id, colorFieldId: f.get("Priority")!.id }));

  await call("PATCH", `/api/views/${clientsGrid}`, { name: "All clients" });
  await addView(clientsT, "Client wall", "gallery", (f) => ({ coverFieldId: f.get("Logo")!.id, coverFit: "cover", cardSize: "small" }));

  await call("PATCH", `/api/views/${invoicesGrid}`, {
    name: "All invoices",
    config: { ...(await call("GET", `/api/tables/${invoicesT}`)).views[0].config, summaries: { [(await fieldsOf(invoicesT)).find((x) => x.name === "Amount")!.id]: "sum" } },
  });
  await addView(invoicesT, "Unpaid", "grid", (f) => ({
    filters: { conjunction: "and", conditions: [{ id: "c1", fieldId: f.get("Status")!.id, operator: "isAnyOf", value: ["Sent", "Overdue"].map((n) => choiceId(f.get("Status")!, n)) }] },
    sorts: [{ fieldId: f.get("Due")!.id, direction: "asc" }],
  }));
  await addView(invoicesT, "Status board", "kanban", (f) => ({ stackFieldId: f.get("Status")!.id }));

  // ---------- a little activity ----------
  await call("POST", `/api/records/${projectIds[0]}/comments`, { body: "Client loved route B of the logo. Moving to packaging this week." });
  await call("POST", `/api/records/${projectIds[2]}/comments`, { body: "Film edit v1 goes to the client on Friday — colour grade after approval." });
  await call("PATCH", `/api/records/${projectIds[1]}`, { cells: { [P.get("Status")!.id]: choiceId(P.get("Status")!, "Review") } });

  console.log(`Done. Base "${BASE_NAME}" with Clients (${clients.length}), Projects (${projects.length}), Tasks (${taskNames.length}), Invoices (${invoices.length}).`);
  console.log(`Public request form: http://localhost:5180/f/${share.share.token}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
