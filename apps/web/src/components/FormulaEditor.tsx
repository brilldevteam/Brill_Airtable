import { compileFormula, FormulaError, FUNCTION_GROUPS, type Field } from "@brill/shared";
import { useMemo, useRef, useState } from "react";

const RESULT_LABEL = { number: "Number", text: "Text", date: "Date", boolean: "Checkbox (true / false)" };

/** Snippets inserted when a function is clicked (cursor goes where the | is). */
const SNIPPETS: Record<string, string> = {
  IF: "IF(|, , )", SWITCH: "SWITCH(|, , )", DATEADD: "DATEADD(|, 1, 'days')", DATETIME_DIFF: "DATETIME_DIFF(|, TODAY(), 'days')",
  DATETIME_FORMAT: "DATETIME_FORMAT(|, 'DD/MM/YYYY')", ROUND: "ROUND(|, 2)", ARRAYJOIN: "ARRAYJOIN(|, ', ')",
};

interface Props {
  value: string;
  onChange: (v: string) => void;
  fields: Field[]; // fields of this table (the formula's own field excluded)
  selfId?: string;
}

export function FormulaEditor({ value, onChange, fields, selfId }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [showFns, setShowFns] = useState(false);

  const check = useMemo(() => {
    if (!value.trim()) return null;
    try {
      const c = compileFormula(value, fields, selfId);
      return { ok: true as const, type: c.resultType, volatile: c.volatile };
    } catch (e) {
      return { ok: false as const, message: e instanceof FormulaError ? e.message : String(e) };
    }
  }, [value, fields, selfId]);

  const insert = (snippet: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const cursor = snippet.indexOf("|");
    const text = snippet.replace("|", "");
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + (cursor >= 0 ? cursor : text.length);
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="formula-editor">
      <textarea
        ref={ref}
        rows={4}
        spellCheck={false}
        className="formula-input"
        placeholder={"e.g.  {Qty} * {Price}\n      IF({Status} = \"Done\", \"✓\", \"\")"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={"formula-status " + (check === null ? "" : check.ok ? "ok" : "bad")}>
        {check === null
          ? "Use {Field Name} to refer to fields."
          : check.ok
            ? `✓ Valid — result is ${RESULT_LABEL[check.type]}${check.volatile ? " (uses today's date; refreshed daily)" : ""}`
            : `✕ ${check.message}`}
      </div>

      <div className="formula-help">
        <div className="menu-label">Fields — click to insert</div>
        <div className="chip-row">
          {fields.filter((f) => f.id !== selfId).map((f) => (
            <button type="button" key={f.id} className="chip" onClick={() => insert(`{${f.name}}`)}>{f.name}</button>
          ))}
        </div>
        <button type="button" className="link" onClick={() => setShowFns(!showFns)}>
          {showFns ? "Hide functions" : "Show functions"}
        </button>
        {showFns && Object.entries(FUNCTION_GROUPS).map(([group, names]) => (
          <div key={group}>
            <div className="menu-label">{group}</div>
            <div className="chip-row">
              {names.map((n) => (
                <button type="button" key={n} className="chip fn" onClick={() => insert(SNIPPETS[n] ?? `${n}(|)`)}>{n}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
