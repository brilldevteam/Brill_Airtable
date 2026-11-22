import { describe, expect, it } from "vitest";
import { fillSeries, parseTextDate } from "./fill";

const text = { type: "singleLineText" as const, options: {} };
const date = { type: "date" as const, options: {} };
const num = { type: "number" as const, options: {} };

describe("smart fill", () => {
  it("continues a single date day by day", () => {
    expect(fillSeries(date, ["2026-12-30"], 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });
  it("follows the step between dates, and months by month", () => {
    expect(fillSeries(date, ["2026-12-01", "2026-12-08"], 2)).toEqual(["2026-12-15", "2026-12-22"]);
    expect(fillSeries(date, ["2026-01-31", "2026-02-28"], 1)).toEqual(["2026-03-28"]); // not the same day of the month: a 28-day step
    expect(fillSeries(date, ["2026-01-15", "2026-02-15"], 2)).toEqual(["2026-03-15", "2026-04-15"]);
    expect(fillSeries(date, ["2026-11-30", "2027-11-30"], 1)).toEqual(["2028-11-30"]);
  });
  it("fills upward backwards in time", () => {
    expect(fillSeries(date, ["2026-12-01"], 2, -1)).toEqual(["2026-11-30", "2026-11-29"]);
  });
  it("continues dates typed as text, written the same way", () => {
    expect(fillSeries(text, ["December 01,2026"], 3)).toEqual(["December 02,2026", "December 03,2026", "December 04,2026"]);
    expect(fillSeries(text, ["Dec 31, 2026"], 2)).toEqual(["Jan 1, 2027", "Jan 2, 2027"]);
    expect(fillSeries(text, ["1st December 2026"], 2)).toEqual(["2nd December 2026", "3rd December 2026"]);
    expect(fillSeries(text, ["2026-12-01", "2026-12-03"], 1)).toEqual(["2026-12-05"]);
    expect(parseTextDate("February 30, 2026")).toBeNull();
  });
  it("counts up text ending in a number", () => {
    expect(fillSeries(text, ["Reel 1"], 2)).toEqual(["Reel 2", "Reel 3"]);
    expect(fillSeries(text, ["Ep 07"], 3)).toEqual(["Ep 08", "Ep 09", "Ep 10"]);
    expect(fillSeries(text, ["Ep 2", "Ep 4"], 2)).toEqual(["Ep 6", "Ep 8"]);
  });
  it("copies or repeats what has no pattern", () => {
    expect(fillSeries(text, ["Hello"], 2)).toEqual(["Hello", "Hello"]);
    expect(fillSeries(text, ["5"], 2)).toEqual(["5", "5"]);
    expect(fillSeries(text, ["a", "b"], 3)).toEqual(["a", "b", "a"]);
    expect(fillSeries(num, [5], 2)).toEqual([5, 5]);
    expect(fillSeries(num, [1, 3, 4], 2)).toEqual([1, 3]);
    expect(fillSeries({ type: "checkbox", options: {} }, [true], 2)).toEqual([true, true]);
  });
  it("continues numbers with a step", () => {
    expect(fillSeries(num, [1, 2], 3)).toEqual([3, 4, 5]);
    expect(fillSeries(num, [0.1, 0.2], 2)).toEqual([0.3, 0.4]);
  });
});
