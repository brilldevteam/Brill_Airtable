import { z } from "zod";

export const FIELD_TYPES = [
  "singleLineText",
  "longText",
  "number",
  "checkbox",
  "singleSelect",
  "multipleSelect",
  "date",
  "email",
  "url",
  "phone",
  "link",
  "lookup",
  "rollup",
  "count",
  "formula",
  "attachment",
  "currency",
  "percent",
  "rating",
  "duration",
  "user",
  "autonumber",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  singleLineText: "Single line text",
  longText: "Long text",
  number: "Number",
  checkbox: "Checkbox",
  singleSelect: "Single select",
  multipleSelect: "Multiple select",
  date: "Date",
  email: "Email",
  url: "URL",
  phone: "Phone number",
  link: "Link to another record",
  lookup: "Lookup",
  rollup: "Rollup",
  count: "Count",
  formula: "Formula",
  attachment: "Attachment",
  currency: "Currency",
  percent: "Percent",
  rating: "Rating",
  duration: "Duration",
  user: "User",
  autonumber: "Autonumber",
  createdTime: "Created time",
  lastModifiedTime: "Last modified time",
  createdBy: "Created by",
  lastModifiedBy: "Last modified by",
};

/** Filled in by the server from the record itself (who/when), never typed. */
export const SYSTEM_TYPES = new Set<FieldType>(["autonumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"]);
/** Fields whose values are user ids (shown as people). */
export const USER_TYPES = new Set<FieldType>(["user", "createdBy", "lastModifiedBy"]);
/** Plain number fields with their own display (they filter, sort and calculate as numbers). */
export const NUMBER_LIKE_TYPES = new Set<FieldType>(["number", "currency", "percent", "rating", "duration"]);
export const DURATION_FORMATS = ["h:mm", "h:mm:ss"] as const;

/** Fields whose values are calculated by the server and can't be typed into. */
export const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup", "count", "formula", ...SYSTEM_TYPES]);
/** Field types that can't be converted to or from another type (yet). */
export const STRUCTURAL_TYPES = new Set<FieldType>(["link", "lookup", "rollup", "count", "formula", "attachment", "user", ...SYSTEM_TYPES]);

export const ROLLUP_AGGREGATIONS = ["sum", "avg", "min", "max", "count", "countAll", "join", "joinUnique"] as const;
export type RollupAggregation = (typeof ROLLUP_AGGREGATIONS)[number];
export const ROLLUP_LABELS: Record<RollupAggregation, string> = {
  sum: "SUM(values)",
  avg: "AVERAGE(values)",
  min: "MIN(values)",
  max: "MAX(values)",
  count: "COUNT(values) — non-empty",
  countAll: "COUNTALL(values)",
  join: "ARRAYJOIN(values)",
  joinUnique: "ARRAYJOIN(ARRAYUNIQUE(values))",
};
export const NUMERIC_ROLLUPS = new Set<RollupAggregation>(["sum", "avg", "min", "max", "count", "countAll"]);

export const selectChoiceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  color: z.string().default("blue"),
});
export type SelectChoice = z.infer<typeof selectChoiceSchema>;

