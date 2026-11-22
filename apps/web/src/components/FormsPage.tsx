import type { Table, View } from "@brill/shared";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, ExternalLink, Link2, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { ShareLinkDialog } from "./ShareLinkDialog";

/** Every form in the base, across its tables — open one to edit it, or share its link. */
export function FormsPage({ baseId, tables, canEdit }: { baseId: string; tables: Table[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const schemas = useQueries({ queries: tables.map((t) => ({ queryKey: ["table", t.id], queryFn: () => api.table(t.id) })) });
  const [sharing, setSharing] = useState<View | null>(null);
  const [tableId, setTableId] = useState(tables[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const loading = schemas.some((s) => s.isLoading);
  const forms = tables.flatMap((t, i) => (schemas[i]?.data?.views ?? []).filter((v) => v.type === "form").map((v) => ({ table: t, view: v })));

  const create = async () => {
    const t = tables.find((x) => x.id === tableId);
    if (!t) return;
    setError(null);
    try {
      const n = forms.filter((f) => f.table.id === t.id).length + 1;
      const { view } = await api.createView(t.id, n > 1 ? `${t.name} form ${n}` : `${t.name} form`, "form");
      await qc.invalidateQueries({ queryKey: ["table", t.id] });
      nav(`/base/${baseId}/${t.id}/${view.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="forms-page">
      <div className="forms-head">
        <div>
          <h2>Forms</h2>
          <p className="muted">Share a form link to collect records — every answer becomes a new record in its table.</p>
        </div>
        {canEdit && tables.length > 0 && (
          <div className="forms-new">
            <select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table for the new form">
              {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn primary" onClick={create}><Plus size={15} /> New form</button>
          </div>
        )}
      </div>
      {error && <div className="error banner">{error}</div>}
      {loading ? (
        <div className="center"><div className="spinner" /></div>
      ) : forms.length === 0 ? (
        <div className="dash-empty">
          <ClipboardList size={26} />
          <strong>No forms yet</strong>
          <span>Make a form for a table, then share its link with clients or your team.</span>
        </div>
      ) : (
        <div className="forms-grid">
          {forms.map(({ table, view }) => (
            <div key={view.id} className="form-card">
              <span className="form-card-icon"><ClipboardList size={18} /></span>
              <div className="form-card-text">
                <strong>{view.config.form.title || view.name}</strong>
                <span className="muted small">{view.name} · adds records to {table.name}</span>
              </div>
              <div className="form-card-actions">
                <button className="btn sm" onClick={() => nav(`/base/${baseId}/${table.id}/${view.id}`)}><ExternalLink size={14} /> Open</button>
                <button className="btn sm" onClick={() => setSharing(view)}><Link2 size={14} /> Share</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {sharing && <ShareLinkDialog viewId={sharing.id} viewName={sharing.name} isForm canManage={canEdit} onClose={() => setSharing(null)} />}
    </div>
  );
}
