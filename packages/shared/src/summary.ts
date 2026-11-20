import { cellToText, effectiveType, formatDateCell, formatNumber, type CellValue, type Field, type LinkLabels } from "./fields";

/**
 * Column summaries for the grid's summary bar and group headers (like Airtable's "Summarize").
 * Every field can count; numbers can add up; dates can show their span.
 */
export const SUMMARY_KINDS = [
  "none", "filled", "empty", "unique", "percentFilled", "percentEmpty",
  "sum", "avg", "median", "min", "max", "range",
  "earliest", "latest", "dateRange",
  "checked", "unchecked", "percentChecked",
] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export const SUMMARY_LABELS: Record<SummaryKind, string> = {
  none: "None",
  filled: "Filled",
  empty: "Empty",
  unique: "Unique",
  percentFilled: "Percent filled",
  percentEmpty: "Percent empty",
  sum: "Sum",
  avg: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  earliest: "Earliest",
  latest: "Latest",
  dateRange: "Range (days)",
  checked: "Checked",
  unchecked: "Unchecked",
  percentChecked: "Percent checked",
};

const COUNTS: SummaryKind[] = ["filled", "empty", "unique", "percentFilled", "percentEmpty"];

/** The summaries that make sense for a field, in menu order. */
export function summaryKindsFor(field: Pick<Field, "type" | "options">): SummaryKind[] {
  switch (effectiveType(field)) {
    case "number": return ["none", "sum", "avg", "median", "min", "max", "range", ...COUNTS];
    case "date": return ["none", "earliest", "latest", "dateRange", ...COUNTS];
    case "checkbox": return ["none", "checked", "unchecked", "percentChecked"];
    default: return ["none", ...COUNTS];
  }
}

const isEmpty = (v: CellValue | undefined) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0) + "%";

/** Format a number the way the field shows its values (currency symbol, %, h:mm…). */
function asField(field: Pick<Field, "type" | "options">, n: number): string {
  if (["currency", "percent", "duration", "rating"].includes(field.type)) {
    return field.type === "rating" ? formatNumber(Math.round(n * 10) / 10) : cellToText(field, n);
  }
  return formatNumber(Math.round(n * 1e6) / 1e6, field.options.precision);
}

/** Work out one summary over a column's values. Returns display text ("" for none). */
export function summarize(field: Pick<Field, "type" | "options">, values: CellValue[], kind: SummaryKind, labels?: LinkLabels): string {
  if (kind === "none") return "";
  const total = values.length;
  const filled = values.filter((v) => !isEmpty(v));
  switch (kind) {
    case "filled": return formatNumber(filled.length);
    case "empty": return formatNumber(total - filled.length);
    case "percentFilled": return pct(filled.length, total);
    case "percentEmpty": return pct(total - filled.length, total);
    case "unique": return formatNumber(new Set(filled.map((v) => cellToText(field, v, labels).toLowerCase())).size);
    case "checked": return formatNumber(values.filter((v) => v === true).length);
    case "unchecked": return formatNumber(values.filter((v) => v !== true).length);
    case "percentChecked": return pct(values.filter((v) => v === true).length, total);
  }
  if (kind === "earliest" || kind === "latest" || kind === "dateRange") {
    const dates = filled.map((v) => String(v)).sort();
    if (!dates.length) return "—";
    if (kind === "earliest") return formatDateCell(dates[0]);
    if (kind === "latest") return formatDateCell(dates[dates.length - 1]);
    const days = Math.round((new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400_000);
    return `${formatNumber(days)} ${days === 1 ? "day" : "days"}`;
  }
  const nums = filled.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => Number.isFinite(n));
  if (!nums.length) return kind === "sum" ? asField(field, 0) : "—";
  const sorted = [...nums].sort((a, b) => a - b);
  switch (kind) {
    case "sum": return asField(field, nums.reduce((a, b) => a + b, 0));
    case "avg": return asField(field, nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min": return asField(field, sorted[0]);
    case "max": return asField(field, sorted[sorted.length - 1]);
    case "range": return asField(field, sorted[sorted.length - 1] - sorted[0]);
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return asField(field, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    }
  }
  return "";
}

/**
 * The value records are grouped by: same text → same group. Dates group by day, text ignores case.
 * Returns [key, label]; empty values share the key "" and the label "(Empty)".
 */
export function groupKey(field: Pick<Field, "type" | "options">, value: CellValue, labels?: LinkLabels): [string, string] {
  const t = effectiveType(field);
  if (t === "checkbox") return value === true ? ["1", "Checked"] : ["", "Unchecked"];
  if (isEmpty(value)) return ["", "(Empty)"];
  if (t === "date") {
    const day = String(value).slice(0, 10);
    return [day, formatDateCell(day)];
  }
  const text = cellToText(field, value, labels);
  return [text.toLowerCase(), text];
}
