import { cellToText, formatDateCell, isNumericField, type CellValue, type Field } from "@brill/shared";
import { useQuery } from "@tanstack/react-query";
import { Eye, FileQuestion, Play, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type PublicView } from "../api";
import { BASE_COLORS } from "../colors";
import { LogoMark } from "../components/AppBar";
import { fileExt, kindOf } from "../components/attachmentUtils";
import { ChoicePill } from "../components/Popover";

/** A read-only view shared by link: a table (or cards for gallery views), search, and record details. */
export function PublicViewPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["publicView", token], queryFn: () => api.publicView(token!), retry: false, refetchInterval: 60_000 });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const data = q.data;
  const rows = useMemo(() => {
    if (!data) return [];
    const s = search.trim().toLowerCase();
    if (!s) return data.records;
    return data.records.filter((r) => data.fields.some((f) => cellToText(f, r.cells[f.id] ?? null, data.labels).toLowerCase().includes(s)));
  }, [data, search]);

  if (q.isLoading) return <div className="center"><div className="spinner" /></div>;
  if (q.isError || !data) {
    return (
      <div className="pf-page">
        <div className="pf-card pf-message">
          <FileQuestion size={34} />
          <h2>View not available</h2>
          <p className="muted">{(q.error as Error)?.message ?? "This link isn't active."}</p>
        </div>
      </div>
    );
  }
  const accent = BASE_COLORS[data.base.color] ?? BASE_COLORS.purple;
  const primary = data.fields.find((f) => f.id === data.table.primaryFieldId) ?? data.fields[0];
  const openRec = data.records.find((r) => r.id === open);

  return (
    <div className="pv-page">
      <header className="pv-head">
        <span className="base-dot" style={{ background: accent }}>{data.base.name.slice(0, 2)}</span>
        <div className="pv-title">
          <strong>{data.view.name}</strong>
          <span className="muted small">{data.base.name} · {data.table.name}</span>
        </div>
        <span className="role-pill"><Eye size={13} style={{ marginRight: 4 }} /> View only</span>
        <div className="spacer" />
        <input className="pv-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="count">{rows.length} record{rows.length === 1 ? "" : "s"}</span>
      </header>

      {data.view.type === "gallery" ? (
        <div className="gallery pv-gallery">
          {rows.map((r) => {
            const cover = ((r.cells[data.view.config.coverFieldId ?? ""] as string[] | undefined) ?? []).map((id) => data.files[id]).find((f) => f);
            return (
              <button key={r.id} className="g-card" onClick={() => setOpen(r.id)}>
                {data.view.config.coverFieldId && (
                  <div className={"g-cover " + data.view.config.coverFit} style={{ height: 170 }}>
                    {cover?.thumbUrl ? <img src={cover.thumbUrl} alt="" loading="lazy" /> : cover && kindOf(cover) === "video"
                      ? <><video src={`${cover.url}#t=0.1`} preload="metadata" muted playsInline /><span className="play-badge lg"><Play size={14} fill="currentColor" /></span></>
                      : <span className="g-nocover" />}
                  </div>
                )}
                <div className="g-body">
                  <div className="g-title">{primary ? cellToText(primary, r.cells[primary.id] ?? null, data.labels) || "Unnamed record" : ""}</div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>{data.fields.map((f) => <th key={f.id}>{f.name}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)}>
                  {data.fields.map((f) => (
                    <td key={f.id} className={isNumericField(f) ? "num" : ""}><Cell field={f} value={r.cells[f.id] ?? null} data={data} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="center muted" style={{ height: 160 }}>No records.</div>}
        </div>
      )}

      {openRec && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="modal record-modal">
            <div className="record-head">
              <h3>{primary ? cellToText(primary, openRec.cells[primary.id] ?? null, data.labels) || "Unnamed record" : "Record"}</h3>
              <div className="spacer" />
              <button className="icon-btn" title="Close" onClick={() => setOpen(null)}><X size={18} /></button>
            </div>
            <div className="record-fields">
              {data.fields.map((f) => (
                <div key={f.id} className="record-field">
                  <div className="record-label">{f.name}</div>
                  <div className="computed-value"><Cell field={f} value={openRec.cells[f.id] ?? null} data={data} big /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="pf-brand"><LogoMark size={18} /> Shared from Brill Tables</div>
    </div>
  );
}

function Cell({ field, value, data, big }: { field: Field; value: CellValue; data: PublicView; big?: boolean }) {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case "singleSelect":
      return <ChoicePill field={field} id={String(value)} />;
    case "multipleSelect":
      return <span className="pv-pills">{(value as string[]).map((id) => <ChoicePill key={id} field={field} id={id} />)}</span>;
    case "checkbox":
      return <span className="pv-check">✓</span>;
    case "date":
      return <>{formatDateCell(String(value), field.options)}</>;
    case "url":
      return <a href={String(value)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{String(value)}</a>;
    case "attachment":
      return (
        <span className={"pv-files" + (big ? " big" : "")}>
          {(value as string[]).map((id) => {
            const f = data.files[id];
            if (!f) return null;
            return (
              <a key={id} href={f.url} target="_blank" rel="noreferrer" title={f.filename} onClick={(e) => e.stopPropagation()}>
                {f.thumbUrl ? <img src={f.thumbUrl} alt={f.filename} loading="lazy" /> : <span className="mini-ext">{kindOf(f) === "video" ? "▶" : fileExt(f.filename)}</span>}
              </a>
            );
          })}
        </span>
      );
    default:
      return <>{cellToText(field, value, data.labels)}</>;
  }
}
