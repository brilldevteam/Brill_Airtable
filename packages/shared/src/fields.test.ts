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

import { cellToText as toText2, formatDuration, normalizeCell as norm2, parseDuration } from "./fields";
import { describe as d2, expect as e2, it as i2 } from "vitest";

d2("new field types", () => {
  i2("parses and formats durations", () => {
    e2(parseDuration("1:30")).toBe(5400);
    e2(parseDuration("1:30:05")).toBe(5405);
    e2(parseDuration("2h 15m")).toBe(8100);
    e2(parseDuration("45m")).toBe(2700);
    e2(parseDuration("90")).toBe(5400);
    e2(parseDuration("soon")).toBeNull();
    e2(formatDuration(5405)).toBe("1:30");
    e2(formatDuration(5405, "h:mm:ss")).toBe("1:30:05");
  });
  i2("shows currency, percent and rating", () => {
    const cur = { type: "currency" as const, options: { symbol: "₹", precision: 2 }, name: "Fee" };
    e2(norm2(cur, "₹12,500.555")).toBe(12500.56);
    e2(toText2(cur, -50)).toMatch(/^-₹50\.00$/);
    e2(toText2({ type: "percent", options: {} }, 40)).toBe("40%");
    e2(() => norm2({ type: "rating", options: { max: 5 }, name: "Score" }, 7)).toThrow();
  });
});

import { groupKey, summarize, summaryKindsFor } from "./summary";
d2("summaries and groups", () => {
  const cur = { type: "currency" as const, options: { symbol: "₹", precision: 0 } };
  i2("adds up money the way the field shows it", () => {
    e2(summarize(cur, [100, 250, null], "sum")).toBe("₹350");
    e2(summarize(cur, [100, 250, null], "avg")).toBe("₹175");
    e2(summarize(cur, [100, 250, null, 50], "median")).toBe("₹100");
    e2(summarize(cur, [100, 250, null], "percentEmpty")).toBe("33%");
    e2(summarize(cur, [], "sum")).toBe("₹0");
  });
  i2("summarises dates and checkboxes", () => {
    const date = { type: "date" as const, options: {} };
    e2(summarize(date, ["2026-11-01", "2026-11-11", null], "dateRange")).toBe("10 days");
    e2(summarize({ type: "checkbox", options: {} }, [true, null, true, null], "percentChecked")).toBe("50%");
    e2(summaryKindsFor(date)).toContain("earliest");
    e2(summaryKindsFor({ type: "singleLineText", options: {} })).not.toContain("sum");
  });
  i2("groups by text ignoring case, dates by day, empties together", () => {
    const text = { type: "singleLineText" as const, options: {} };
    e2(groupKey(text, "Mumbai")[0]).toBe(groupKey(text, "mumbai")[0]);
    e2(groupKey(text, null)).toEqual(["", "(Empty)"]);
    e2(groupKey({ type: "createdTime", options: {} }, "2026-11-20T10:00:00.000Z")[0]).toBe("2026-11-20");
  });
});
