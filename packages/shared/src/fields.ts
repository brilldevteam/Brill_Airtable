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
};

/** Fields whose values are calculated by the server and can't be typed into. */
export const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup", "count", "formula"]);
/** Field types that can't be converted to or from another type (yet). */
export const STRUCTURAL_TYPES = new Set<FieldType>(["link", "lookup", "rollup", "count", "formula", "attachment"]);

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
    includeTime: z.boolean().optional(),
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
  if (field.type === "count") return "number";
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

/** Local display of a stored date ("YYYY-MM-DD" or full ISO). */
export function formatDateCell(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00").toLocaleDateString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
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
      if (field.options.resultType === "date") return formatDateCell(String(value));
      if (typeof value === "number") return formatNumber(value, field.options.precision);
      return String(value);
    case "count":
    case "rollup":
    case "number":
      return typeof value === "number" ? formatNumber(value, field.options.precision) : String(value);
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
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
      if (!Number.isFinite(n)) fail("expected a number");
      const p = field.options.precision;
      return p === undefined ? n : Number(n.toFixed(p));
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
      return fail("this field is calculated automatically and can't be edited");
  }
}
