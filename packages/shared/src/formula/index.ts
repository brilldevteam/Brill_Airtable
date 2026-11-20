import type { CellValue, Field, LinkLabels } from "../fields";
import {
  dateToIso,
  evaluate,
  FUNCTIONS,
  inferType,
  toDate,
  toNum,
  toText,
  truthy,
  VOLATILE_FUNCTIONS,
  type EvalContext,
  type FType,
  type FValue,
} from "./evaluate";
import { FormulaError, parseFormula, referencedFields, rewriteFieldRefs, usedFunctions, type Node } from "./parser";

export { FormulaError, FUNCTIONS, parseFormula, evaluate, type FType, type FValue, type Node };

/** What a formula's result is stored and shown as. */
export type FormulaResultType = "number" | "text" | "date" | "boolean";

/** Pseudo field id used in dependsOn for LAST_MODIFIED_TIME(). */
export const MODIFIED_DEP = "__modified";

/** The formula-language type of a field's value. */
export function formulaTypeOf(field: Pick<Field, "type" | "options">): FType {
  switch (field.type) {
    case "number":
    case "count":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autonumber":
      return "number";
    case "createdTime":
    case "lastModifiedTime":
      return "date";
    case "user":
    case "createdBy":
    case "lastModifiedBy":
      return "array";
    case "rollup":
      return ["join", "joinUnique"].includes(field.options.aggregation ?? "sum") ? "text" : "number";
    case "date":
      return "date";
    case "checkbox":
      return "boolean";
    case "multipleSelect":
    case "link":
    case "lookup":
    case "attachment":
      return "array";
    case "formula":
      return (field.options.resultType as FType) ?? "text";
    default:
      return "text";
  }
}

export interface CompiledFormula {
  /** Formula text with {fldId} references — what gets stored. */
  canonical: string;
  ast: Node;
  resultType: FormulaResultType;
  dependsOn: string[];
  volatile: boolean;
}

/**
 * Parse a formula as the user typed it ({Field Name} references), check it, and work out its
 * result type and dependencies. Throws FormulaError with a readable message.
 */
export function compileFormula(text: string, fields: Field[], selfId?: string): CompiledFormula {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const resolve = (ref: string, pos?: number): string => {
    const r = ref.trim();
    const f =
      byId.get(r) ??
      fields.find((x) => x.name === r) ??
      fields.find((x) => x.name.toLowerCase() === r.toLowerCase());
    if (!f) throw new FormulaError(`Unknown field {${ref}}`, pos);
    if (f.id === selfId) throw new FormulaError("A formula can't refer to its own field");
    return f.id;
  };
  const canonical = rewriteFieldRefs(text, (inner) => resolve(inner));
  const ast = parseFormula(canonical, (ref, pos) => resolve(ref, pos));
  const t = inferType(ast, (id) => formulaTypeOf(byId.get(id)!));
  const resultType: FormulaResultType = t === "number" || t === "date" || t === "boolean" ? t : "text";
  const fns = usedFunctions(ast);
  const deps = [...referencedFields(ast)];
  if (fns.has("LAST_MODIFIED_TIME")) deps.push(MODIFIED_DEP);
  return { canonical, ast, resultType, dependsOn: deps, volatile: [...fns].some((f) => VOLATILE_FUNCTIONS.has(f)) };
}

/** Show a stored formula with field names instead of ids. */
export function formulaToDisplay(canonical: string, fields: Field[]): string {
  const byId = new Map(fields.map((f) => [f.id, f.name]));
  return rewriteFieldRefs(canonical, (inner) => byId.get(inner) ?? inner);
}

/** Convert a stored cell into a formula value. */
export function cellToFormulaValue(field: Field, value: CellValue, labels: LinkLabels = {}): FValue {
  if (value === null || value === undefined) return null;
  const choice = (id: string) => field.options.choices?.find((c) => c.id === id)?.name ?? null;
  switch (field.type) {
    case "date":
    case "createdTime":
    case "lastModifiedTime":
      return toDate(value as string);
    case "user":
    case "createdBy":
    case "lastModifiedBy":
      return (value as string[]).map((id) => labels[id] ?? "");
    case "checkbox":
      return value === true;
    case "singleSelect":
      return choice(String(value));
    case "multipleSelect":
      return (value as string[]).map(choice).filter((x): x is string => x !== null);
    case "link":
    case "attachment":
      return (value as string[]).map((id) => labels[id] ?? "");
    case "lookup":
      return value as string[];
    case "formula":
      if (field.options.resultType === "date") return toDate(value as string);
      return value as FValue;
    default:
      return value as FValue;
  }
}

/** Convert a formula result into what's stored, according to the formula's result type. */
export function formulaResultToCell(v: FValue, type: FormulaResultType): CellValue {
  if (v === null) return null;
  switch (type) {
    case "number": {
      const n = toNum(v);
      return Number.isFinite(n) ? Math.round(n * 1e10) / 1e10 : null;
    }
    case "date": {
      const d = toDate(v);
      return d ? dateToIso(d) : null;
    }
    case "boolean":
      return truthy(v) ? true : null;
    default: {
      const s = toText(v);
      return s === "" ? null : s;
    }
  }
}

export const FORMULA_ERROR_TEXT = "#ERROR!";

/** Evaluate a compiled formula for one record. Errors become "#ERROR!" (text) or empty (other types). */
export function runFormula(ast: Node, type: FormulaResultType, ctx: EvalContext): CellValue {
  try {
    return formulaResultToCell(evaluate(ast, ctx), type);
  } catch (e) {
    if (e instanceof FormulaError) return type === "text" ? FORMULA_ERROR_TEXT : null;
    throw e;
  }
}

/** Short reference shown in the formula editor. */
export const FUNCTION_GROUPS: Record<string, string[]> = {
  Logic: ["IF", "SWITCH", "AND", "OR", "XOR", "NOT", "BLANK", "ERROR", "ISERROR", "TRUE", "FALSE"],
  Text: ["CONCATENATE", "LEFT", "RIGHT", "MID", "LEN", "FIND", "SEARCH", "SUBSTITUTE", "REPLACE", "UPPER", "LOWER", "TRIM", "REPT", "T", "VALUE", "ENCODE_URL_COMPONENT", "REGEX_MATCH", "REGEX_EXTRACT", "REGEX_REPLACE"],
  Numbers: ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTALL", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "CEILING", "FLOOR", "ABS", "MOD", "SQRT", "POWER", "EXP", "LOG", "EVEN", "ODD"],
  Dates: ["TODAY", "NOW", "DATEADD", "DATETIME_DIFF", "DATETIME_FORMAT", "DATETIME_PARSE", "DATESTR", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY", "WEEKNUM", "WORKDAY", "WORKDAY_DIFF", "IS_BEFORE", "IS_AFTER", "IS_SAME"],
  Lists: ["ARRAYJOIN", "ARRAYUNIQUE", "ARRAYCOMPACT", "ARRAYFLATTEN"],
  Record: ["RECORD_ID", "CREATED_TIME", "LAST_MODIFIED_TIME"],
};
