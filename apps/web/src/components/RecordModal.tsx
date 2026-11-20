import { COMPUTED_TYPES, FIELD_TYPE_LABELS, cellToText, type AttachmentInfo, type CellValue, type Field, type LinkLabels, type RecordRow } from "@brill/shared";
import { useEffect, useState } from "react";
import { Trash2, X, Lock } from "lucide-react";
import { useDialogs } from "./Dialogs";
import { FieldIcon } from "./fieldIcons";
import { AttachmentTiles } from "./AttachmentPicker";
import { ActivityPanel } from "./ActivityPanel";
import { LinkPicker } from "./LinkPicker";
import { RatingInput, UserChips, UserPicker } from "./PeoplePicker";
import { SelectPicker } from "./Popover";

interface Props {
  record: RecordRow;
  fields: Field[];
  primaryFieldId: string | null;
  labels: LinkLabels;
  files: Record<string, AttachmentInfo>;
  tableId: string;
  addFiles: (infos: AttachmentInfo[]) => void;
  onSave: (patch: Record<string, CellValue>) => void;
  onDelete: () => void;
  onClose: () => void;
  canEdit: boolean;
  canEditField: (field: Field) => boolean;
  canDelete: boolean;
  canComment: boolean;
  /** All fields of the table (history may mention hidden ones). */
  allFields: Field[];
}

/** Expanded record: every field as a form input. Each field saves when you leave it. */
export function RecordModal({ record, fields, primaryFieldId, labels, files, tableId, addFiles, onSave, onDelete, onClose, canEdit, canEditField, canDelete, canComment, allFields }: Props) {
  const primary = fields.find((f) => f.id === primaryFieldId);
  const title = primary ? cellToText(primary, record.cells[primary.id] ?? null) : "";
  const dialogs = useDialogs();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal record-modal with-activity">
        <div className="record-main">
        <div className="record-head">
          <h3>{title || "Unnamed record"}</h3>
          <div className="spacer" />
          {canDelete && <button
            className="btn sm danger"
            onClick={async () => {
              const ok = await dialogs.confirm({ title: "Delete this record?", message: "It will be removed from every view and link.", confirmText: "Delete", danger: true });
              if (ok) onDelete();
            }}
          >
            <Trash2 size={14} /> Delete
          </button>}
          <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="record-fields">
          {fields.map((f) => (
            <div key={f.id} className="record-field">
              <div className="record-label">
                <FieldIcon type={f.type} size={14} /> {f.name} <span className="muted">· {FIELD_TYPE_LABELS[f.type]}</span>
                {canEdit && !canEditField(f) && !COMPUTED_TYPES.has(f.type) && <span className="lock-pill" title="This field is locked — you can view it but not change it"><Lock size={11} /> Locked</span>}
              </div>
              {f.type === "attachment" ? (
                <AttachmentTiles
                  tableId={tableId}
                  value={(record.cells[f.id] as string[] | undefined) ?? []}
                  files={files}
                  onFiles={addFiles}
                  canEdit={canEditField(f)}
                  onChange={(ids) => onSave({ [f.id]: ids.length ? ids : null })}
                />
              ) : canEditField(f) ? (
                <FieldInput field={f} value={record.cells[f.id] ?? null} labels={labels} onSave={(v) => onSave({ [f.id]: v })} />
              ) : (
                <div className="computed-value">{(f.type === "checkbox" ? (record.cells[f.id] ? "✓" : "") : cellToText(f, record.cells[f.id] ?? null, labels)) || <span className="muted">—</span>}</div>
              )}
            </div>
          ))}
        </div>
        <div className="record-foot">Created {new Date(record.createdAt).toLocaleString()} · Last modified {new Date(record.updatedAt).toLocaleString()}</div>
        </div>
        <ActivityPanel recordId={record.id} fields={allFields} canComment={canComment} />
      </div>
    </div>
  );
}

function FieldInput({ field, value, labels, onSave }: { field: Field; value: CellValue; labels: LinkLabels; onSave: (v: CellValue) => void }) {
  const initial = value === null ? "" : String(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text === initial) return;
    onSave(text === "" ? null : field.type === "number" ? (Number(text) as CellValue) : text);
  };

  if (field.type === "createdBy" || field.type === "lastModifiedBy") {
    return <div className="computed-value"><UserChips ids={(value as string[] | null) ?? []} labels={labels} /></div>;
  }
  if (COMPUTED_TYPES.has(field.type)) {
    return <div className="computed-value">{cellToText(field, value, labels) || <span className="muted">—</span>}</div>;
  }
  switch (field.type) {
    case "user":
      return (
        <div className="record-select">
          <UserPicker field={field} value={value} autoFocus={false} onChange={(ids) => onSave(ids)} />
        </div>
      );
    case "rating":
      return <RatingInput max={field.options.max ?? 5} value={typeof value === "number" ? value : null} onChange={onSave} size={20} />;
    case "currency":
    case "percent":
      return (
        <div className={"affix-input" + (field.type === "percent" ? " suffix" : "")}>
          {field.type === "currency" && <span>{field.options.symbol ?? "₹"}</span>}
          <input
            type="number" step="any" value={text}
            onChange={(e) => setText(e.target.value)} onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          {field.type === "percent" && <span>%</span>}
        </div>
      );
    case "duration":
      return <DurationInput field={field} value={value} onSave={onSave} />;
    case "link":
      return (
        <div className="record-select">
          <LinkPicker
            field={field}
            value={(value as string[] | null) ?? []}
            labels={labels}
            autoFocus={false}
            onChange={(ids) => onSave(ids.length ? ids : null)}
          />
        </div>
      );
    case "checkbox":
      return <input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked ? true : null)} />;
    case "singleSelect":
    case "multipleSelect":
      return <div className="record-select"><SelectPicker field={field} value={value} onChange={onSave} /></div>;
    case "longText":
      return <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
    case "date":
      return field.options.includeTime ? (
        <input type="datetime-local" value={text ? toLocalInput(text) : ""} onChange={(e) => onSave(e.target.value ? new Date(e.target.value).toISOString() : null)} />
      ) : (
        <input type="date" value={text} onChange={(e) => onSave(e.target.value || null)} />
      );
    default:
      return (
        <input
          type={field.type === "number" ? "number" : field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
          step={field.type === "number" ? "any" : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      );
  }
}

/** Shows "1:30"; accepts "1:30", "1h 30m", "90" (minutes)… — the server parses it. */
function DurationInput({ field, value, onSave }: { field: Field; value: CellValue; onSave: (v: CellValue) => void }) {
  const initial = value === null ? "" : cellToText(field, value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <input
      value={text}
      placeholder={field.options.durationFormat === "h:mm:ss" ? "h:mm:ss" : "h:mm"}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== initial && onSave(text.trim() === "" ? null : text)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
