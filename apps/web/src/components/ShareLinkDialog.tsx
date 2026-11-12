import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Globe, Lock, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useDialogs } from "./Dialogs";

/** Create, copy, regenerate or turn off the public link for a view (a form, or a read-only view). */
export function ShareLinkDialog({ viewId, viewName, isForm, canManage, onClose }: {
  viewId: string; viewName: string; isForm: boolean; canManage: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const key = ["viewShare", viewId];
  const q = useQuery({ queryKey: key, queryFn: () => api.viewShare(viewId) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && document.querySelectorAll(".modal-backdrop").length === 1 && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const share = q.data?.share;
  const live = !!share?.enabled;
  const url = share ? `${window.location.origin}/${isForm ? "f" : "v"}/${share.token}` : "";
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: key }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-link-modal">
        <div className="modal-head">
          <div className={"modal-icon" + (live ? " live" : "")}>{live ? <Globe size={18} /> : <Lock size={18} />}</div>
          <div>
            <h3>{isForm ? "Share form" : "Share view"} “{viewName}”</h3>
            <p className="modal-sub">
              {isForm
                ? "Anyone with the link can fill in this form — no account needed. Each response becomes a new record."
                : "Anyone with the link can see this view read-only: only its visible fields, with its filters. No account needed."}
            </p>
          </div>
        </div>

        {q.isLoading ? <div className="center"><div className="spinner" /></div> : live ? (
          <>
            <div className="share-link-row">
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={async () => { await navigator.clipboard.writeText(url).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>
                {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}
              </button>
              <a className="btn" href={url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open</a>
            </div>
            {canManage && (
              <div className="share-link-actions">
                <button
                  className="link"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await dialogs.confirm({ title: "Make a new link?", message: "The current link stops working straight away.", confirmText: "New link" });
                    if (ok) run(() => api.enableShare(viewId, true));
                  }}
                >
                  <RefreshCw size={13} /> Make a new link
                </button>
                <button className="link danger-link" disabled={busy} onClick={() => run(() => api.disableShare(viewId))}>
                  <Lock size={13} /> Turn off link
                </button>
              </div>
            )}
          </>
        ) : canManage ? (
          <div><button className="btn primary" disabled={busy} onClick={() => run(() => api.enableShare(viewId))}><Globe size={15} /> Create public link</button></div>
        ) : (
          <div className="hint">This {isForm ? "form" : "view"} isn't shared. Ask a creator or owner of the base to share it.</div>
        )}
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
        <div className="modal-actions"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
