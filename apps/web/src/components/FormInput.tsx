import { Check, FileText, Loader2, UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import type { PublicFormField } from "../api";
import { CHOICE_COLORS } from "../colors";
import { formatBytes } from "./attachmentUtils";

export interface UploadedFile { key: string; id?: string; filename: string; size: number; progress: number; error?: string }

interface Props {
  field: PublicFormField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Attachment fields: upload a file, returning its id. */
  upload?: (file: File, onProgress: (p: number) => void) => Promise<{ id: string }>;
  disabled?: boolean;
}

/** One question on a form, drawn for its field type. */
export function FormInput({ field, value, onChange, upload, disabled }: Props) {
  const choices = field.options.choices ?? [];
  switch (field.type) {
    case "longText":
      return <textarea rows={4} disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <input type="number" step="any" disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <input type="email" disabled={disabled} placeholder="name@example.com" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <input type="url" disabled={disabled} placeholder="https://" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <input type="tel" disabled={disabled} placeholder="+91 98765 43210" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return field.options.includeTime ? (
        <input type="datetime-local" disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="date" disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      );
    case "checkbox":
      return (
        <label className="row f-check">
          <input type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> Yes
        </label>
      );
    case "singleSelect":
    case "multipleSelect": {
      const multi = field.type === "multipleSelect";
      const selected = new Set(multi ? ((value as string[]) ?? []) : value ? [value as string] : []);
      if (!multi && choices.length > 8) {
        return (
          <select disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">Choose…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        );
      }
      return (
        <div className="f-choices">
          {choices.map((c) => {
            const on = selected.has(c.id);
            const tone = CHOICE_COLORS[c.color] ?? CHOICE_COLORS.gray;
            return (
              <button
                type="button"
                key={c.id}
                disabled={disabled}
                className={"f-choice" + (on ? " on" : "")}
                style={on ? { background: tone.bg, color: tone.fg, borderColor: tone.fg + "55" } : undefined}
                onClick={() => {
                  if (!multi) return onChange(on ? null : c.id);
                  const next = new Set(selected);
                  if (on) next.delete(c.id);
                  else next.add(c.id);
                  onChange([...next]);
                }}
              >
                <span className={"f-mark" + (multi ? " sq" : "")}>{on && <Check size={11} strokeWidth={3} />}</span>
                {c.name}
              </button>
            );
          })}
          {choices.length === 0 && <span className="muted small">No options set up yet.</span>}
        </div>
      );
    }
    case "attachment":
      return <FileInput value={(value as UploadedFile[]) ?? []} onChange={onChange} upload={upload} disabled={disabled} />;
    default:
      return <input disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

function FileInput({ value, onChange, upload, disabled }: {
  value: UploadedFile[]; onChange: (v: unknown) => void; upload?: Props["upload"]; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Keep a live copy so progress updates from parallel uploads don't overwrite each other.
  const latest = useRef(value);
  latest.current = value;
  const set = (fn: (v: UploadedFile[]) => UploadedFile[]) => { latest.current = fn(latest.current); onChange(latest.current); };

  const add = async (list: FileList | null) => {
    if (!list || !upload) return;
    const items = Array.from(list).map((f, i) => ({ file: f, key: `${Date.now()}-${i}` }));
    set((v) => [...v, ...items.map(({ file, key }) => ({ key, filename: file.name, size: file.size, progress: 0 }))]);
    for (const { file, key } of items) {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error("Larger than 25 MB");
        const { id } = await upload(file, (p) => set((v) => v.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        set((v) => v.map((x) => (x.key === key ? { ...x, id, progress: 1 } : x)));
      } catch (e) {
        set((v) => v.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)));
      }
    }
  };

  return (
    <div className="f-files">
      {value.map((f) => (
        <div key={f.key} className={"f-file" + (f.error ? " err" : "")}>
          {f.id ? <Check size={15} className="ok" /> : f.error ? <X size={15} /> : <Loader2 size={15} className="spin" />}
          <FileText size={15} />
          <span className="f-file-name">{f.filename}</span>
          <span className="muted small">{f.error ?? (f.id ? formatBytes(f.size) : `${Math.round(f.progress * 100)}%`)}</span>
          {!disabled && <button type="button" className="icon-btn" title="Remove" onClick={() => set((v) => v.filter((x) => x.key !== f.key))}><X size={14} /></button>}
        </div>
      ))}
      <div
        className={"f-drop" + (over ? " over" : "") + (disabled ? " disabled" : "")}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add(e.dataTransfer.files); }}
        onClick={() => !disabled && input.current?.click()}
        role="button"
      >
        <UploadCloud size={18} />
        <span>Drop files here or <u>browse</u></span>
        <input ref={input} type="file" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>
    </div>
  );
}
