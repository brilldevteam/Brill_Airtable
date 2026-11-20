import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Search, Sheet, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type TrashItem } from "../api";
import { useDialogs } from "./Dialogs";

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
const daysLeft = (iso: string, days: number) => Math.max(0, days - Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000));

/** Deleted records of a base: restore them (with their links) or delete them for good. */
export function TrashDialog({ baseId, canDeleteForever, onRestored, onClose }: {
  baseId: string; canDeleteForever: boolean; onRestored: () => void; onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const key = ["trash", baseId];
  const q = useQuery({ queryKey: key, queryFn: () => api.trash(baseId) });
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && document.querySelectorAll(".modal-backdrop").length === 1 && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const items = (q.data?.items ?? []).filter((i) =>
    (i.name + " " + i.tableName + " " + i.details.map((d) => d.value).join(" ")).toLowerCase().includes(find.trim().toLowerCase()));

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
      onRestored();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const restoreAll = () => run("all", async () => {
    for (const i of items) await api.restoreRecord(i.id);
  });
  const forever = async (i: TrashItem) => {
    const ok = await dialogs.confirm({
      title: `Delete “${i.name || "Unnamed record"}” forever?`,
      message: "It will be removed permanently and can't be restored.",
      confirmText: "Delete forever",
      danger: true,
    });
    if (ok) run(i.id, () => api.deleteRecordForever(i.id));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal trash-modal" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <div className="modal-head">
          <div className="modal-icon"><Trash2 size={18} /></div>
          <div>
            <h3 id="trash-title">Trash</h3>
            <p className="modal-sub">Deleted records stay here for {q.data?.days ?? 30} days. Restoring puts a record back with its links.</p>
          </div>
          <div className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </div>

        {(q.data?.items.length ?? 0) > 0 && (
          <div className="trash-bar">
            <div className="input-icon trash-find">
              <Search size={14} />
              <input placeholder="Find a deleted record" value={find} onChange={(e) => setFind(e.target.value)} />
            </div>
            <button className="btn" disabled={!items.length || busy !== null} onClick={restoreAll}>
              <RotateCcw size={14} /> Restore {find ? "these" : "all"} ({items.length})
            </button>
          </div>
        )}
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}

        <div className="trash-list">
          {q.isLoading && <div className="center"><div className="spinner" /></div>}
          {q.data && q.data.items.length === 0 && (
            <div className="trash-empty">
              <Trash2 size={22} />
              <strong>The trash is empty</strong>
              <span>Records you delete in this base will show up here.</span>
            </div>
          )}
          {items.map((i) => (
            <div key={i.id} className="trash-row">
              <div className="trash-main">
                <div className="trash-name">
                  <span className="trash-table"><Sheet size={12} /> {i.tableName}</span>
                  <strong>{i.name || <span className="muted">Unnamed record</span>}</strong>
                </div>
                {i.details.length > 0 && (
                  <div className="trash-details">{i.details.map((d) => <span key={d.field}><em>{d.field}</em> {d.value}</span>)}</div>
                )}
                <div className="trash-meta">
                  Deleted {timeAgo(i.deletedAt)}{i.deletedBy ? ` by ${i.deletedBy}` : ""} · removed for good in {daysLeft(i.deletedAt, q.data!.days)} days
                </div>
              </div>
              <button className="btn sm" disabled={busy !== null} onClick={() => run(i.id, () => api.restoreRecord(i.id))}>
                <RotateCcw size={13} /> {busy === i.id ? "Restoring…" : "Restore"}
              </button>
              {canDeleteForever && (
                <button className="icon-btn danger" title="Delete forever" disabled={busy !== null} onClick={() => forever(i)}><Trash2 size={15} /></button>
              )}
            </div>
          ))}
          {q.data && q.data.items.length > 0 && items.length === 0 && <div className="panel-empty" style={{ padding: 14 }}>Nothing matches “{find}”.</div>}
        </div>
      </div>
    </div>
  );
}
