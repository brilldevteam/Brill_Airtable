import { FormulaError, type Node } from "./parser";

/** Runtime values inside a formula. Dates are JS Date objects. */
export type FValue = number | string | boolean | Date | null | FValue[];
/** Static result types, used to decide how results are stored, shown, filtered and sorted. */
export type FType = "number" | "text" | "date" | "boolean" | "array" | "any";

export interface EvalContext {
  /** Value of a field for the current record, already converted to a formula value. */
  field: (id: string) => FValue;
  recordId: string;
  createdTime: Date;
  lastModifiedTime: Date;
  now: Date;
}

// ---------------- coercions ----------------
export function isBlank(v: FValue): boolean {
  return v === null || v === "" || (Array.isArray(v) && v.every(isBlank));
}

function single(v: FValue): FValue {
  if (Array.isArray(v)) {
    const vals = v.flat(Infinity as 1) as FValue[];
    return vals.length === 0 ? null : vals.length === 1 ? vals[0] : vals.map(toText).join(", ");
  }
  return v;
}

export function toNum(v: FValue): number {
  v = single(v);
  if (v === null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  const n = Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) throw new FormulaError(`Can't use "${v}" as a number`);
  return n;
}

export function toText(v: FValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return (v.flat(Infinity as 1) as FValue[]).filter((x) => !isBlank(x)).map(toText).join(", ");
  if (v instanceof Date) return dateToIso(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  return v;
}

export function truthy(v: FValue): boolean {
  if (Array.isArray(v)) return !isBlank(v);
  return !(v === null || v === "" || v === 0 || v === false || (typeof v === "number" && Number.isNaN(v)));
}

export function toDate(v: FValue): Date | null {
  v = single(v);
  if (v === null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00Z") : new Date(s);
  if (Number.isNaN(d.getTime())) throw new FormulaError(`"${s}" is not a date`);
  return d;
}

/** Date-only ISO when the time is exactly midnight UTC, else full ISO. */
export function dateToIso(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

const flat = (args: FValue[]): FValue[] => (args.flat(Infinity as 1) as FValue[]);

// ---------------- date helpers ----------------
const UNIT_ALIASES: Record<string, string> = {
  ms: "milliseconds", millisecond: "milliseconds", milliseconds: "milliseconds",
  s: "seconds", second: "seconds", seconds: "seconds",
  m: "minutes", minute: "minutes", minutes: "minutes",
  h: "hours", hour: "hours", hours: "hours",
  d: "days", day: "days", days: "days",
  w: "weeks", week: "weeks", weeks: "weeks",
  M: "months", month: "months", months: "months",
  Q: "quarters", quarter: "quarters", quarters: "quarters",
  y: "years", year: "years", years: "years",
};
function unit(u: FValue, def = "days"): string {
  const s = u === null || u === "" ? def : String(u);
  const r = UNIT_ALIASES[s] ?? UNIT_ALIASES[s.toLowerCase()];
  if (!r) throw new FormulaError(`Unknown time unit "${s}"`);
  return r;
}
const MS: Record<string, number> = {
  milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5,
};

function addToDate(d: Date, n: number, u: string): Date {
  const r = new Date(d.getTime());
  if (u in MS) return new Date(d.getTime() + n * MS[u]);
  const months = u === "months" ? n : u === "quarters" ? n * 3 : n * 12;
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

function diff(a: Date, b: Date, u: string): number {
  if (u in MS) return Math.trunc((a.getTime() - b.getTime()) / MS[u]);
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  // Not a full month yet?
  const shifted = addToDate(b, months, "months");
  if (months > 0 && shifted > a) months--;
  if (months < 0 && shifted < a) months++;
  return u === "months" ? months : u === "quarters" ? Math.trunc(months / 3) : Math.trunc(months / 12);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate(), H = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  const map: Record<string, string> = {
    YYYY: String(Y), YY: pad(Y % 100), MMMM: MONTHS[M], MMM: MONTHS[M].slice(0, 3), MM: pad(M + 1), M: String(M + 1),
    DD: pad(D), D: String(D), dddd: DAYS[d.getUTCDay()], ddd: DAYS[d.getUTCDay()].slice(0, 3),
    HH: pad(H), H: String(H), hh: pad(H % 12 || 12), h: String(H % 12 || 12), mm: pad(m), ss: pad(s),
    A: H < 12 ? "AM" : "PM", a: H < 12 ? "am" : "pm",
    LL: `${MONTHS[M]} ${D}, ${Y}`, L: `${pad(M + 1)}/${pad(D)}/${Y}`,
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a|LL|L/g, (tok, lit) => lit ?? map[tok]);
}

const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

// ---------------- functions ----------------
type Fn = {
  min: number;
  max: number; // Infinity for variadic
  ret: FType | ((argTypes: FType[]) => FType);
  /** Lazy functions get unevaluated nodes (IF, SWITCH, ISERROR…). */
  lazy?: (args: Node[], ev: (n: Node) => FValue) => FValue;
  fn?: (args: FValue[], ctx: EvalContext) => FValue;
};

const MAX_TEXT = 100_000;
const capText = (s: string) => {
  if (s.length > MAX_TEXT) throw new FormulaError("Result text is too long");
  return s;
};
const safeRegex = (re: FValue) => {
  const s = toText(re);
  if (s.length > 300) throw new FormulaError("Regular expression is too long");
  try {
    return new RegExp(s);
  } catch {
    throw new FormulaError(`Invalid regular expression "${s}"`);
  }
};
const roundHalfAway = (n: number, p: number) => {
  const f = 10 ** p;
  return (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f;
};

export const FUNCTIONS: Record<string, Fn> = {
  // ---- logic ----
  IF: {
    min: 2, max: 3, ret: (t) => (t[1] === "any" && t[2] ? t[2] : t[1]),
    lazy: (a, ev) => (truthy(ev(a[0])) ? ev(a[1]) : a[2] ? ev(a[2]) : null),
  },
  SWITCH: {
    min: 2, max: Infinity, ret: (t) => t[2] ?? t[1] ?? "any",
    lazy: (a, ev) => {
      const v = ev(a[0]);
      let i = 1;
      for (; i + 1 < a.length; i += 2) {
        const p = ev(a[i]);
        if (v === p || toText(v) === toText(p)) return ev(a[i + 1]);
      }
      return i < a.length ? ev(a[i]) : null;
    },
  },
  AND: { min: 1, max: Infinity, ret: "boolean", fn: (a) => flat(a).every(truthy) },
  OR: { min: 1, max: Infinity, ret: "boolean", fn: (a) => flat(a).some(truthy) },
  XOR: { min: 1, max: Infinity, ret: "boolean", fn: (a) => flat(a).filter(truthy).length % 2 === 1 },
  NOT: { min: 1, max: 1, ret: "boolean", fn: (a) => !truthy(a[0]) },
  TRUE: { min: 0, max: 0, ret: "boolean", fn: () => true },
  FALSE: { min: 0, max: 0, ret: "boolean", fn: () => false },
  BLANK: { min: 0, max: 0, ret: "any", fn: () => null },
  ERROR: { min: 0, max: 1, ret: "any", fn: (a) => { throw new FormulaError(a[0] ? toText(a[0]) : "ERROR()"); } },
  ISERROR: {
    min: 1, max: 1, ret: "boolean",
    lazy: (a, ev) => {
      try { ev(a[0]); return false; } catch (e) { if (e instanceof FormulaError) return true; throw e; }
    },
  },

  // ---- text ----
  CONCATENATE: { min: 1, max: Infinity, ret: "text", fn: (a) => capText(a.map(toText).join("")) },
  LEFT: { min: 2, max: 2, ret: "text", fn: (a) => toText(a[0]).slice(0, Math.max(0, toNum(a[1]))) },
  RIGHT: { min: 2, max: 2, ret: "text", fn: (a) => { const s = toText(a[0]); const n = Math.max(0, toNum(a[1])); return n ? s.slice(-n) : ""; } },
  MID: { min: 3, max: 3, ret: "text", fn: (a) => { const st = Math.max(1, toNum(a[1])); return toText(a[0]).substr(st - 1, Math.max(0, toNum(a[2]))); } },
  LEN: { min: 1, max: 1, ret: "number", fn: (a) => toText(a[0]).length },
  FIND: {
    min: 2, max: 3, ret: "number",
    fn: (a) => toText(a[1]).indexOf(toText(a[0]), Math.max(0, (a[2] === undefined ? 1 : toNum(a[2])) - 1)) + 1,
  },
  SEARCH: {
    min: 2, max: 3, ret: "number",
    fn: (a) => {
      const i = toText(a[1]).toLowerCase().indexOf(toText(a[0]).toLowerCase(), Math.max(0, (a[2] === undefined ? 1 : toNum(a[2])) - 1));
      return i < 0 ? null : i + 1;
    },
  },
  SUBSTITUTE: {
    min: 3, max: 4, ret: "text",
    fn: (a) => {
      const [s, o, n] = [toText(a[0]), toText(a[1]), toText(a[2])];
      if (!o) return s;
      if (a[3] === undefined) return capText(s.split(o).join(n));
      const idx = toNum(a[3]);
      let count = 0;
      return s.replace(new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (m) => (++count === idx ? n : m));
    },
  },
  REPLACE: {
    min: 4, max: 4, ret: "text",
    fn: (a) => { const s = toText(a[0]); const st = Math.max(1, toNum(a[1])) - 1; return capText(s.slice(0, st) + toText(a[3]) + s.slice(st + toNum(a[2]))); },
  },
  UPPER: { min: 1, max: 1, ret: "text", fn: (a) => toText(a[0]).toUpperCase() },
  LOWER: { min: 1, max: 1, ret: "text", fn: (a) => toText(a[0]).toLowerCase() },
  TRIM: { min: 1, max: 1, ret: "text", fn: (a) => toText(a[0]).trim().replace(/\s+/g, " ") },
  REPT: {
    min: 2, max: 2, ret: "text",
    fn: (a) => {
      const s = toText(a[0]);
      const n = Math.max(0, Math.floor(toNum(a[1])));
      if (s.length * n > MAX_TEXT) throw new FormulaError("Result text is too long");
      return s.repeat(n);
    },
  },
  T: { min: 1, max: 1, ret: "text", fn: (a) => (typeof single(a[0]) === "string" ? (single(a[0]) as string) : "") },
  VALUE: { min: 1, max: 1, ret: "number", fn: (a) => toNum(toText(a[0]).replace(/[^0-9.\-eE]/g, "")) },
  ENCODE_URL_COMPONENT: { min: 1, max: 1, ret: "text", fn: (a) => encodeURIComponent(toText(a[0])) },
  REGEX_MATCH: { min: 2, max: 2, ret: "boolean", fn: (a) => safeRegex(a[1]).test(toText(a[0]).slice(0, MAX_TEXT)) },
  REGEX_EXTRACT: { min: 2, max: 2, ret: "text", fn: (a) => safeRegex(a[1]).exec(toText(a[0]).slice(0, MAX_TEXT))?.[0] ?? null },
  REGEX_REPLACE: {
    min: 3, max: 3, ret: "text",
    fn: (a) => capText(toText(a[0]).slice(0, MAX_TEXT).replace(new RegExp(safeRegex(a[1]).source, "g"), toText(a[2]))),
  },

  // ---- numbers ----
  SUM: { min: 1, max: Infinity, ret: "number", fn: (a) => flat(a).reduce<number>((s, v) => s + toNum(v), 0) },
  AVERAGE: {
    min: 1, max: Infinity, ret: "number",
    fn: (a) => { const v = flat(a).filter((x) => !isBlank(x)); return v.length ? v.reduce<number>((s, x) => s + toNum(x), 0) / v.length : null; },
  },
  MIN: { min: 1, max: Infinity, ret: "number", fn: (a) => { const v = flat(a).filter((x) => !isBlank(x)).map(toNum); return v.length ? Math.min(...v) : null; } },
  MAX: { min: 1, max: Infinity, ret: "number", fn: (a) => { const v = flat(a).filter((x) => !isBlank(x)).map(toNum); return v.length ? Math.max(...v) : null; } },
  COUNT: { min: 1, max: Infinity, ret: "number", fn: (a) => flat(a).filter((v) => typeof v === "number").length },
  COUNTA: { min: 1, max: Infinity, ret: "number", fn: (a) => flat(a).filter((v) => !isBlank(v)).length },
  COUNTALL: { min: 1, max: Infinity, ret: "number", fn: (a) => flat(a).length },
  ROUND: { min: 1, max: 2, ret: "number", fn: (a) => roundHalfAway(toNum(a[0]), a[1] === undefined ? 0 : toNum(a[1])) },
  ROUNDUP: {
    min: 1, max: 2, ret: "number",
    fn: (a) => { const f = 10 ** (a[1] === undefined ? 0 : toNum(a[1])); const n = toNum(a[0]); return (Math.sign(n) * Math.ceil(Math.abs(n) * f - 1e-9)) / f; },
  },
  ROUNDDOWN: {
    min: 1, max: 2, ret: "number",
    fn: (a) => { const f = 10 ** (a[1] === undefined ? 0 : toNum(a[1])); const n = toNum(a[0]); return (Math.sign(n) * Math.floor(Math.abs(n) * f + 1e-9)) / f; },
  },
  INT: { min: 1, max: 1, ret: "number", fn: (a) => Math.floor(toNum(a[0])) },
  CEILING: { min: 1, max: 2, ret: "number", fn: (a) => { const s = a[1] === undefined ? 1 : toNum(a[1]) || 1; return Math.ceil(toNum(a[0]) / s) * s; } },
  FLOOR: { min: 1, max: 2, ret: "number", fn: (a) => { const s = a[1] === undefined ? 1 : toNum(a[1]) || 1; return Math.floor(toNum(a[0]) / s) * s; } },
  ABS: { min: 1, max: 1, ret: "number", fn: (a) => Math.abs(toNum(a[0])) },
  MOD: {
    min: 2, max: 2, ret: "number",
    fn: (a) => { const d = toNum(a[1]); if (d === 0) throw new FormulaError("Division by zero"); const n = toNum(a[0]); return n - d * Math.floor(n / d); },
  },
  SQRT: { min: 1, max: 1, ret: "number", fn: (a) => { const n = toNum(a[0]); if (n < 0) throw new FormulaError("SQRT of a negative number"); return Math.sqrt(n); } },
  POWER: { min: 2, max: 2, ret: "number", fn: (a) => toNum(a[0]) ** toNum(a[1]) },
  EXP: { min: 1, max: 1, ret: "number", fn: (a) => Math.exp(toNum(a[0])) },
  LOG: { min: 1, max: 2, ret: "number", fn: (a) => Math.log(toNum(a[0])) / Math.log(a[1] === undefined ? 10 : toNum(a[1])) },
  EVEN: { min: 1, max: 1, ret: "number", fn: (a) => { const n = toNum(a[0]); const r = Math.sign(n) * Math.ceil(Math.abs(n) / 2) * 2; return r; } },
  ODD: { min: 1, max: 1, ret: "number", fn: (a) => { const n = toNum(a[0]); let r = Math.sign(n || 1) * Math.ceil(Math.abs(n)); if (r % 2 === 0) r += Math.sign(n || 1); return r; } },

  // ---- dates ----
  TODAY: { min: 0, max: 0, ret: "date", fn: (_a, c) => new Date(Date.UTC(c.now.getUTCFullYear(), c.now.getUTCMonth(), c.now.getUTCDate())) },
  NOW: { min: 0, max: 0, ret: "date", fn: (_a, c) => c.now },
  DATEADD: {
    min: 3, max: 3, ret: "date",
    fn: (a) => { const d = toDate(a[0]); return d ? addToDate(d, toNum(a[1]), unit(a[2])) : null; },
  },
  DATETIME_DIFF: {
    min: 2, max: 3, ret: "number",
    fn: (a) => { const x = toDate(a[0]); const y = toDate(a[1]); return x && y ? diff(x, y, unit(a[2] ?? null, "seconds")) : null; },
  },
  DATETIME_FORMAT: {
    min: 1, max: 2, ret: "text",
    fn: (a) => { const d = toDate(a[0]); return d ? formatDate(d, a[1] === undefined ? "YYYY-MM-DD" : toText(a[1])) : null; },
  },
  DATETIME_PARSE: { min: 1, max: 3, ret: "date", fn: (a) => toDate(toText(a[0])) },
  DATESTR: { min: 1, max: 1, ret: "text", fn: (a) => { const d = toDate(a[0]); return d ? formatDate(d, "YYYY-MM-DD") : null; } },
  YEAR: { min: 1, max: 1, ret: "number", fn: (a) => toDate(a[0])?.getUTCFullYear() ?? null },
  MONTH: { min: 1, max: 1, ret: "number", fn: (a) => { const d = toDate(a[0]); return d ? d.getUTCMonth() + 1 : null; } },
  DAY: { min: 1, max: 1, ret: "number", fn: (a) => toDate(a[0])?.getUTCDate() ?? null },
  HOUR: { min: 1, max: 1, ret: "number", fn: (a) => toDate(a[0])?.getUTCHours() ?? null },
  MINUTE: { min: 1, max: 1, ret: "number", fn: (a) => toDate(a[0])?.getUTCMinutes() ?? null },
  SECOND: { min: 1, max: 1, ret: "number", fn: (a) => toDate(a[0])?.getUTCSeconds() ?? null },
  WEEKDAY: { min: 1, max: 2, ret: "number", fn: (a) => { const d = toDate(a[0]); if (!d) return null; const w = d.getUTCDay(); return toText(a[1] ?? "") === "Monday" ? (w + 6) % 7 : w; } },
  WEEKNUM: {
    min: 1, max: 2, ret: "number",
    fn: (a) => { const d = toDate(a[0]); if (!d) return null; const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.floor(((d.getTime() - jan1) / 864e5 + new Date(jan1).getUTCDay()) / 7) + 1; },
  },
  WORKDAY: {
    min: 2, max: 2, ret: "date",
    fn: (a) => {
      const d = toDate(a[0]); if (!d) return null;
      let n = Math.trunc(toNum(a[1]));
      if (Math.abs(n) > 100_000) throw new FormulaError("Too many workdays");
      const step = n < 0 ? -1 : 1;
      let cur = new Date(d.getTime());
      while (n !== 0) { cur = addToDate(cur, step, "days"); if (!isWeekend(cur)) n -= step; }
      return cur;
    },
  },
  WORKDAY_DIFF: {
    min: 2, max: 2, ret: "number",
    fn: (a) => {
      const x = toDate(a[0]); const y = toDate(a[1]); if (!x || !y) return null;
      const [s, e, sign] = x <= y ? [x, y, 1] : [y, x, -1];
      const days = Math.floor((e.getTime() - s.getTime()) / 864e5);
      if (days > 400_000) throw new FormulaError("Date range is too large");
      let count = 0;
      for (let i = 0; i <= days; i++) if (!isWeekend(addToDate(s, i, "days"))) count++;
      return sign * count;
    },
  },
  IS_BEFORE: { min: 2, max: 2, ret: "boolean", fn: (a) => { const x = toDate(a[0]); const y = toDate(a[1]); return !!(x && y && x < y); } },
  IS_AFTER: { min: 2, max: 2, ret: "boolean", fn: (a) => { const x = toDate(a[0]); const y = toDate(a[1]); return !!(x && y && x > y); } },
  IS_SAME: {
    min: 2, max: 3, ret: "boolean",
    fn: (a) => {
      const x = toDate(a[0]); const y = toDate(a[1]); if (!x || !y) return false;
      const u = a[2] === undefined ? "milliseconds" : unit(a[2]);
      const fmt = { years: "YYYY", quarters: "YYYY-Q", months: "YYYY-MM", weeks: "", days: "YYYY-MM-DD", hours: "YYYY-MM-DD HH", minutes: "YYYY-MM-DD HH:mm", seconds: "YYYY-MM-DD HH:mm:ss", milliseconds: "" }[u];
      if (u === "milliseconds") return x.getTime() === y.getTime();
      if (u === "weeks") return Math.floor((x.getTime() / 864e5 + 4) / 7) === Math.floor((y.getTime() / 864e5 + 4) / 7);
      if (u === "quarters") return x.getUTCFullYear() === y.getUTCFullYear() && Math.floor(x.getUTCMonth() / 3) === Math.floor(y.getUTCMonth() / 3);
      return formatDate(x, fmt!) === formatDate(y, fmt!);
    },
  },

  // ---- arrays ----
  ARRAYJOIN: { min: 1, max: 2, ret: "text", fn: (a) => flat([a[0]]).filter((v) => !isBlank(v)).map(toText).join(a[1] === undefined ? ", " : toText(a[1])) },
  ARRAYUNIQUE: { min: 1, max: 1, ret: "array", fn: (a) => { const seen = new Set<string>(); return flat([a[0]]).filter((v) => { const k = toText(v); return seen.has(k) ? false : (seen.add(k), true); }); } },
  ARRAYCOMPACT: { min: 1, max: 1, ret: "array", fn: (a) => flat([a[0]]).filter((v) => !isBlank(v)) },
  ARRAYFLATTEN: { min: 1, max: 1, ret: "array", fn: (a) => flat([a[0]]) },

  // ---- record ----
  RECORD_ID: { min: 0, max: 0, ret: "text", fn: (_a, c) => c.recordId },
  CREATED_TIME: { min: 0, max: 0, ret: "date", fn: (_a, c) => c.createdTime },
  LAST_MODIFIED_TIME: { min: 0, max: 1, ret: "date", fn: (_a, c) => c.lastModifiedTime },
};

/** Functions whose result changes over time without any data changing. */
export const VOLATILE_FUNCTIONS = new Set(["TODAY", "NOW"]);

// ---------------- evaluation ----------------
function compare(op: string, l: FValue, r: FValue): boolean {
  l = single(l);
  r = single(r);
  if (op === "=" || op === "!=") {
    let eq: boolean;
    if (l instanceof Date || r instanceof Date) {
      const a = toDate(l), b = toDate(r);
      eq = !!a && !!b && a.getTime() === b.getTime();
    } else if (typeof l === "number" || typeof r === "number" || typeof l === "boolean" || typeof r === "boolean") {
      eq = isBlank(l) && isBlank(r) ? true : (() => { try { return toNum(l) === toNum(r); } catch { return false; } })();
    } else eq = toText(l) === toText(r);
    return op === "=" ? eq : !eq;
  }
  let a: number | string, b: number | string;
  if (l instanceof Date || r instanceof Date) {
    a = toDate(l)?.getTime() ?? -Infinity;
    b = toDate(r)?.getTime() ?? -Infinity;
  } else if (typeof l === "string" && typeof r === "string" && !(l.trim() !== "" && !Number.isNaN(Number(l)) && r.trim() !== "" && !Number.isNaN(Number(r)))) {
    a = l;
    b = r;
  } else {
    a = toNum(l);
    b = toNum(r);
  }
  switch (op) {
    case "<": return a < b;
    case ">": return a > b;
    case "<=": return a <= b;
    default: return a >= b;
  }
}

export function evaluate(node: Node, ctx: EvalContext): FValue {
  let steps = 0;
  const ev = (n: Node): FValue => {
    if (++steps > 100_000) throw new FormulaError("Formula is too complex");
    switch (n.k) {
      case "num": return n.v;
      case "str": return n.v;
      case "bool": return n.v;
      case "field": return ctx.field(n.id);
      case "neg": return -toNum(ev(n.e));
      case "bin": {
        const l = ev(n.l);
        const r = ev(n.r);
        switch (n.op) {
          case "&": return capText(toText(l) + toText(r));
          case "+": {
            // date + number of days is allowed in Airtable? No — use DATEADD. Keep numeric.
            return toNum(l) + toNum(r);
          }
          case "-": {
            if (single(l) instanceof Date && single(r) instanceof Date) return (toNum(l) - toNum(r)) / 864e5;
            return toNum(l) - toNum(r);
          }
          case "*": return toNum(l) * toNum(r);
          case "/": {
            const d = toNum(r);
            if (d === 0) throw new FormulaError("Division by zero");
            return toNum(l) / d;
          }
          default: return compare(n.op, l, r);
        }
      }
      case "call": {
        const f = FUNCTIONS[n.name];
        if (!f) throw new FormulaError(`Unknown function ${n.name}()`, n.pos);
        if (f.lazy) return f.lazy(n.args, ev);
        return f.fn!(n.args.map(ev), ctx);
      }
    }
  };
  return ev(node);
}

// ---------------- static checks ----------------
/**
 * Check function names / argument counts and infer the result type.
 * `fieldType` gives the formula type of a referenced field.
 */
export function inferType(node: Node, fieldType: (id: string) => FType): FType {
  switch (node.k) {
    case "num": return "number";
    case "str": return "text";
    case "bool": return "boolean";
    case "field": return fieldType(node.id);
    case "neg": inferType(node.e, fieldType); return "number";
    case "bin": {
      const l = inferType(node.l, fieldType);
      const r = inferType(node.r, fieldType);
      if (node.op === "&") return "text";
      if (node.op === "-" && l === "date" && r === "date") return "number";
      if ("+-*/".includes(node.op)) return "number";
      return "boolean";
    }
    case "call": {
      const f = FUNCTIONS[node.name];
      if (!f) throw new FormulaError(`Unknown function ${node.name}()`, node.pos);
      const n = node.args.length;
      if (n < f.min || n > f.max) {
        const want = f.min === f.max ? `${f.min}` : f.max === Infinity ? `at least ${f.min}` : `${f.min} to ${f.max}`;
        throw new FormulaError(`${node.name}() takes ${want} argument${f.min === 1 && f.max === 1 ? "" : "s"}, got ${n}`, node.pos);
      }
      const argTypes = node.args.map((a) => inferType(a, fieldType));
      return typeof f.ret === "function" ? f.ret(argTypes) : f.ret;
    }
  }
}
