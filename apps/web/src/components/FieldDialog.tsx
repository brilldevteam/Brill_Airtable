import {
  COMPUTED_TYPES,
  compileFormula,
  formulaToDisplay,
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  NUMERIC_ROLLUPS,
  ROLLUP_AGGREGATIONS,
  ROLLUP_LABELS,
  STRUCTURAL_TYPES,
  type Field,
  type FieldType,
  type RollupAggregation,
  type EditAccess,
} from "@brill/shared";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type FieldInput } from "../api";
import { FormulaEditor } from "./FormulaEditor";

interface Props {
  field?: Field; // editing when set
  isPrimary?: boolean;
  tableId: string;
  tables: { id: string; name: string }[];
  tableFields: Field[];
  onSave: (input: FieldInput) => Promise<void>;
  onClose: () => void;
}

const PRIMARY_TYPES = new Set<FieldType>([
  "singleLineText", "longText", "number", "singleSelect", "date", "email", "url", "phone", "currency", "percent", "duration", "autonumber",
]);

/** The type list, grouped like Airtable's. */
const TYPE_GROUPS: [string, FieldType[]][] = [
  ["Text", ["singleLineText", "longText", "email", "url", "phone"]],
  ["Numbers", ["number", "currency", "percent", "rating", "duration", "autonumber"]],
  ["Choices & dates", ["singleSelect", "multipleSelect", "checkbox", "date", "attachment"]],
  ["People", ["user", "createdBy", "lastModifiedBy"]],
  ["Automatic", ["createdTime", "lastModifiedTime", "formula"]],
  ["Linked records", ["link", "lookup", "rollup", "count"]],
];

/** What each new kind of field does, shown under the type picker. */
const TYPE_HINTS: Partial<Record<FieldType, string>> = {
  currency: "An amount of money, shown with its symbol.",
  percent: "A percentage — type 40 for 40%.",
  rating: "Stars from 1 to the maximum you choose.",
  duration: "A length of time. Type 1:30, 1h 30m, or 90 (minutes).",
  user: "Pick people who can open this base — e.g. who a task is assigned to.",
  autonumber: "Numbers every record 1, 2, 3… in the order they were created. Numbers are never reused.",
  createdTime: "When each record was created. Filled in automatically.",
  lastModifiedTime: "When any field of the record was last changed. Filled in automatically.",
  createdBy: "Who created each record. Filled in automatically.",
  lastModifiedBy: "Who last changed each record. Filled in automatically.",
};
const DEFAULT_PRECISION: Partial<Record<FieldType, number>> = { currency: 2, percent: 0, number: 0 };

