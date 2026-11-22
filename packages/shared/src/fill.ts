import type { CellValue, Field } from "./fields";

/**
 * Smart fill (the grid's drag handle), like Excel and Airtable:
 *  - dates continue day by day — or by the step between the selected dates (weekly, monthly…)
 *  - numbers continue when two or more show a step (1, 2 → 3, 4); a single number is copied
 *  - text ending in a number counts up ("Reel 1" → "Reel 2"), keeping zero padding ("Ep 07" → "Ep 08")
 *  - text that reads as a date ("December 01,2026", "1 Dec 2026", "2026-12-01") continues as dates,
 *    written the same way
 *  - anything else repeats the selected values in order
 */
export function fillSeries(
  field: Pick<Field, "type" | "options">,
  source: CellValue[],
  count: number,
  /** 1 = filling downward (after the source), -1 = upward (before it; pass the source nearest-first). */
  direction: 1 | -1 = 1,
): CellValue[] {
  const n = source.length;
  if (n === 0 || count <= 0) return [];
  const cycle = () => Array.from({ length: count }, (_, i) => source[i % n]);
  const series = (nums: number[], single: number | null) => {
    const step = n === 1 ? single : constantStep(nums);
    if (step === null) return null;
    const last = nums[n - 1];
    return Array.from({ length: count }, (_, i) => round(last + step * (i + 1)));
  };

  if (field.type === "date") {
    if (field.options.includeTime) {
      const ms = source.map((v) => (typeof v === "string" ? Date.parse(v) : NaN));
      if (ms.some((x) => !Number.isFinite(x))) return cycle();
      return series(ms, direction * DAY)?.map((x) => new Date(x).toISOString()) ?? cycle();
    }
    const days = source.map((v) => (typeof v === "string" ? isoToDay(v) : null));
    if (days.some((d) => d === null)) return cycle();
    return monthAware(days as number[], count, direction, dayToIso) ?? cycle();
  }

  if (field.type === "number" || field.type === "currency" || field.type === "percent" || field.type === "duration") {
    if (n < 2 || source.some((v) => typeof v !== "number")) return cycle();
    return series(source as number[], null) ?? cycle();
  }

  if (field.type === "singleLineText" || field.type === "longText") {
    if (source.some((v) => typeof v !== "string" || v.trim() === "")) return cycle();
    const texts = (source as string[]).map((s) => s.trim());

    // Dates written as text.
    const parsed = texts.map(parseTextDate);
    if (parsed.every((p) => p !== null)) {
      const ps = parsed as TextDate[];
      const style = { ...ps[n - 1].style, pad: ps.some((p) => p.style.pad) };
      return monthAware(ps.map((p) => p.day), count, direction, (d) => formatTextDate(d, style)) ?? cycle();
    }

    // Text ending in a number.
    const parts = texts.map((s) => /^(.*?)(\d+)$/.exec(s));
    if (parts.every((m) => m !== null)) {
      const ms = parts as RegExpExecArray[];
      const prefix = ms[0][1];
      if (ms.every((m) => m[1] === prefix) && (n > 1 || prefix !== "")) {
        const nums = ms.map((m) => Number(m[2]));
        const width = ms.some((m) => m[2].length > 1 && m[2].startsWith("0")) ? Math.max(...ms.map((m) => m[2].length)) : 0;
        const out = series(nums, direction);
        if (out && out.every((x) => x >= 0)) return out.map((x) => prefix + String(x).padStart(width, "0"));
      }
    }
  }
  return cycle();
}

const DAY = 86_400_000;
const round = (x: number) => Math.round(x * 1e9) / 1e9;

function constantStep(nums: number[]): number | null {
  const step = round(nums[1] - nums[0]);
  for (let i = 2; i < nums.length; i++) if (round(nums[i] - nums[i - 1]) !== step) return null;
  return step;
}

/**
 * Day-based series. Dates on the same day of the month a month (or a year) apart continue by
 * months, so Jan 31 → Feb 28 → Mar 31 stays "end of month"-ish instead of drifting by 30 days.
 */
