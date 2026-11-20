import { z } from "zod";
import { effectiveType, type Field, type FieldType } from "./fields";

export const VIEW_TYPES = ["grid", "kanban", "calendar", "gallery", "form"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

// ---------- operators per field type ----------
export const TEXT_OPS = ["contains", "doesNotContain", "is", "isNot", "isEmpty", "isNotEmpty"] as const;
export const NUMBER_OPS = ["=", "!=", "<", "<=", ">", ">=", "isEmpty", "isNotEmpty"] as const;
export const CHECKBOX_OPS = ["isChecked", "isNotChecked"] as const;
export const SINGLE_SELECT_OPS = ["is", "isNot", "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty"] as const;
export const MULTI_SELECT_OPS = ["hasAnyOf", "hasAllOf", "hasNoneOf", "isEmpty", "isNotEmpty"] as const;
export const DATE_OPS = ["is", "isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isEmpty", "isNotEmpty"] as const;

export type FilterOperator =
  | (typeof TEXT_OPS)[number]
  | (typeof NUMBER_OPS)[number]
  | (typeof CHECKBOX_OPS)[number]
  | (typeof SINGLE_SELECT_OPS)[number]
  | (typeof MULTI_SELECT_OPS)[number]
  | (typeof DATE_OPS)[number];

/** People fields: pick people from the base's collaborators. */
export const USER_OPS = ["hasAnyOf", "hasNoneOf", "isEmpty", "isNotEmpty"] as const;
/** Link fields: only emptiness for now (matching on linked names needs a join). */
export const LINK_OPS = ["isEmpty", "isNotEmpty"] as const;
/** Lookups hold a list of texts. */
export const LOOKUP_OPS = ["contains", "doesNotContain", "isEmpty", "isNotEmpty"] as const;

export function operatorsFor(field: Pick<Field, "type" | "options">): readonly FilterOperator[] {
  switch (effectiveType(field)) {
    case "number": return NUMBER_OPS;
    case "checkbox": return CHECKBOX_OPS;
    case "singleSelect": return SINGLE_SELECT_OPS;
    case "multipleSelect": return MULTI_SELECT_OPS;
    case "date": return DATE_OPS;
    case "user": return USER_OPS;
    case "link":
    case "attachment":
      return LINK_OPS;
    case "lookup": return LOOKUP_OPS;
    default: return TEXT_OPS;
  }
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "contains", doesNotContain: "does not contain", is: "is", isNot: "is not",
  isEmpty: "is empty", isNotEmpty: "is not empty",
  "=": "=", "!=": "≠", "<": "<", "<=": "≤", ">": ">", ">=": "≥",
  isChecked: "is checked", isNotChecked: "is not checked",
  isAnyOf: "is any of", isNoneOf: "is none of",
  hasAnyOf: "has any of", hasAllOf: "has all of", hasNoneOf: "has none of",
  isBefore: "is before", isAfter: "is after", isOnOrBefore: "is on or before", isOnOrAfter: "is on or after",
};

/** Operators that don't need a value. */
export const VALUELESS_OPS = new Set<FilterOperator>(["isEmpty", "isNotEmpty", "isChecked", "isNotChecked"]);
/** Operators whose value is a list of select choice ids. */
export const LIST_OPS = new Set<FilterOperator>(["isAnyOf", "isNoneOf", "hasAnyOf", "hasAllOf", "hasNoneOf"]);

// ---------- config schema ----------
export const filterConditionSchema = z.object({
  id: z.string(),
  fieldId: z.string(),
  operator: z.string() as z.ZodType<FilterOperator>,
  value: z.union([z.string(), z.number(), z.array(z.string()), z.null()]).optional(),
});
export type FilterCondition = z.infer<typeof filterConditionSchema>;

export const sortSchema = z.object({ fieldId: z.string(), direction: z.enum(["asc", "desc"]) });
export type SortSpec = z.infer<typeof sortSchema>;

export const formFieldSchema = z.object({
  fieldId: z.string(),
  required: z.boolean().default(false),
  /** Question text shown instead of the field name (optional). */
  label: z.string().max(300).default(""),
  help: z.string().max(1000).default(""),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formConfigSchema = z.object({
  title: z.string().max(200).default(""),
  description: z.string().max(5000).default(""),
  fields: z.array(formFieldSchema).max(100).default([]),
  submitText: z.string().max(60).default("Submit"),
  successMessage: z.string().max(1000).default("Thank you! Your response has been recorded."),
  allowAnother: z.boolean().default(true),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

export const viewConfigSchema = z.object({
  filters: z
    .object({
      conjunction: z.enum(["and", "or"]).default("and"),
      conditions: z.array(filterConditionSchema).max(50).default([]),
    })
    .default({}),
  sorts: z.array(sortSchema).max(10).default([]),
  hiddenFieldIds: z.array(z.string()).default([]),
  fieldOrder: z.array(z.string()).default([]),
  columnWidths: z.record(z.number().min(40).max(1000)).default({}),
  rowHeight: z.enum(["short", "medium", "tall"]).default("short"),
  /** Kanban: the single select field that defines the stacks. */
  stackFieldId: z.string().nullable().default(null),
  /** Calendar: the date field records are placed by (a date field or a date formula). */
  dateFieldId: z.string().nullable().default(null),
  /** Calendar: optional single select whose option colours tint the events. */
  colorFieldId: z.string().nullable().default(null),
  /** Gallery: attachment field used for card covers. */
  coverFieldId: z.string().nullable().default(null),
  coverFit: z.enum(["cover", "contain"]).default("cover"),
  cardSize: z.enum(["small", "medium", "large"]).default("medium"),
  /** Form: what the public form looks like and which fields it asks for. */
  form: formConfigSchema.default({}),
});

/** Field types a public form can ask for (no calculated fields; no links, which would expose other records). */
export const FORM_FIELD_TYPES = new Set<FieldType>([
  "singleLineText", "longText", "number", "checkbox", "singleSelect", "multipleSelect", "date", "email", "url", "phone", "attachment",
  "currency", "percent", "rating", "duration",
]);

/** Can this field place records on a calendar? */
export function isDateLike(field: Pick<Field, "type" | "options">): boolean {
  return field.type === "date" || (field.type === "formula" && field.options.resultType === "date");
}
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export const defaultViewConfig = (): ViewConfig => viewConfigSchema.parse({});

export interface View {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  position: number;
}

/** Fields in the view's display order: saved order first, then any new fields. */
export function orderedFieldIds(config: ViewConfig, allFieldIds: string[], primaryFieldId: string | null): string[] {
  const known = new Set(allFieldIds);
  const ordered = config.fieldOrder.filter((id) => known.has(id));
  for (const id of allFieldIds) if (!ordered.includes(id)) ordered.push(id);
  // The primary field is always first, like Airtable.
  if (primaryFieldId && ordered.includes(primaryFieldId)) {
    return [primaryFieldId, ...ordered.filter((id) => id !== primaryFieldId)];
  }
  return ordered;
}
