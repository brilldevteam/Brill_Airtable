import { LIST_OPS, VALUELESS_OPS, effectiveType, operatorsFor, type Field, type FilterCondition, type ViewConfig } from "@brill/shared";

/**
 * Compiles a view's filters and sorts into a parameterised SQL query over `records`.
 * Field ids and values are always passed as parameters, never concatenated into SQL.
 * Incomplete conditions (no value yet, deleted field, wrong operator) are ignored, like Airtable.
 */
export function buildViewQuery(tableId: string, fields: Field[], config: ViewConfig) {
  const params: unknown[] = [tableId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const byId = new Map(fields.map((f) => [f.id, f]));

  const conditions: string[] = [];
  for (const c of config.filters.conditions) {
    const field = byId.get(c.fieldId);
    if (!field) continue;
    const sql = compileCondition(field, c, p);
    if (sql) conditions.push(sql);
  }
  const joiner = config.filters.conjunction === "or" ? " OR " : " AND ";
  const where = conditions.length ? ` AND (${conditions.join(joiner)})` : "";

  const orderBy: string[] = [];
  for (const s of config.sorts) {
    const field = byId.get(s.fieldId);
    if (!field) continue;
    orderBy.push(`${sortExpr(field, p)} ${s.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`);
  }
  orderBy.push("autonumber ASC");

  return {
    sql: `SELECT * FROM records WHERE table_id = $1 AND deleted_at IS NULL${where} ORDER BY ${orderBy.join(", ")}`,
    params,
  };
}

type P = (v: unknown) => string;

function compileCondition(field: Field, c: FilterCondition, p: P): string | null {
  if (!operatorsFor(field).includes(c.operator)) return null;
  // Each placeholder must be used in the SQL (Postgres can't type unused ones), so the field
  // id parameter is only added once we know the expression is needed.
  let txtSql: string | undefined;
  let jsonSql: string | undefined;
  const ref = {
    get txt() { return (txtSql ??= `(cells->>${p(field.id)})`); },
    get json() { return (jsonSql ??= `(cells->${p(field.id)})`); },
  };
  const op = c.operator;

  if (op === "isEmpty") return `${ref.json} IS NULL`;
  if (op === "isNotEmpty") return `${ref.json} IS NOT NULL`;
  if (op === "isChecked") return `${ref.json} IS NOT NULL`;
  if (op === "isNotChecked") return `${ref.json} IS NULL`;

  const v = c.value;
  if (!VALUELESS_OPS.has(op) && (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0))) {
    return null; // condition not filled in yet
  }

  if (LIST_OPS.has(op)) {
    const list = (Array.isArray(v) ? v : [String(v)]).map(String);
    switch (op) {
      case "isAnyOf": return `${ref.txt} = ANY(${p(list)}::text[])`;
      case "isNoneOf": return `(${ref.txt} IS NULL OR NOT (${ref.txt} = ANY(${p(list)}::text[])))`;
      case "hasAnyOf": return `${ref.json} ?| ${p(list)}::text[]`;
      case "hasAllOf": return `${ref.json} ?& ${p(list)}::text[]`;
      case "hasNoneOf": return `(${ref.json} IS NULL OR NOT (${ref.json} ?| ${p(list)}::text[]))`;
    }
  }

  switch (effectiveType(field)) {
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      const sqlOp = { "=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" }[op as string];
      if (!sqlOp) return null;
      if (op === "!=") return `(${ref.txt} IS NULL OR ${ref.txt}::numeric <> ${p(n)})`;
      return `${ref.txt}::numeric ${sqlOp} ${p(n)}`;
    }
    case "date": {
      const d = resolveDate(String(v));
      if (!d) return null;
      const day = `left(${ref.txt}, 10)`;
      const sqlOp = { is: "=", isBefore: "<", isAfter: ">", isOnOrBefore: "<=", isOnOrAfter: ">=" }[op as string];
      return sqlOp ? `${day} ${sqlOp} ${p(d)}` : null;
    }
    case "singleSelect": {
      if (op === "is") return `${ref.txt} = ${p(String(v))}`;
      if (op === "isNot") return `(${ref.txt} IS NULL OR ${ref.txt} <> ${p(String(v))})`;
      return null;
    }
    default: {
      // Text-like fields: case-insensitive, like Airtable.
      const s = String(v);
      const like = "%" + s.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
      switch (op) {
        case "contains": return `${ref.txt} ILIKE ${p(like)}`;
        case "doesNotContain": return `(${ref.txt} IS NULL OR ${ref.txt} NOT ILIKE ${p(like)})`;
        case "is": return `lower(${ref.txt}) = lower(${p(s)})`;
        case "isNot": return `(${ref.txt} IS NULL OR lower(${ref.txt}) <> lower(${p(s)}))`;
      }
      return null;
    }
  }
}

function sortExpr(field: Field, p: P): string {
  if (effectiveType(field) === "user") return `(SELECT lower(u.name) FROM users u WHERE u.id = (cells->${p(field.id)}->>0))`;
  const txt = `(cells->>${p(field.id)})`;
  switch (effectiveType(field)) {
    case "number":
      return `${txt}::numeric`;
    case "checkbox":
      return `(${txt} IS NOT NULL)`;
    case "singleSelect":
      // Sort by the option order defined on the field, like Airtable.
      return `array_position(${p((field.options.choices ?? []).map((c) => c.id))}::text[], ${txt})`;
    case "date":
      return txt;
    case "user":
      // People sort by name.
      return `(SELECT lower(u.name) FROM users u WHERE u.id = (cells->${p(field.id)}->>0))`;
    default:
      return `lower(${txt})`;
  }
}

/** Accepts YYYY-MM-DD or the relative keywords "today", "tomorrow", "yesterday". */
export function resolveDate(v: string, now = new Date()): string | null {
  const offsets: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1 };
  if (v in offsets) {
    const d = new Date(now);
    d.setDate(d.getDate() + offsets[v]);
    return d.toISOString().slice(0, 10);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
