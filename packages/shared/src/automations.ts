import { z } from "zod";
import { filterConditionSchema } from "./views";

/**
 * Automations: "when <trigger> in a table, do <actions>". Text in actions can use {Field name}
 * tokens, filled in from the record that triggered the run.
 */
export const TRIGGER_TYPES = ["recordCreated", "recordUpdated", "recordMatches", "formSubmitted"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_LABELS: Record<TriggerType, string> = {
  recordCreated: "When a record is created",
  recordUpdated: "When a record is updated",
  recordMatches: "When a record matches conditions",
  formSubmitted: "When a form is submitted",
};

export const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  tableId: z.string(),
  /** recordUpdated: only these fields (empty = any field). */
  fieldIds: z.array(z.string()).max(50).default([]),
  /** recordMatches: fires when a record starts matching these. */
  conjunction: z.enum(["and", "or"]).default("and"),
  conditions: z.array(filterConditionSchema).max(20).default([]),
  /** formSubmitted: the form view. */
  viewId: z.string().nullable().default(null),
});
export type Trigger = z.infer<typeof triggerSchema>;

export const ACTION_TYPES = ["updateRecord", "createRecord", "sendEmail", "webhook"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_LABELS: Record<ActionType, string> = {
  updateRecord: "Update the record",
  createRecord: "Create a record",
  sendEmail: "Send an email",
  webhook: "Send a webhook",
};

const template = z.string().max(5000);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("updateRecord"), fields: z.record(template).default({}) }),
  z.object({ type: z.literal("createRecord"), tableId: z.string(), fields: z.record(template).default({}) }),
  z.object({
    type: z.literal("sendEmail"),
    /** Addresses, commas between them; {Email} or {Assignee} tokens use the record's people. */
    to: z.string().max(2000),
    subject: z.string().max(300),
    body: template,
  }),
  z.object({ type: z.literal("webhook"), url: z.string().url().max(2000) }),
]);
export type Action = z.infer<typeof actionSchema>;

export interface Automation {
  id: string;
  baseId: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: Action[];
  createdAt: string;
  updatedAt: string;
  lastRun: { status: RunStatus; at: string } | null;
}

export type RunStatus = "success" | "failed";
export interface AutomationRun {
  id: string;
  automationId: string;
  recordId: string | null;
  recordName: string;
  status: RunStatus;
  steps: { action: ActionType; ok: boolean; message: string }[];
  test: boolean;
  startedAt: string;
}

/** Field names used as {tokens} in a template. */
export function templateTokens(text: string): string[] {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].trim());
}
