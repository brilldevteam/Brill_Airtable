import { ArrowDownAZ, GripVertical, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { CHOICE_COLORS } from "../colors";

export interface ChoiceDraft { key: string; id?: string; name: string; color: string }

const COLORS = Object.keys(CHOICE_COLORS);
let seq = 0;
export const newDraft = (name = "", color = COLORS[seq % COLORS.length]): ChoiceDraft => ({ key: `n${Date.now()}${seq++}`, name, color });

/**
 * Airtable-style options for select fields: a coloured pill per option — rename in place,
 * pick a colour, drag to reorder, remove, add, sort A→Z — plus the default for new records.
 */
export function ChoiceEditor({ choices, onChange, defaultKey, onDefault }: {
  choices: ChoiceDraft[]; onChange: (c: ChoiceDraft[]) => void;
  defaultKey: string | null; onDefault: (key: string | null) => void;
}) {
  const [palette, setPalette] = useState<string | null>(null);
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const set = (i: number, patch: Partial<ChoiceDraft>) => onChange(choices.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => {
    const d = newDraft("", COLORS[choices.length % COLORS.length]);
    onChange([...choices, d]);
    setTimeout(() => inputs.current[d.key]?.focus(), 0);
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...choices];
    const [c] = next.splice(from, 1);
    next.splice(to, 0, c);
    onChange(next);
  };

  return (
    <div className="choice-editor">
      <div className="ce-head">
        <span className="field-label" style={{ margin: 0 }}>Options</span>
        {choices.length > 1 && (
          <button type="button" className="link" onClick={() => onChange([...choices].sort((a, b) => a.name.localeCompare(b.name)))}>
            <ArrowDownAZ size={14} /> Alphabetize
          </button>
        )}
      </div>
      <div className="ce-list">
        {choices.map((c, i) => {
          const tone = CHOICE_COLORS[c.color] ?? CHOICE_COLORS.blue;
          return (
            <div
              key={c.key}
              className={"ce-row" + (over === i ? " over" : "")}
              draggable
              onDragStart={(e) => { drag.current = i; e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); if (drag.current !== null) move(drag.current, i); drag.current = null; setOver(null); }}
              onDragEnd={() => { drag.current = null; setOver(null); }}
            >
              <GripVertical size={14} className="ce-grip" />
              <button type="button" className="ce-dot" style={{ background: tone.fg }} title="Colour" onClick={() => setPalette(palette === c.key ? null : c.key)} />
              <input
                ref={(el) => { inputs.current[c.key] = el; }}
                className="ce-name"
                style={{ background: tone.bg, color: tone.fg }}
                value={c.name}
                placeholder="Option name"
                maxLength={100}
                onChange={(e) => set(i, { name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
              />
              <button type="button" className="icon-btn ce-x" title="Remove option" onClick={() => { onChange(choices.filter((_, j) => j !== i)); if (defaultKey === c.key) onDefault(null); }}>
                <X size={14} />
              </button>
              {palette === c.key && (
                <div className="ce-palette">
                  {COLORS.map((k) => (
                    <button type="button" key={k} title={k} className={"ce-swatch" + (k === c.color ? " on" : "")}
                      style={{ background: CHOICE_COLORS[k].bg, borderColor: CHOICE_COLORS[k].fg }}
                      onClick={() => { set(i, { color: k }); setPalette(null); }} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {choices.length === 0 && <div className="panel-empty" style={{ padding: "6px 2px" }}>No options yet.</div>}
      </div>
      <button type="button" className="link ce-add" onClick={add}><Plus size={14} /> Add option</button>
      <label>
        Default for new records
        <select value={defaultKey ?? ""} onChange={(e) => onDefault(e.target.value || null)}>
          <option value="">No default</option>
          {choices.filter((c) => c.name.trim()).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
      </label>
    </div>
  );
}