export const fieldOptionsSchema = z
  .object({
    precision: z.number().int().min(0).max(8).optional(),
    choices: z.array(selectChoiceSchema).optional(),
    /** single / multiple select: the option new records start with. */
    defaultChoiceId: z.string().optional(),
    /** person fields: tell people (in the app and by email) when they're added. */
    notify: z.boolean().optional(),
    includeTime: z.boolean().optional(),
    /** date / created / modified time: how dates are shown (stored values are always ISO). */
    dateFormat: z.enum(["local", "friendly", "us", "european", "iso"]).optional(),
    timeFormat: z.enum(["12", "24"]).optional(),
    /** link: the table linked to, and the matching field on the other side (absent for self-links). */
    linkedTableId: z.string().optional(),
    inverseFieldId: z.string().optional(),
    /** lookup / rollup / count: the link field in this table to follow. */
    linkFieldId: z.string().optional(),
    /** lookup / rollup: the field in the linked table to read. */
    targetFieldId: z.string().optional(),
    aggregation: z.enum(ROLLUP_AGGREGATIONS).optional(),
    /** formula: stored with {fldId} references. */
    formula: z.string().optional(),
    resultType: z.enum(["number", "text", "date", "boolean"]).optional(),
    /** formula: field ids it reads (plus "__modified" for LAST_MODIFIED_TIME). */
    dependsOn: z.array(z.string()).optional(),
    /** formula: uses TODAY()/NOW(), so it is refreshed daily; computedOn is the last refresh day. */
    volatile: z.boolean().optional(),
    computedOn: z.string().optional(),
    /** currency: symbol shown before the amount. */
    symbol: z.string().max(5).optional(),
    /** rating: number of stars (1–10). */
    max: z.number().int().min(1).max(10).optional(),
    /** duration: how it's shown. */
    durationFormat: z.enum(DURATION_FORMATS).optional(),
    /** user: allow more than one person. */
    multiple: z.boolean().optional(),
    /** Who may edit this field's values: everyone who can edit (default), workspace team only, or creators only. */
    editAccess: z.enum(["all", "team", "creators"]).optional(),
  })
  .default({});
export type FieldOptions = z.infer<typeof fieldOptionsSchema>;

export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  position: number;
}

export type CellValue = string | number | boolean | string[] | null;

/** Display names of linked records, by record id. */
export type LinkLabels = Record<string, string>;

export class CellValidationError extends Error {}

/**
 * The plain field type that a field behaves like for filtering, sorting and display:
 * numeric rollups/counts act like numbers, formulas like their result type.
 */
export function effectiveType(field: Pick<Field, "type" | "options">): FieldType {
  if (field.type === "count" || field.type === "autonumber" || NUMBER_LIKE_TYPES.has(field.type)) return "number";
  if (field.type === "createdTime" || field.type === "lastModifiedTime") return "date";
  if (field.type === "createdBy" || field.type === "lastModifiedBy") return "user";
  if (field.type === "rollup") return NUMERIC_ROLLUPS.has(field.options.aggregation ?? "sum") ? "number" : "singleLineText";
  if (field.type === "formula") {
    switch (field.options.resultType) {
      case "number": return "number";
      case "date": return "date";
      case "boolean": return "checkbox";
      default: return "singleLineText";
    }
  }
  return field.type;
}

export function isNumericField(field: Pick<Field, "type" | "options">): boolean {
  return effectiveType(field) === "number";
}

