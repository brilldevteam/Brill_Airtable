import { z } from "zod";
import type { AttachmentInfo } from "./api-types";
import type { Field } from "./fields";
import { newId } from "./ids";

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
    /** "newest": the latest records first (new ones show up at the top); "view": the view's order. */
    order: z.enum(["view", "newest"]).default("view"),
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
  /** The table this dashboard is about (null: a dashboard that mixes tables). */
  tableId: string | null;
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
      files: Record<string, AttachmentInfo>;
      more: number;
    }
  | { type: "text" }
  | { type: "error"; message: string };

/**
 * Ready-made widgets for one table's dashboard: how many records, a total of the first amount
 * field, a chart of the first status-like field, records per month, and the latest records.
 */
export function starterWidgets(tableId: string, fields: Field[], primaryFieldId: string): Widget[] {
  const src = { tableId, viewId: null };
  const out: Widget[] = [
    { type: "number", id: newId("wdg"), title: "Total records", width: 1, ...src, metric: { kind: "count", fieldId: null } },
  ];
  const amount = fields.find((f) => (f.type === "currency" || f.type === "number") && f.id !== primaryFieldId);
  if (amount) out.push({ type: "number", id: newId("wdg"), title: `Total ${amount.name}`, width: 1, ...src, metric: { kind: "sum", fieldId: amount.id } });
  const status = fields.find((f) => f.type === "singleSelect" && /status|stage|state|progress/i.test(f.name))
    ?? fields.find((f) => f.type === "singleSelect");
  if (status) {
    out.push({
      type: "chart", id: newId("wdg"), title: `By ${status.name}`, width: 2, ...src,
      chartType: "donut", groupFieldId: status.id, dateBucket: "month", metric: { kind: "count", fieldId: null }, limit: 6,
    });
  }
  const date = fields.find((f) => f.type === "date") ?? fields.find((f) => f.type === "createdTime");
  if (date) {
    out.push({
      type: "chart", id: newId("wdg"), title: `Records by ${date.name} (month)`, width: 2, ...src,
      chartType: "column", groupFieldId: date.id, dateBucket: "month", metric: { kind: "count", fieldId: null }, limit: 8,
    });
  }
  // No fields picked: the list follows the table (name, files, then the next few fields).
  out.push({ type: "list", id: newId("wdg"), title: "Latest records", width: 4, ...src, fieldIds: [], limit: 10, order: "newest" });
  return out;
}

/** A record list with no fields picked shows the name, any files, then the next few fields. */
export function defaultListFieldIds(fields: Field[], primaryFieldId = fields[0]?.id): string[] {
  return [
    primaryFieldId,
    ...fields.filter((f) => f.type === "attachment").map((f) => f.id),
    ...fields.filter((f) => f.id !== primaryFieldId && f.type !== "attachment" && f.type !== "longText").map((f) => f.id),
  ].filter((id, i, all) => !!id && all.indexOf(id) === i && fields.some((f) => f.id === id)).slice(0, 6) as string[];
}
