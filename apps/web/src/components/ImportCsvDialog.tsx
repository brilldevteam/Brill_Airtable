import { COMPUTED_TYPES, FIELD_TYPE_LABELS, type Field, type FieldType } from "@brill/shared";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState } from "react";
import { api } from "../api";
import { FieldIcon } from "./fieldIcons";

interface Props {
  tableId: string;
  fields: Field[];
  onDone: () => void;
  onClose: () => void;
}

type Target = { kind: "skip" } | { kind: "field"; fieldId: string } | { kind: "new"; type: FieldType };

const CHUNK = 500;
const NEW_TYPES: FieldType[] = ["singleLineText", "longText", "number", "date", "checkbox", "singleSelect", "multipleSelect", "email", "url", "phone"];

/** Guess a field type for a new column from its values. */
function guessType(values: string[]): FieldType {
  const vals = values.map((v) => v.trim()).filter(Boolean).slice(0, 200);
  if (!vals.length) return "singleLineText";
  if (vals.every((v) => /^[-(]?[₹$€£]?\s?[\d,]+(\.\d+)?\)?%?$/.test(v))) return "number";
  if (vals.every((v) => /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})/.test(v))) return "date";
  if (vals.every((v) => /^(true|false|yes|no|y|n|x|✓|checked|)$/i.test(v))) return "checkbox";
  if (vals.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "email";
  if (vals.every((v) => /^https?:\/\//i.test(v))) return "url";
  const distinct = new Set(vals);
  if (vals.length >= 5 && distinct.size <= Math.max(3, vals.length / 4) && [...distinct].every((v) => v.length <= 40)) return "singleSelect";
  if (vals.some((v) => v.length > 120 || v.includes("\n"))) return "longText";
  return "singleLineText";
}

export function ImportCsvDialog({ tableId, fields, onDone, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [dateOrder, setDateOrder] = useState<"dmy" | "mdy">("dmy");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const writable = fields.filter((f) => !COMPUTED_TYPES.has(f.type) && f.type !== "attachment");

  const load = (file: File) => {
    setError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const cols = (res.meta.fields ?? []).filter(Boolean);
        if (!cols.length) return setError("That file has no header row.");
        setFileName(file.name);
        setColumns(cols);
        setRows(res.data);
        // Match columns to fields by name; otherwise offer a new field with a guessed type.
        const t: Record<string, Target> = {};
        for (const c of cols) {
          const match = writable.find((f) => f.name.toLowerCase() === c.toLowerCase());
          t[c] = match ? { kind: "field", fieldId: match.id } : { kind: "new", type: guessType(res.data.map((r) => r[c] ?? "")) };
        }
        setTargets(t);
      },
      error: (e) => setError(e.message),
    });
  };

  const run = async () => {
    setError(null);
    try {
      // 1. Create new fields.
      const colToField: Record<string, string> = {};
      for (const c of columns) {
        const t = targets[c];
        if (t.kind === "field") colToField[c] = t.fieldId;
        if (t.kind === "new") {
          let name = c;
          for (let i = 2; fields.some((f) => f.name.toLowerCase() === name.toLowerCase()); i++) name = `${c} ${i}`;
          const { field } = await api.createField(tableId, { name, type: t.type, options: t.type === "number" ? { precision: 2 } : {} });
          colToField[c] = field.id;
        }
      }
      // 2. Send records in chunks; the server converts values (typecast).
      const records = rows.map((r) => ({
        cells: Object.fromEntries(Object.entries(colToField).map(([c, fid]) => [fid, r[c] ?? ""])),
      }));
      setProgress({ done: 0, total: records.length });
      for (let i = 0; i < records.length; i += CHUNK) {
        await api.batchCreate(tableId, records.slice(i, i + CHUNK), { typecast: true, dateOrder });
        setProgress({ done: Math.min(i + CHUNK, records.length), total: records.length });
      }
      setFinished(records.length);
      onDone();
    } catch (e) {
      setError((e as Error).message + (progress ? " — rows before this batch were imported." : ""));
      setProgress(null);
      onDone();
    }
  };

  const mapped = columns.filter((c) => targets[c]?.kind !== "skip").length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div className="modal import-modal">
        <div className="modal-head">
          <div className="modal-icon"><FileSpreadsheet size={18} /></div>
          <div>
            <h3>Import CSV</h3>
            <p className="modal-sub">Add rows from a spreadsheet to this table. Match each column to a field, or create a new one.</p>
          </div>
        </div>

        {finished !== null ? (
          <div className="import-done">
            <CheckCircle2 size={34} />
            <strong>Imported {finished.toLocaleString()} records</strong>
            <span className="muted">New select options and linked records were created where needed.</span>
          </div>
        ) : !fileName ? (
          <div
            className="att-drop import-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f); }}
            onClick={() => input.current?.click()}
            role="button"
          >
            <Upload size={20} />
            <span>Drop a <b>.csv</b> file here or <u>browse</u></span>
            <span className="muted small">Export from Excel, Google Sheets or Airtable as CSV first.</span>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
          </div>
        ) : (
          <>
            <div className="import-summary">
              <FileSpreadsheet size={16} /> <b>{fileName}</b>
              <span className="muted">· {rows.length.toLocaleString()} rows · {columns.length} columns</span>
              <button className="link" style={{ marginLeft: "auto" }} onClick={() => { setFileName(null); setColumns([]); setRows([]); }}>Choose another file</button>
            </div>
            <div className="import-map">
              <div className="import-map-head"><span>CSV column</span><span>Import into</span></div>
              {columns.map((c) => {
                const t = targets[c];
                const value = t.kind === "skip" ? "skip" : t.kind === "field" ? `f:${t.fieldId}` : "new";
                const sample = rows.slice(0, 3).map((r) => r[c]).filter(Boolean).join(" · ");
                return (
                  <div key={c} className="import-map-row">
                    <div className="import-col">
                      <strong>{c}</strong>
                      <span className="muted small">{sample || "—"}</span>
                    </div>
                    <div className="import-target">
                      <select
                        value={value}
                        onChange={(e) => {
                          const v = e.target.value;
                          setTargets({
                            ...targets,
                            [c]: v === "skip" ? { kind: "skip" } : v === "new" ? { kind: "new", type: guessType(rows.map((r) => r[c] ?? "")) } : { kind: "field", fieldId: v.slice(2) },
                          });
                        }}
                      >
                        <optgroup label="Existing fields">
                          {writable.map((f) => <option key={f.id} value={`f:${f.id}`}>{f.name}</option>)}
                        </optgroup>
                        <option value="new">+ New field “{c}”</option>
                        <option value="skip">Don't import</option>
                      </select>
                      {t.kind === "new" && (
                        <select value={t.type} onChange={(e) => setTargets({ ...targets, [c]: { kind: "new", type: e.target.value as FieldType } })}>
                          {NEW_TYPES.map((ft) => <option key={ft} value={ft}>{FIELD_TYPE_LABELS[ft]}</option>)}
                        </select>
                      )}
                      {t.kind === "field" && (
                        <span className="import-type"><FieldIcon type={fields.find((f) => f.id === t.fieldId)!.type} size={13} /></span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <label className="row" style={{ gap: 10 }}>
              Dates are written as
              <select value={dateOrder} onChange={(e) => setDateOrder(e.target.value as "dmy" | "mdy")} style={{ width: "auto" }}>
                <option value="dmy">31/12/2026 (day first)</option>
                <option value="mdy">12/31/2026 (month first)</option>
              </select>
            </label>
          </>
        )}

        {progress && finished === null && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            <span>Importing… {progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
          </div>
        )}
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}

        <div className="modal-actions">
          {finished !== null ? (
            <button className="btn primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={!!progress}>Cancel</button>
              <button className="btn primary" disabled={!fileName || !mapped || !!progress} onClick={run}>
                Import {rows.length ? rows.length.toLocaleString() : ""} records
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
