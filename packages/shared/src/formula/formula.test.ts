import { describe, expect, it } from "vitest";
import type { CellValue, Field } from "../fields";
import { cellToFormulaValue, compileFormula, formulaToDisplay, runFormula, FormulaError } from "./index";

const fields: Field[] = [
  { id: "fldName", tableId: "t", name: "Name", type: "singleLineText", options: {}, position: 0 },
  { id: "fldQty", tableId: "t", name: "Qty", type: "number", options: { precision: 0 }, position: 1 },
  { id: "fldPrice", tableId: "t", name: "Unit Price", type: "number", options: { precision: 2 }, position: 2 },
  { id: "fldDue", tableId: "t", name: "Due", type: "date", options: {}, position: 3 },
  { id: "fldPaid", tableId: "t", name: "Paid", type: "checkbox", options: {}, position: 4 },
  {
    id: "fldStatus", tableId: "t", name: "Status", type: "singleSelect", position: 5,
    options: { choices: [{ id: "selA", name: "Todo", color: "blue" }, { id: "selB", name: "Done", color: "green" }] },
  },
  { id: "fldTags", tableId: "t", name: "Tags", type: "lookup", options: {}, position: 6 },
];

const cells: Record<string, CellValue> = {
  fldName: "Banner",
  fldQty: 3,
  fldPrice: 12.5,
  fldDue: "2026-11-20",
  fldPaid: true,
  fldStatus: "selB",
  fldTags: ["Print", "Rush", "Print"],
};

const NOW = new Date("2026-11-12T10:30:00Z");

function run(text: string, c: Record<string, CellValue> = cells) {
  const compiled = compileFormula(text, fields);
  const byId = new Map(fields.map((f) => [f.id, f]));
  return {
    type: compiled.resultType,
    value: runFormula(compiled.ast, compiled.resultType, {
      field: (id) => cellToFormulaValue(byId.get(id)!, c[id] ?? null),
      recordId: "recABC",
      createdTime: new Date("2026-11-01T08:00:00Z"),
      lastModifiedTime: NOW,
      now: NOW,
    }),
  };
}
const v = (text: string, c?: Record<string, CellValue>) => run(text, c).value;

describe("parsing & checking", () => {
  it("resolves field names to ids and back", () => {
    const c = compileFormula("{Qty} * {unit price}", fields);
    expect(c.canonical).toBe("{fldQty} * {fldPrice}");
    expect(c.dependsOn.sort()).toEqual(["fldPrice", "fldQty"]);
    expect(formulaToDisplay(c.canonical, fields)).toBe("{Qty} * {Unit Price}");
  });
  it("leaves braces inside strings alone", () => {
    expect(compileFormula('"{not a field}" & {Name}', fields).canonical).toBe('"{not a field}" & {fldName}');
  });
  it("gives readable errors", () => {
    expect(() => compileFormula("{Nope} + 1", fields)).toThrow(/Unknown field \{Nope\}/);
    expect(() => compileFormula("FOO(1)", fields)).toThrow(/Unknown function FOO/);
    expect(() => compileFormula("IF(1)", fields)).toThrow(/IF\(\) takes 2 to 3 arguments, got 1/);
    expect(() => compileFormula("(1 + 2", fields)).toThrow(FormulaError);
    expect(() => compileFormula("Qty + 1", fields)).toThrow(/in braces/);
    expect(() => compileFormula("{Qty} + 1", fields, "fldQty")).toThrow(/own field/);
  });
  it("infers result types", () => {
    expect(run("{Qty} * 2").type).toBe("number");
    expect(run("{Name} & '!'").type).toBe("text");
    expect(run("DATEADD({Due}, 1, 'days')").type).toBe("date");
    expect(run("{Qty} > 2").type).toBe("boolean");
    expect(run("IF({Paid}, {Qty}, 0)").type).toBe("number");
    expect(compileFormula("TODAY()", fields).volatile).toBe(true);
  });
});

describe("operators", () => {
  it("arithmetic follows precedence", () => {
    expect(v("1 + 2 * 3")).toBe(7);
    expect(v("(1 + 2) * 3")).toBe(9);
    expect(v("-{Qty} + 10")).toBe(7);
    expect(v("{Qty} * {Unit Price}")).toBe(37.5);
    expect(v("10 - 2 - 3")).toBe(5);
    expect(v("12 / 4 / 3")).toBe(1);
  });
  it("& joins text, blanks are empty", () => {
    expect(v("{Name} & ' x' & {Qty}")).toBe("Banner x3");
    expect(v("{Name} & {Missing}".replace("{Missing}", "''"))).toBe("Banner");
  });
  it("comparisons", () => {
    expect(v("{Qty} >= 3")).toBe(true);
    expect(v("{Status} = 'Done'")).toBe(true);
    expect(v("{Name} != 'Banner'")).toBe(null); // false is stored as empty
    expect(v("{Due} < DATETIME_PARSE('2026-12-01')")).toBe(true);
  });
  it("division by zero is an error", () => {
    expect(v("{Qty} / 0")).toBe(null);
    expect(v("'x' & ({Qty} / 0)")).toBe("#ERROR!");
  });
  it("blank fields act as 0 in arithmetic", () => {
    expect(v("{Qty} + 1", { fldQty: null })).toBe(1);
  });
});