export function FieldDialog({ field, isPrimary, tableId, tables, tableFields, onSave, onClose }: Props) {
  const o = field?.options ?? {};
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<FieldType>(field?.type ?? "singleLineText");
  const [editAccess, setEditAccess] = useState<EditAccess>(field?.options.editAccess ?? "all");
  const [precision, setPrecision] = useState(o.precision ?? DEFAULT_PRECISION[field?.type ?? "number"] ?? 0);
  const [symbol, setSymbol] = useState(o.symbol ?? "₹");
  const [maxStars, setMaxStars] = useState(o.max ?? 5);
  const [durationFormat, setDurationFormat] = useState<"h:mm" | "h:mm:ss">(o.durationFormat ?? "h:mm");
  const [multiplePeople, setMultiplePeople] = useState(o.multiple ?? false);
  const [includeTime, setIncludeTime] = useState(o.includeTime ?? false);
  const [choicesText, setChoicesText] = useState((o.choices ?? []).map((c) => c.name).join("\n"));
  const [linkedTableId, setLinkedTableId] = useState(o.linkedTableId ?? tables.find((t) => t.id !== tableId)?.id ?? tableId);
  const linkFields = tableFields.filter((f) => f.type === "link");
  const [linkFieldId, setLinkFieldId] = useState(o.linkFieldId ?? linkFields[0]?.id ?? "");
  const [targetFieldId, setTargetFieldId] = useState(o.targetFieldId ?? "");
  const [aggregation, setAggregation] = useState<RollupAggregation>(o.aggregation ?? "sum");
  const [formula, setFormula] = useState(o.formula ? formulaToDisplay(o.formula, tableFields) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSelect = type === "singleSelect" || type === "multipleSelect";
  const editingStructural = !!field && STRUCTURAL_TYPES.has(field.type);
  const typeChanged = field && field.type !== type;
  const needsLink = type === "lookup" || type === "rollup" || type === "count";
  // A formula's result type decides whether decimal places apply.
  let formulaType: string | null = null;
  if (type === "formula") {
    try { formulaType = compileFormula(formula, tableFields, field?.id).resultType; } catch { formulaType = null; }
  }

  // Fields of the table the chosen link field points at (for lookup / rollup).
  const linkField = linkFields.find((f) => f.id === linkFieldId);
  const linkedSchema = useQuery({
    queryKey: ["table", linkField?.options.linkedTableId],
    queryFn: () => api.table(linkField!.options.linkedTableId!),
    enabled: !!linkField && (type === "lookup" || type === "rollup"),
  });
  const targetFields = linkedSchema.data?.fields ?? [];
  const effectiveTarget = targetFieldId || targetFields[0]?.id || "";

  const allowedTypes = FIELD_TYPES.filter((t) => {
    if (isPrimary) return PRIMARY_TYPES.has(t);
    if (editingStructural) return t === field!.type; // can't convert these yet
    if (field && STRUCTURAL_TYPES.has(t)) return false; // can't convert into them either
    return true;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const options: FieldInput["options"] = {};
    if (type === "number" || type === "percent") options.precision = precision;
    if (type === "currency") {
      options.precision = precision;
      options.symbol = symbol.trim() || "₹";
    }
    if (type === "rating") options.max = maxStars;
    if (type === "duration") options.durationFormat = durationFormat;
    if (type === "user") options.multiple = multiplePeople;
    if (type === "date") options.includeTime = includeTime;
    if (isSelect) {
      // Keep existing choice ids (and colours) for names that didn't change.
      const existing = field?.options.choices ?? [];
      options.choices = choicesText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((n) => {
          const old = existing.find((c) => c.name === n);
          return old ? { id: old.id, name: n, color: old.color } : { name: n };
        });
    }
    if (type === "link" && !field) options.linkedTableId = linkedTableId;
    if (needsLink) {
      if (!linkFieldId) return setError("Add a “Link to another record” field first.");
      options.linkFieldId = linkFieldId;
    }
    if (type === "lookup" || type === "rollup") {
      if (!effectiveTarget) return setError("Choose a field from the linked table.");
      options.targetFieldId = effectiveTarget;
    }
    if (type === "rollup") {
      options.aggregation = aggregation;
      if (NUMERIC_ROLLUPS.has(aggregation)) options.precision = precision;
    }
    if (type === "formula") {
      if (!formula.trim()) return setError("Enter a formula.");
      options.formula = formula;
      if (formulaType === "number") options.precision = precision;
    }
    setBusy(true);
    try {
      await onSave({
        name: name.trim(), type, options: editingStructural && type === "link" ? undefined : options,
        ...(COMPUTED_TYPES.has(type) ? {} : { editAccess }),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>{field ? "Edit field" : "Add field"}</h3>
        <label>
          Field name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Field type
          <select
            value={type}
            disabled={editingStructural}
            onChange={(e) => {
              const t = e.target.value as FieldType;
              setType(t);
              if (!field && DEFAULT_PRECISION[t] !== undefined) setPrecision(DEFAULT_PRECISION[t]!);
            }}
          >
            {TYPE_GROUPS.map(([group, types]) => {
              const shown = types.filter((t) => allowedTypes.includes(t));
              return shown.length ? (
                <optgroup key={group} label={group}>
                  {shown.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
          {TYPE_HINTS[type] && <span className="field-hint">{TYPE_HINTS[type]}</span>}
        </label>

        {type === "currency" && (
          <label>
            Currency symbol
            <select value={["₹", "$", "€", "£", "AED", "¥"].includes(symbol) ? symbol : "other"} onChange={(e) => setSymbol(e.target.value === "other" ? "" : e.target.value)}>
              <option value="₹">₹ Indian rupee</option>
              <option value="$">$ Dollar</option>
              <option value="€">€ Euro</option>
              <option value="£">£ Pound</option>
              <option value="AED">AED Dirham</option>
              <option value="¥">¥ Yen / Yuan</option>
              <option value="other">Other…</option>
            </select>
            {!["₹", "$", "€", "£", "AED", "¥"].includes(symbol) && (
              <input value={symbol} maxLength={5} placeholder="e.g. SGD" onChange={(e) => setSymbol(e.target.value)} />
            )}
          </label>
        )}
        {type === "rating" && (
          <label>
            Maximum stars
            <select value={maxStars} onChange={(e) => setMaxStars(Number(e.target.value))}>
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{"★".repeat(n)}  ({n})</option>)}
            </select>
          </label>
        )}
        {type === "duration" && (
          <label>
            Format
            <select value={durationFormat} onChange={(e) => setDurationFormat(e.target.value as "h:mm" | "h:mm:ss")}>
              <option value="h:mm">h:mm (1:30)</option>
              <option value="h:mm:ss">h:mm:ss (1:30:00)</option>
            </select>
          </label>
        )}
        {type === "user" && (
          <label className="row">
            <input type="checkbox" checked={multiplePeople} onChange={(e) => setMultiplePeople(e.target.checked)} /> Allow more than one person
          </label>
        )}

        {type === "formula" && (
          <label>
            Formula
            <FormulaEditor value={formula} onChange={setFormula} fields={tableFields} selfId={field?.id} />
          </label>
        )}
        {(type === "number" || type === "currency" || type === "percent" || (type === "rollup" && NUMERIC_ROLLUPS.has(aggregation)) || (type === "formula" && formulaType === "number")) && (
          <label>
            Decimal places
            <select value={precision} onChange={(e) => setPrecision(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((p) => <option key={p} value={p}>{p === 0 ? "1 (integer)" : (1).toFixed(p)}</option>)}
            </select>
          </label>
        )}
        {type === "date" && (
          <label className="row">
            <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} /> Include time
          </label>
        )}
        {isSelect && (
          <label>
            Options (one per line)
            <textarea rows={6} value={choicesText} onChange={(e) => setChoicesText(e.target.value)} placeholder={"Todo\nIn progress\nDone"} />
          </label>
        )}

        {type === "link" && (
          <label>
            Link to table
            <select value={linkedTableId} onChange={(e) => setLinkedTableId(e.target.value)} disabled={!!field}>
              {tables.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === tableId ? " (this table)" : ""}</option>)}
            </select>
            {!field && linkedTableId !== tableId && (
              <span className="hint">A matching link field will also be added to that table.</span>
            )}
          </label>
        )}

        {needsLink && (
          linkFields.length === 0 ? (
            <div className="hint">This table has no “Link to another record” field yet. Add one first, then come back.</div>
          ) : (
            <label>
              Linked records field
              <select value={linkFieldId} onChange={(e) => { setLinkFieldId(e.target.value); setTargetFieldId(""); }}>
                {linkFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          )
        )}
        {(type === "lookup" || type === "rollup") && linkField && (
          <label>
            Field to {type === "lookup" ? "look up" : "roll up"}
            <select value={effectiveTarget} onChange={(e) => setTargetFieldId(e.target.value)}>
              {linkedSchema.isLoading && <option>Loading…</option>}
              {targetFields.map((f) => <option key={f.id} value={f.id}>{f.name} · {FIELD_TYPE_LABELS[f.type]}</option>)}
            </select>
          </label>
        )}
        {type === "rollup" && (
          <label>
            Aggregation
            <select value={aggregation} onChange={(e) => setAggregation(e.target.value as RollupAggregation)}>
              {ROLLUP_AGGREGATIONS.map((a) => <option key={a} value={a}>{ROLLUP_LABELS[a]}</option>)}
            </select>
          </label>
        )}

        {!COMPUTED_TYPES.has(type) && (
          <label>
            Who can edit this field
            <select value={editAccess} onChange={(e) => setEditAccess(e.target.value as EditAccess)}>
              <option value="all">Everyone who can edit</option>
              <option value="team">Workspace team only (not clients)</option>
              <option value="creators">Creators and owners only</option>
            </select>
            {editAccess !== "all" && <span className="hint" style={{ margin: 0 }}>Others can still see the field, but can't change it.</span>}
          </label>
        )}

        {typeChanged && <div className="hint">Existing values will be converted. Values that can't convert will be cleared.</div>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : field ? "Save" : "Create field"}</button>
        </div>
      </form>
    </div>
  );
}
