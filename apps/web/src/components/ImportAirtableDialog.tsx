import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, KeyRound, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type ImportJob, type Workspace } from "../api";

type AtBase = { id: string; name: string; permissionLevel: string };

/**
 * Move bases over from Airtable: paste a personal access token, pick bases, and watch them arrive.
 * The token stays in this dialog's memory and is only sent to our server for the import.
 */
export function ImportAirtableDialog({ workspaces, onClose }: { workspaces: Workspace[]; onClose: () => void }) {
  const qc = useQueryClient();
  const writable = workspaces.filter((w) => w.role === "owner" || w.role === "creator");
  const [token, setToken] = useState("");
  const [bases, setBases] = useState<AtBase[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [workspaceId, setWorkspaceId] = useState(writable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const running = job?.status === "running";

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !running && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, running]);

  // Follow the import until it finishes.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = window.setTimeout(async () => {
      try {
        const { job: next } = await api.importJob(job.id);
        setJob(next);
        if (next.status !== "running") {
          setToken(""); // done with it
          await qc.invalidateQueries({ queryKey: ["workspaces"] });
        }
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [job, qc]);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.airtableBases(token.trim());
      setBases(r.bases);
      setPicked(new Set(r.bases.map((b) => b.id)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = (bases ?? []).filter((b) => picked.has(b.id)).map((b) => ({ id: b.id, name: b.name }));
      const r = await api.startAirtableImport({ token: token.trim(), workspaceId, bases: chosen });
      setJob(r.job);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal at-import" role="dialog" aria-modal="true" aria-labelledby="at-title">
        <div className="modal-head">
          <span className="at-logo"><ArrowRight size={18} /></span>
          <div>
            <h3 id="at-title">Import from Airtable</h3>
            <p className="modal-sub">Bring your bases over — tables, records, files, links, formulas and views.</p>
          </div>
          <div className="spacer" />
          {!running && <button className="icon-btn" onClick={onClose} title="Close"><X size={18} /></button>}
        </div>

        {!job && !bases && (
          <form onSubmit={connect} className="at-step">
            <ol className="at-howto">
              <li>
                Open <a href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer noopener">airtable.com/create/tokens <ExternalLink size={12} /></a> and click <b>Create token</b>.
              </li>
              <li>Add the scopes <code>schema.bases:read</code> and <code>data.records:read</code>.</li>
              <li>Under <b>Access</b>, add the bases (or the whole workspace) you want to move.</li>
              <li>Create it, copy the token and paste it here.</li>
            </ol>
            <label className="field-label" htmlFor="at-token">Personal access token</label>
            <div className="input-icon">
              <KeyRound size={15} />
              <input id="at-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="pat…" autoFocus />
            </div>
            <p className="field-hint">Used only for this import and never saved. You can delete the token in Airtable afterwards.</p>
            {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || token.trim().length < 10}>{busy ? "Connecting…" : "Connect"}</button>
            </div>
          </form>
        )}

        {!job && bases && (
          <div className="at-step">
            {bases.length === 0 ? (
              <div className="panel-empty">This token can't see any bases. In Airtable, edit the token and add bases under “Access”.</div>
            ) : (
              <>
                <div className="at-list-head">
                  <b>{bases.length} base{bases.length === 1 ? "" : "s"} found</b>
                  <button className="link" onClick={() => setPicked(picked.size === bases.length ? new Set() : new Set(bases.map((b) => b.id)))}>
                    {picked.size === bases.length ? "Select none" : "Select all"}
                  </button>
                </div>
                <div className="at-list">
                  {bases.map((b) => (
                    <label key={b.id} className="at-base">
                      <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} />
                      <span>{b.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <label className="field-label" htmlFor="at-ws">Put them in</label>
            {writable.length ? (
              <select id="at-ws" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {writable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            ) : (
              <div className="error">You need to be a creator in a workspace to import bases.</div>
            )}
            <p className="field-hint">Large bases with many files can take a few minutes. Your Airtable bases aren't changed.</p>
            {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => { setBases(null); setError(null); }}>Back</button>
              <button className="btn primary" disabled={busy || !picked.size || !workspaceId} onClick={start}>
                {busy ? "Starting…" : `Import ${picked.size} base${picked.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}

        {job && (
          <div className="at-step">
            <div className={"at-status " + job.status}>
              {job.status === "running" ? <Loader2 size={16} className="spin" /> : job.status === "done" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <span>{job.status === "running" ? job.step : job.status === "done" ? "Import finished" : job.error ?? "Import failed"}</span>
            </div>
            <div className="at-results">
              {job.bases.map((b) => (
                <div key={b.airtableId} className={"at-result " + b.status}>
                  <div className="at-result-head">
                    <strong>{b.name}</strong>
                    <span className="muted small">
                      {b.status === "waiting" ? "Waiting…" : `${b.tables} table${b.tables === 1 ? "" : "s"} · ${b.records.toLocaleString()} records · ${b.files.toLocaleString()} files`}
                    </span>
                    <div className="spacer" />
                    {b.status === "done" && b.baseId && <Link className="btn sm" to={`/base/${b.baseId}`} onClick={onClose}>Open <ArrowRight size={13} /></Link>}
                  </div>
                  {b.error && <div className="error small">{b.error}</div>}
                  {b.notes.length > 0 && (
                    <details className="at-notes">
                      <summary><AlertTriangle size={13} /> {b.notes.length} thing{b.notes.length === 1 ? "" : "s"} to check</summary>
                      <ul>{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
            {running && <p className="field-hint">You can keep this open — it updates by itself. Please don't close the tab until it finishes.</p>}
            {!running && <div className="modal-actions"><button className="btn primary" onClick={onClose}>Done</button></div>}
          </div>
        )}
      </div>
    </div>
  );
}