describe("functions", () => {
  it("logic", () => {
    expect(v("IF({Paid}, 'yes', 'no')")).toBe("yes");
    expect(v("IF({Qty} > 5, 'big')")).toBe(null);
    expect(v("SWITCH({Status}, 'Todo', 1, 'Done', 2, 0)")).toBe(2);
    expect(v("SWITCH('x', 'a', 1, 99)")).toBe(99);
    expect(v("AND({Paid}, {Qty} > 1)")).toBe(true);
    expect(v("OR(0, '')")).toBe(null);
    expect(v("ISERROR(1/0)")).toBe(true);
    expect(v("IF(ISERROR(ERROR()), 'caught', 'no')")).toBe("caught");
  });
  it("text", () => {
    expect(v("UPPER(LEFT({Name}, 3))")).toBe("BAN");
    expect(v("RIGHT({Name}, 2)")).toBe("er");
    expect(v("MID('abcdef', 2, 3)")).toBe("bcd");
    expect(v("LEN({Name})")).toBe(6);
    expect(v("FIND('n', {Name})")).toBe(3);
    expect(v("FIND('z', {Name})")).toBe(0);
    expect(v("SUBSTITUTE('a-b-c', '-', '+')")).toBe("a+b+c");
    expect(v("SUBSTITUTE('a-b-c', '-', '+', 2)")).toBe("a-b+c");
    expect(v("TRIM('  a   b ')")).toBe("a b");
    expect(v("REPT('ab', 3)")).toBe("ababab");
    expect(v("CONCATENATE('a', 1, 'b')")).toBe("a1b");
    expect(v("REGEX_MATCH({Name}, '^Ban')")).toBe(true);
    expect(v("REGEX_EXTRACT('INV-0042 paid', '[0-9]+')")).toBe("0042");
    expect(v("REGEX_REPLACE('a1b2', '[0-9]', '#')")).toBe("a#b#");
    expect(v("VALUE('$1,234.50')")).toBe(1234.5);
  });
  it("numbers", () => {
    expect(v("ROUND(2.5)")).toBe(3);
    expect(v("ROUND(-2.5)")).toBe(-3);
    expect(v("ROUND(3.14159, 2)")).toBe(3.14);
    expect(v("ROUNDUP(3.01)")).toBe(4);
    expect(v("ROUNDDOWN(3.99)")).toBe(3);
    expect(v("MOD(-7, 3)")).toBe(2);
    expect(v("SUM(1, 2, {Qty})")).toBe(6);
    expect(v("AVERAGE(2, 4)")).toBe(3);
    expect(v("MAX(1, {Qty}, 2)")).toBe(3);
    expect(v("CEILING(7, 5)")).toBe(10);
    expect(v("FLOOR(7, 5)")).toBe(5);
    expect(v("POWER(2, 10)")).toBe(1024);
    expect(v("SQRT(-1)")).toBe(null);
  });
  it("dates", () => {
    expect(v("DATEADD({Due}, 10, 'days')")).toBe("2026-11-30");
    expect(v("DATEADD({Due}, 1, 'months')")).toBe("2026-12-20");
    expect(v("DATETIME_DIFF({Due}, TODAY(), 'days')")).toBe(8);
    expect(v("DATETIME_DIFF('2026-01-31', '2025-12-01', 'months')")).toBe(1);
    expect(v("DATETIME_FORMAT({Due}, 'DD/MM/YYYY')")).toBe("20/11/2026");
    expect(v("DATETIME_FORMAT({Due}, 'dddd, MMMM D')")).toBe("Friday, November 20");
    expect(v("YEAR({Due}) & '-' & MONTH({Due})")).toBe("2026-11");
    expect(v("WEEKDAY({Due})")).toBe(5);
    expect(v("WORKDAY({Due}, 1)")).toBe("2026-11-23");
    expect(v("WORKDAY_DIFF('2026-11-16', '2026-11-20')")).toBe(5);
    expect(v("IS_SAME({Due}, '2026-11-20', 'day')")).toBe(true);
    expect(v("IS_BEFORE(TODAY(), {Due})")).toBe(true);
    expect(v("TODAY()")).toBe("2026-11-12");
    expect(v("NOW()")).toBe("2026-11-12T10:30:00.000Z");
    expect(v("{Due} - DATETIME_PARSE('2026-11-10')")).toBe(10);
  });
  it("lists and record info", () => {
    expect(v("ARRAYJOIN({Tags}, ' | ')")).toBe("Print | Rush | Print");
    expect(v("ARRAYJOIN(ARRAYUNIQUE({Tags}))")).toBe("Print, Rush");
    expect(v("COUNTA({Tags})")).toBe(3);
    expect(v("RECORD_ID()")).toBe("recABC");
    expect(v("DATETIME_FORMAT(CREATED_TIME(), 'YYYY-MM-DD HH:mm')")).toBe("2026-11-01 08:00");
  });
  it("guards against runaway formulas", () => {
    expect(v("LEN(REPT('x', 1000000))")).toBe(null);
  });
});
