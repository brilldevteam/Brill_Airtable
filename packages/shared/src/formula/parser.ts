/**
 * Formula language — Airtable-compatible syntax.
 *
 *   IF({Qty} > 10, "Bulk", "Single") & " order"
 *   DATETIME_DIFF({Due}, TODAY(), 'days')
 *
 * Field references are written {Field Name}. Before saving, the server rewrites them to
 * {fldXXXXXXXX} (field ids) so renaming a field never breaks a formula.
 */

export class FormulaError extends Error {
  constructor(message: string, public pos?: number) {
    super(message);
  }
}

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "field"; id: string }
  | { k: "call"; name: string; args: Node[]; pos: number }
  | { k: "bin"; op: BinOp; l: Node; r: Node }
  | { k: "neg"; e: Node };

export type BinOp = "+" | "-" | "*" | "/" | "&" | "=" | "!=" | "<" | ">" | "<=" | ">=";

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "field"; v: string; pos: number }
  | { t: "ident"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "eof"; pos: number };

export const MAX_FORMULA_LENGTH = 5000;

function lex(src: string): Tok[] {
  if (src.length > MAX_FORMULA_LENGTH) throw new FormulaError(`Formula is too long (max ${MAX_FORMULA_LENGTH} characters)`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]), pos: start });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== c) throw new FormulaError("Text is missing its closing quote", start);
      i++;
      out.push({ t: "str", v: s, pos: start });
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new FormulaError("Field name is missing its closing }", start);
      out.push({ t: "field", v: src.slice(i + 1, end), pos: start });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "ident", v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "!=" || two === "<>" || two === "<=" || two === ">=") {
      out.push({ t: "op", v: two === "<>" ? "!=" : two, pos: start });
      i += 2;
      continue;
    }
    if ("+-*/&=<>(),".includes(c)) {
      out.push({ t: "op", v: c, pos: start });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, start);
  }
  out.push({ t: "eof", pos: src.length });
  return out;
}

const PRECEDENCE: Record<string, number> = {
  "=": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4,
};

/**
 * Parse formula text. `resolveField` turns the text inside {…} into a field id
 * (and throws if there's no such field).
 */
export function parseFormula(src: string, resolveField: (ref: string, pos: number) => string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expectOp = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new FormulaError(`Expected "${v}"`, t.pos);
  };

  function primary(depth: number): Node {
    if (depth > 200) throw new FormulaError("Formula is nested too deeply");
    const t = next();
    switch (t.t) {
      case "num": return { k: "num", v: t.v };
      case "str": return { k: "str", v: t.v };
      case "field": return { k: "field", id: resolveField(t.v, t.pos) };
      case "ident": {
        const name = t.v.toUpperCase();
        const n = peek();
        if (n.t === "op" && n.v === "(") {
          next();
          const args: Node[] = [];
          if (!(peek().t === "op" && (peek() as any).v === ")")) {
            for (;;) {
              args.push(expr(0, depth + 1));
              const s = next();
              if (s.t === "op" && s.v === ")") break;
              if (!(s.t === "op" && s.v === ",")) throw new FormulaError(`Expected "," or ")" in ${name}(…)`, s.pos);
            }
          } else next();
          return { k: "call", name, args, pos: t.pos };
        }
        if (name === "TRUE") return { k: "bool", v: true };
        if (name === "FALSE") return { k: "bool", v: false };
        throw new FormulaError(`Unknown name "${t.v}". Put field names in braces, like {${t.v}}`, t.pos);
      }
      case "op":
        if (t.v === "(") {
          const e = expr(0, depth + 1);
          expectOp(")");
          return e;
        }
        if (t.v === "-") return { k: "neg", e: primary(depth + 1) };
        if (t.v === "+") return primary(depth + 1);
        throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
      case "eof":
        throw new FormulaError("Formula ends unexpectedly", t.pos);
    }
  }

  function expr(minPrec: number, depth: number): Node {
    let left = primary(depth);
    for (;;) {
      const t = peek();
      if (t.t !== "op" || !(t.v in PRECEDENCE)) break;
      const prec = PRECEDENCE[t.v];
      if (prec < minPrec) break;
      next();
      const right = expr(prec + 1, depth + 1);
      left = { k: "bin", op: t.v as BinOp, l: left, r: right };
    }
    return left;
  }

  if (!src.trim()) throw new FormulaError("Enter a formula");
  const ast = expr(0, 0);
  const end = peek();
  if (end.t !== "eof") throw new FormulaError("Unexpected text after the end of the formula", end.pos);
  return ast;
}

/** Field ids referenced by a formula. */
export function referencedFields(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "field": out.add(node.id); break;
    case "call": node.args.forEach((a) => referencedFields(a, out)); break;
    case "bin": referencedFields(node.l, out); referencedFields(node.r, out); break;
    case "neg": referencedFields(node.e, out); break;
  }
  return out;
}

/** Function names used by a formula. */
export function usedFunctions(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "call": out.add(node.name); node.args.forEach((a) => usedFunctions(a, out)); break;
    case "bin": usedFunctions(node.l, out); usedFunctions(node.r, out); break;
    case "neg": usedFunctions(node.e, out); break;
  }
  return out;
}

/** Rewrite {Field Name} → {fldId} (to store) or {fldId} → {Field Name} (to show), keeping everything else. */
export function rewriteFieldRefs(src: string, map: (inner: string) => string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      // copy strings verbatim
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) return out + src.slice(i);
      out += "{" + map(src.slice(i + 1, end)) + "}";
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
