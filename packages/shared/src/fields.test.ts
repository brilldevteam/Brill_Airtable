import { describe, expect, it } from "vitest";
import { CellValidationError, normalizeCell } from "./fields";

const f = (type: any, options: any = {}) => ({ name: "F", type, options });

describe("normalizeCell", () => {
  it("empties become null", () => {
    expect(normalizeCell(f("singleLineText"), "")).toBeNull();
    expect(normalizeCell(f("multipleSelect", { choices: [] }), [])).toBeNull();
  });
  it("numbers parse and round to precision", () => {
    expect(normalizeCell(f("number", { precision: 2 }), "1,234.567")).toBe(1234.57);
    expect(() => normalizeCell(f("number"), "abc")).toThrow(CellValidationError);
  });
  it("single select accepts name or id and stores id", () => {
    const opts = { choices: [{ id: "selA", name: "Todo", color: "blue" }] };
    expect(normalizeCell(f("singleSelect", opts), "Todo")).toBe("selA");
    expect(normalizeCell(f("singleSelect", opts), "selA")).toBe("selA");
    expect(() => normalizeCell(f("singleSelect", opts), "Nope")).toThrow();
  });
  it("checkbox false is stored as null", () => {
    expect(normalizeCell(f("checkbox"), false)).toBeNull();
    expect(normalizeCell(f("checkbox"), true)).toBe(true);
  });
  it("validates email and dates", () => {
    expect(() => normalizeCell(f("email"), "bad")).toThrow();
    expect(normalizeCell(f("date"), "2026-11-12T10:00:00Z")).toBe("2026-11-12");
  });
});