export function formatNumber(n: number, precision?: number) {
  return precision === undefined
    ? n.toLocaleString(undefined, { maximumFractionDigits: 8 })
    : n.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

/** Seconds → "1:30" (h:mm) or "1:30:05" (h:mm:ss). */
export function formatDuration(seconds: number, format: string = "h:mm"): string {
  const neg = seconds < 0;
  const s = Math.round(Math.abs(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (neg ? "-" : "") + (format === "h:mm:ss" ? `${h}:${pad(m)}:${pad(sec)}` : `${h}:${pad(m)}`);
}

/**
 * Typed text → seconds. "1:30" = 1 h 30 min, "1:30:05" adds seconds, "1h 30m" / "45m" / "2.5h" work too,
 * and a plain number means minutes (as when typing into Airtable).
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let m = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(t);
  if (m) return (m[1] ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0));
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 60) : null;
}

/** Strip currency symbols, % signs, spaces and thousands separators from typed numbers. */
function looseNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  // Only symbols may lead ("₹", "$", "€"); letters mean it isn't a number.
  const s = String(raw).replace(/[,\s%]/g, "").replace(/^(-?)[^\d.+\-\p{L}]+/u, "$1");
  return s === "" ? NaN : Number(s);
}

export type DateFormat = "local" | "friendly" | "us" | "european" | "iso";
export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  local: "Local (this computer’s setting)",
  friendly: "Friendly — December 1, 2026",
  us: "US — 12/01/2026",
  european: "European — 01/12/2026",
  iso: "ISO — 2026-12-01",
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Display of a stored date ("YYYY-MM-DD" or full ISO) in the field's chosen format.
 * Date-only values are read as calendar days, so time zones never shift them.
 */
export function formatDateCell(s: string, opts: { dateFormat?: DateFormat; timeFormat?: "12" | "24" } = {}): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(dateOnly ? s + "T00:00:00" : s);
  if (Number.isNaN(d.getTime())) return s;
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  let date: string;
  switch (opts.dateFormat ?? "local") {
    case "friendly": date = `${MONTH_NAMES[m]} ${day}, ${y}`; break;
    case "us": date = `${pad2(m + 1)}/${pad2(day)}/${y}`; break;
    case "european": date = `${pad2(day)}/${pad2(m + 1)}/${y}`; break;
    case "iso": date = `${y}-${pad2(m + 1)}-${pad2(day)}`; break;
    default: date = d.toLocaleDateString();
  }
  if (dateOnly) return date;
  let time: string;
  if (opts.timeFormat === "24") time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  else if (opts.timeFormat === "12") time = `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
  else time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

/** Human-readable text for a stored value (used for type conversion, CSV export, search, cards). */
export function cellToText(field: Pick<Field, "type" | "options">, value: CellValue, labels?: LinkLabels): string {
  if (value === null || value === undefined) return "";
  const choiceName = (id: string) => field.options.choices?.find((c) => c.id === id)?.name ?? "";
  switch (field.type) {
    case "singleSelect":
      return choiceName(String(value));
    case "multipleSelect":
      return (Array.isArray(value) ? value : [String(value)]).map(choiceName).filter(Boolean).join(", ");
    case "checkbox":
      return value ? "checked" : "";
    case "link":
      return (Array.isArray(value) ? value : []).map((id) => labels?.[id] || "Unnamed record").join(", ");
    case "attachment":
      return (Array.isArray(value) ? value : []).map((id) => labels?.[id] || "file").join(", ");
    case "formula":
      if (field.options.resultType === "boolean") return value ? "✓" : "";
      if (field.options.resultType === "date") return formatDateCell(String(value), field.options);
      if (typeof value === "number") return formatNumber(value, field.options.precision);
      return String(value);
    case "count":
    case "rollup":
    case "number":
    case "autonumber":
      return typeof value === "number" ? formatNumber(value, field.options.precision) : String(value);
    case "currency":
      return typeof value === "number"
        ? (value < 0 ? "-" : "") + (field.options.symbol ?? "₹") + formatNumber(Math.abs(value), field.options.precision ?? 2)
        : String(value);
    case "percent":
      return typeof value === "number" ? formatNumber(value, field.options.precision ?? 0) + "%" : String(value);
    case "rating":
      return typeof value === "number" ? "★".repeat(Math.max(0, Math.round(value))) : String(value);
    case "duration":
      return typeof value === "number" ? formatDuration(value, field.options.durationFormat) : String(value);
    case "createdTime":
    case "lastModifiedTime":
      return formatDateCell(String(value), field.options);
    case "user":
    case "createdBy":
    case "lastModifiedBy":
      return (Array.isArray(value) ? value : [String(value)]).map((id) => labels?.[id] || "Unknown user").join(", ");
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** Convert a stored value when a field changes type. Values that can't convert become null (like Airtable). */
export function convertCell(
  from: Pick<Field, "type" | "options" | "name">,
  to: Pick<Field, "type" | "options" | "name">,
  value: CellValue,
): CellValue {
  if (value === null) return null;
  // Between number-like fields keep the number itself, not its formatted text.
  if (typeof value === "number" && NUMBER_LIKE_TYPES.has(to.type)) {
    try {
      return normalizeCell(to, to.type === "rating" ? Math.round(value) : value);
    } catch {
      return null;
    }
  }
  let raw: unknown = cellToText(from, value);
  if (to.type === "multipleSelect") raw = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (to.type === "checkbox") raw = raw === "" || raw === "0" || /^(false|no)$/i.test(String(raw)) ? false : true;
  try {
    return normalizeCell(to, raw);
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise and validate a value for a field. Returns the value to store.
 * Empty values ("" / [] / undefined) become null.
 * For link fields this only checks the shape; the server checks the records exist.
 */
export function normalizeCell(field: Pick<Field, "type" | "options" | "name">, raw: unknown): CellValue {
  if (raw === undefined || raw === null || raw === "") return null;
  const fail = (msg: string): never => {
    throw new CellValidationError(`${field.name}: ${msg}`);
  };

  switch (field.type) {
    case "singleLineText":
    case "phone":
      if (typeof raw !== "string" && typeof raw !== "number") fail("expected text");
      return String(raw).replace(/[\r\n]+/g, " ");
    case "longText":
      if (typeof raw !== "string" && typeof raw !== "number") fail("expected text");
      return String(raw);
    case "email": {
      const s = String(raw).trim();
      if (!EMAIL_RE.test(s)) fail("not a valid email");
      return s;
    }
    case "url": {
      const s = String(raw).trim();
      if (/\s/.test(s)) fail("not a valid URL");
      return s;
    }
    case "number":
    case "currency":
    case "percent": {
      const n = looseNumber(raw);
      if (!Number.isFinite(n)) fail("expected a number");
      const p = field.options.precision ?? (field.type === "currency" ? 2 : field.type === "percent" ? 0 : undefined);
      return p === undefined ? n : Number(n.toFixed(p));
    }
    case "rating": {
      const n = looseNumber(raw);
      const max = field.options.max ?? 5;
      if (!Number.isInteger(n) || n < 0 || n > max) fail(`expected a whole number from 0 to ${max}`);
      return n === 0 ? null : n;
    }
    case "duration": {
      const n = typeof raw === "number" ? raw : parseDuration(String(raw));
      if (n === null || !Number.isFinite(n)) fail('expected a duration like "1:30"');
      return Math.round(n!);
    }
    case "user": {
      const arr = Array.isArray(raw) ? raw : [raw];
      const ids = [...new Set(arr.map((v) => {
        if (typeof v !== "string" || !/^usr[0-9A-Za-z]{14}$/.test(v)) fail("expected user ids");
        return v as string;
      }))];
      if (ids.length > 1 && !field.options.multiple) fail("only one person can be chosen");
      return ids.length ? ids : null;
    }
    case "checkbox":
      if (typeof raw === "boolean") return raw || null;
      if (raw === "true" || raw === 1 || raw === "1") return true;
      if (raw === "false" || raw === 0 || raw === "0") return null;
      return fail("expected true/false");
    case "date": {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) fail("not a valid date");
      return field.options.includeTime ? d.toISOString() : d.toISOString().slice(0, 10);
    }
    case "singleSelect": {
      const choices = field.options.choices ?? [];
      const s = String(raw);
      const match = choices.find((c) => c.id === s || c.name === s);
      if (!match) fail(`"${s}" is not an option`);
      return match!.id;
    }
    case "multipleSelect": {
      const arr = Array.isArray(raw) ? raw : [raw];
      const choices = field.options.choices ?? [];
      const ids = arr.map((v) => {
        const m = choices.find((c) => c.id === String(v) || c.name === String(v));
        if (!m) fail(`"${String(v)}" is not an option`);
        return m!.id;
      });
      const unique = [...new Set(ids)];
      return unique.length ? unique : null;
    }
    case "link": {
      const arr = Array.isArray(raw) ? raw : [raw];
      const ids = arr.map((v) => {
        if (typeof v !== "string" || !/^rec[0-9A-Za-z]{14}$/.test(v)) fail("expected record ids");
        return v as string;
      });
      const unique = [...new Set(ids)];
      return unique.length ? unique : null;
    }
    case "attachment": {
      const arr = Array.isArray(raw) ? raw : [raw];
      const ids = arr.map((v) => {
        if (typeof v !== "string" || !/^att[0-9A-Za-z]{14}$/.test(v)) fail("expected attachment ids");
        return v as string;
      });
      const unique = [...new Set(ids)];
      return unique.length ? unique : null;
    }
    case "lookup":
    case "rollup":
    case "count":
    case "formula":
    case "autonumber":
    case "createdTime":
    case "lastModifiedTime":
    case "createdBy":
    case "lastModifiedBy":
      return fail("this field is calculated automatically and can't be edited");
  }
}
