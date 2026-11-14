import { cellToText, formatDateCell, type RecordRow } from "@brill/shared";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { CHOICE_COLORS } from "../colors";
import type { ViewContext } from "./TableWorkspace";

const NONE = "__none__";

export function KanbanView({ ctx }: { ctx: ViewContext }) {
  const { view, allFields, fields, records, primaryFieldId, saveCells } = ctx;
  const stackField = allFields.find((f) => f.id === view.config.stackFieldId && f.type === "singleSelect");
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  if (!stackField) {
    return (
      <div className="center muted kanban-empty">
        Choose a single select field to stack records by, using the button in the toolbar.
      </div>
    );
  }

  const stacks = [{ id: NONE, name: `No ${stackField.name}`, color: "gray" }, ...(stackField.options.choices ?? [])];
  const byStack = new Map<string, RecordRow[]>(stacks.map((s) => [s.id, []]));
  const q = ctx.search.trim().toLowerCase();
  const shown = q
    ? records.filter((r) => allFields.some((f) => cellToText(f, r.cells[f.id] ?? null, ctx.labels).toLowerCase().includes(q)))
    : records;
  for (const r of shown) {
    const v = r.cells[stackField.id];
    const key = typeof v === "string" && byStack.has(v) ? v : NONE;
    byStack.get(key)!.push(r);
  }

  const primary = allFields.find((f) => f.id === primaryFieldId);
  // Show up to 4 visible non-primary fields on each card (the stacking field is shown by the column).
  const cardFields = fields.filter((f) => f.id !== primaryFieldId && f.id !== stackField.id).slice(0, 4);

  const drop = (stackId: string) => {
    if (dragId) saveCells(dragId, { [stackField.id]: stackId === NONE ? null : stackId });
    setDragId(null);
    setOver(null);
  };

  return (
    <div className="kanban">
      {stacks.map((s) => {
        const items = byStack.get(s.id)!;
        if (s.id === NONE && items.length === 0) return null;
        const col = CHOICE_COLORS[s.color] ?? CHOICE_COLORS.gray;
        return (
          <div
            key={s.id}
            className={"kanban-col" + (over === s.id ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
            onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
            onDrop={() => drop(s.id)}
          >
            <div className="kanban-head">
              <span className="pill" style={{ background: col.bg, color: col.fg }}>{s.name}</span>
              <span className="muted">{items.length}</span>
            </div>
            <div className="kanban-cards">
              {items.map((r) => (
                <div
                  key={r.id}
                  className={"card" + (dragId === r.id ? " dragging" : "")}
                  draggable={ctx.canEditField(stackField)}
                  onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  onClick={() => ctx.openRecord(r.id)}
                >
                  {(() => {
                    const cover = allFields
                      .filter((f) => f.type === "attachment")
                      .flatMap((f) => (r.cells[f.id] as string[] | undefined) ?? [])
                      .map((id) => ctx.files[id])
                      .find((a) => a?.thumbUrl);
                    return cover ? <img className="card-cover" src={cover.thumbUrl!} alt="" loading="lazy" /> : null;
                  })()}
                  <div className="card-title">{primary ? cellToText(primary, r.cells[primary.id] ?? null) || "Unnamed record" : r.id}</div>
                  {cardFields.map((f) => {
                    const v = r.cells[f.id] ?? null;
                    if (v === null) return null; // keep cards compact: skip empty fields
                    if (f.type === "attachment") return null; // shown as the cover
                    const text = f.type === "date" ? formatDateCell(String(v)) : f.type === "checkbox" ? "Yes" : cellToText(f, v, ctx.labels);
                    return (
                      <div key={f.id} className="card-field">
                        <div className="card-label">{f.name}</div>
                        <div className="card-value">{text}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {ctx.canAddRecords && (s.id === NONE || ctx.canEditField(stackField)) && <button
              className="kanban-add"
              onClick={async () => {
                const rec = await ctx.addRecord(s.id === NONE ? {} : { [stackField.id]: s.id });
                if (rec) ctx.openRecord(rec.id);
              }}
            >
              <Plus size={15} /> Add record
            </button>}
          </div>
        );
      })}
    </div>
  );
}
