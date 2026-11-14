import { cellToText, formatDateCell } from "@brill/shared";
import { ImageOff, Play, Plus } from "lucide-react";
import { kindOf } from "./attachmentUtils";
import { ChoicePill } from "./Popover";
import type { ViewContext } from "./TableWorkspace";

const MIN_WIDTH = { small: 190, medium: 250, large: 340 };
const COVER_HEIGHT = { small: 120, medium: 170, large: 240 };

/** Cards with a cover image (or video) and the view's visible fields. */
export function GalleryView({ ctx }: { ctx: ViewContext }) {
  const { view, allFields, fields, records, primaryFieldId, files, labels } = ctx;
  const cfg = view.config;
  const coverField = allFields.find((f) => f.id === cfg.coverFieldId && f.type === "attachment");
  const primary = allFields.find((f) => f.id === primaryFieldId);
  const shownFields = fields.filter((f) => f.id !== primaryFieldId && f.id !== coverField?.id).slice(0, 6);

  const q = ctx.search.trim().toLowerCase();
  const shown = q
    ? records.filter((r) => allFields.some((f) => cellToText(f, r.cells[f.id] ?? null, labels).toLowerCase().includes(q)))
    : records;

  return (
    <div className="gallery" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${MIN_WIDTH[cfg.cardSize]}px, 1fr))` }}>
      {shown.map((r) => {
        const ids = coverField ? ((r.cells[coverField.id] as string[] | undefined) ?? []) : [];
        const cover = ids.map((id) => files[id]).find((f) => f && (f.thumbUrl || kindOf(f) === "video"));
        const name = primary ? cellToText(primary, r.cells[primary.id] ?? null, labels) : "";
        return (
          <button key={r.id} className="g-card" onClick={() => ctx.openRecord(r.id)}>
            {coverField && (
              <div className={"g-cover " + cfg.coverFit} style={{ height: COVER_HEIGHT[cfg.cardSize] }}>
                {cover?.thumbUrl ? (
                  <img src={cover.thumbUrl} alt="" loading="lazy" />
                ) : cover ? (
                  <>
                    <video src={`${cover.url}#t=0.1`} preload="metadata" muted playsInline />
                    <span className="play-badge lg"><Play size={14} fill="currentColor" /></span>
                  </>
                ) : (
                  <span className="g-nocover"><ImageOff size={22} /></span>
                )}
                {ids.length > 1 && <span className="g-count">{ids.length}</span>}
              </div>
            )}
            <div className="g-body">
              <div className="g-title">{name || <span className="muted">Unnamed record</span>}</div>
              {shownFields.map((f) => {
                const v = r.cells[f.id] ?? null;
                if (v === null) return null;
                let content: React.ReactNode;
                if (f.type === "singleSelect") content = <ChoicePill field={f} id={String(v)} />;
                else if (f.type === "multipleSelect") content = (v as string[]).map((id) => <ChoicePill key={id} field={f} id={id} />);
                else if (f.type === "date") content = formatDateCell(String(v));
                else if (f.type === "checkbox") content = "Yes";
                else if (f.type === "attachment") content = `${(v as string[]).length} file${(v as string[]).length === 1 ? "" : "s"}`;
                else content = cellToText(f, v, labels);
                return (
                  <div key={f.id} className="g-field">
                    <div className="card-label">{f.name}</div>
                    <div className="g-value">{content}</div>
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
      {ctx.canAddRecords && <button className="g-card g-add" onClick={async () => { const rec = await ctx.addRecord(); if (rec) ctx.openRecord(rec.id); }}>
        <Plus size={22} />
        <span>Add record</span>
      </button>}
    </div>
  );
}
