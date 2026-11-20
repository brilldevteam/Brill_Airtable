import { z } from "zod";

/**
 * Dashboards (Airtable's "Interfaces"): pages of widgets that read a table — optionally through
 * one of its views, so they share its filters and sort. Everyone who can open the base can look;
 * creators and owners arrange them.
 */
export const WIDGET_TYPES = ["number", "chart", "list", "text"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const WIDGET_LABELS: Record<WidgetType, string> = {
  number: "Number",
  chart: "Chart",
  list: "Record list",
  text: "Text",
};

export const CHART_TYPES = ["bar", "column", "line", "donut"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const CHART_LABELS: Record<ChartType, string> = { bar: "Bar", column: "Column", line: "Line", donut: "Donut" };

/** What to measure: how many records, or a sum / average / min / max of a number field. */
export const metricSchema = z.object({
  kind: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
  fieldId: z.string().nullable().default(null),
});
export type Metric = z.infer<typeof metricSchema>;
export const METRIC_LABELS: Record<Metric["kind"], string> = { count: "Count of records", sum: "Sum", avg: "Average", min: "Min", max: "Max" };

const source = {
  tableId: z.string(),
  /** Use this view's filters (and sort, for lists). */
  viewId: z.string().nullable().default(null),
};

export const widgetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("number"), id: z.string(), title: z.string().max(120).default(""), width: z.number().int().min(1).max(4).default(1),
    ...source, metric: metricSchema.default({}),
  }),
  z.object({
    type: z.literal("chart"), id: z.string(), title: z.string().max(120).default(""), width: z.number().int().min(1).max(4).default(2),
    ...source,
    chartType: z.enum(CHART_TYPES).default("bar"),
    /** Records are grouped by this field (each option, person, linked record, or date period). */
    groupFieldId: z.string().nullable().default(null),
    /** Date fields: group by day, week or month. */
    dateBucket: z.enum(["day", "week", "month"]).default("month"),
    metric: metricSchema.default({}),
    /** Show the biggest N groups; the rest are added up as "Other". */
    limit: z.number().int().min(2).max(20).default(8),
  }),
  z.object({
    type: z.literal("list"), id: z.string(), title: z.string().max(120).default(""), width: z.number().int().min(1).max(4).default(2),
    ...source,
    fieldIds: z.array(z.string()).max(8).default([]),
    limit: z.number().int().min(1).max(50).default(8),
  }),
  z.object({
    type: z.literal("text"), id: z.string(), title: z.string().max(120).default(""), width: z.number().int().min(1).max(4).default(4),
    text: z.string().max(4000).default(""),
  }),
]);
export type Widget = z.infer<typeof widgetSchema>;

export interface Dashboard {
  id: string;
  baseId: string;
  name: string;
  widgets: Widget[];
  position: number;
  updatedAt: string;
}

/** Computed data for each widget, by widget id. */
export type WidgetData =
  | { type: "number"; value: number | null; display: string; records: number }
  | {
      type: "chart";
      groups: { key: string; label: string; color: string | null; value: number; display: string }[];
      total: number;
      totalDisplay: string;
      valueLabel: string;
    }
  | {
      type: "list";
      fields: { id: string; name: string; type: string; options: Record<string, unknown> }[];
      records: { id: string; cells: Record<string, unknown> }[];
      labels: Record<string, string>;
      more: number;
    }
  | { type: "text" }
  | { type: "error"; message: string };