function monthAware(days: number[], count: number, direction: 1 | -1, format: (day: number) => string): string[] | null {
  const n = days.length;
  if (n === 1) return Array.from({ length: count }, (_, i) => format(days[0] + direction * (i + 1)));
  const ymd = days.map(dayToParts);
  const months = ymd.map(([y, m]) => y * 12 + m);
  const sameDay = ymd.every(([, , d]) => d === ymd[0][2]);
  const mStep = constantStep(months);
  if (sameDay && mStep !== null && mStep !== 0) {
    const [, , d] = ymd[0];
    return Array.from({ length: count }, (_, i) => {
      const total = months[n - 1] + mStep * (i + 1);
      const y = Math.floor(total / 12);
      const m = total - y * 12;
      return format(partsToDay(y, m, Math.min(d, daysInMonth(y, m))));
    });
  }
  const step = constantStep(days);
  if (step === null || step === 0) return null;
  return Array.from({ length: count }, (_, i) => format(days[n - 1] + step * (i + 1)));
}

// Days since 1970-01-01 (UTC), so time zones never shift a date.
function isoToDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
const partsToDay = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / DAY);
function validDay(y: number, m: number, d: number): number | null {
  if (m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return null;
  return partsToDay(y, m, d);
}
function dayToParts(day: number): [number, number, number] {
  const dt = new Date(day * DAY);
  return [dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()];
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function dayToIso(day: number): string {
  const [y, m, d] = dayToParts(day);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

interface TextDateStyle {
  order: "mdy" | "dmy" | "iso";
  /** Month written in full ("December") or short ("Dec"); and its case. */
  long: boolean;
  monthCase: "title" | "upper" | "lower";
  pad: boolean;
  ordinal: boolean;
  /** Separators: between month and day / day and month, and before the year. */
  sep1: string;
  sep2: string;
}
interface TextDate { day: number; style: TextDateStyle }

function monthIndex(token: string): { index: number; long: boolean } | null {
  const t = token.toLowerCase();
  const full = MONTHS.indexOf(t);
  if (full >= 0) return { index: full, long: t.length > 3 };
  if (t === "sept") return { index: 8, long: false };
  const short = MONTHS.findIndex((m) => m.slice(0, 3) === t);
  return short >= 0 ? { index: short, long: false } : null;
}
const caseOf = (s: string): TextDateStyle["monthCase"] => (s === s.toUpperCase() ? "upper" : s === s.toLowerCase() ? "lower" : "title");

/** "December 01,2026", "Dec 1, 2026", "1st December 2026", "2026-12-01" → day number + how it was written. */
export function parseTextDate(s: string): TextDate | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const day = validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return day === null ? null : { day, style: { order: "iso", long: false, monthCase: "title", pad: true, ordinal: false, sep1: "-", sep2: "-" } };
  }
  m = /^([A-Za-z]{3,9})(\.?\s+)(\d{1,2})(st|nd|rd|th)?(\s*,\s*|\s+)(\d{4})$/i.exec(s);
  if (m) {
    const mi = monthIndex(m[1]);
    const day = mi && validDay(Number(m[6]), mi.index, Number(m[3]));
    if (!mi || day === null || day === undefined) return null;
    return { day, style: { order: "mdy", long: mi.long, monthCase: caseOf(m[1]), pad: m[3].length === 2 && m[3][0] === "0", ordinal: !!m[4], sep1: m[2], sep2: m[5] } };
  }
  m = /^(\d{1,2})(st|nd|rd|th)?(\s+)([A-Za-z]{3,9})(\.?,?\s+)(\d{4})$/i.exec(s);
  if (m) {
    const mi = monthIndex(m[4]);
    const day = mi && validDay(Number(m[6]), mi.index, Number(m[1]));
    if (!mi || day === null || day === undefined) return null;
    return { day, style: { order: "dmy", long: mi.long, monthCase: caseOf(m[4]), pad: m[1].length === 2 && m[1][0] === "0", ordinal: !!m[2], sep1: m[3], sep2: m[5] } };
  }
  return null;
}

function formatTextDate(day: number, st: TextDateStyle): string {
  const [y, mo, d] = dayToParts(day);
  if (st.order === "iso") return dayToIso(day);
  let month = st.long ? MONTHS[mo] : MONTHS[mo].slice(0, 3);
  month = st.monthCase === "upper" ? month.toUpperCase() : st.monthCase === "lower" ? month : month[0].toUpperCase() + month.slice(1);
  const dd = (st.pad ? String(d).padStart(2, "0") : String(d)) + (st.ordinal ? ordinal(d) : "");
  return st.order === "mdy" ? `${month}${st.sep1}${dd}${st.sep2}${y}` : `${dd}${st.sep1}${month}${st.sep2}${y}`;
}
function ordinal(d: number) {
  if (d % 100 >= 11 && d % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][d % 10] ?? "th";
}
