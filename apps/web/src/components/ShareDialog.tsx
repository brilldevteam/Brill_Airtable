import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Mail, UserMinus, Users, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type Role } from "../api";
import { initials } from "./AppBar";
import { useDialogs } from "./Dialogs";

export const ROLE_INFO: Record<Role, { label: string; hint: string }> = {
  owner: { label: "Owner", hint: "Full access, manages members" },
  creator: { label: "Creator", hint: "Builds tables, fields and bases" },
  editor: { label: "Editor", hint: "Adds and edits records" },
  commenter: { label: "Commenter", hint: "Views and comments" },
  read: { label: "Read only", hint: "Can only view" },
};
const ROLES: Role[] = ["owner", "creator", "editor", "commenter", "read"];

/** Members of the workspace, their roles, and inviting new people. */
export function ShareDialog({ wsId, workspaceName, onClose }: { wsId: string; workspaceName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const key = ["members", wsId];
  const q = useQuery({ queryKey: key, queryFn: () => api.members(wsId) });
  const me = qc.getQueryData<{ user: { id: string } | null }>(["me"])?.user;
  const isOwner = q.data?.myRole === "owner";

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelectorAll(".modal-backdrop")[1] && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const r = await api.invite(wsId, email.trim(), role);
      if (r.invite) setLink({ email: r.invite.email, url: window.location.origin + r.invite.path });
      setEmail("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal">
        <div className="modal-head">
          <div className="modal-icon"><Users size={18} /></div>
          <div>
            <h3>Share “{workspaceName}”</h3>
            <p className="modal-sub">Everyone here can open every base in this workspace, with the access their role allows.</p>
          </div>
          <div className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </div>

        {isOwner && (
          <form className="share-invite" onSubmit={invite}>
            <div className="input-icon">
              <Mail size={15} />
              <input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </select>
            <button className="btn primary" disabled={busy || !email.trim()}>{busy ? "Inviting…" : "Invite"}</button>
          </form>
        )}

        {link && (
          <div className="share-link">
            <div className="share-link-head"><Link2 size={15} /> Send this link to <b>{link.email}</b></div>
            <p className="muted small">They don't have an account yet. The link works only for this email and expires in 14 days.</p>
            <div className="share-link-row">
              <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={copy}>{copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}</button>
            </div>
          </div>
        )}
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}

        <div className="share-list">
          {q.isLoading && <div className="center"><div className="spinner" /></div>}
          {q.data?.members.map((m) => (
            <div key={m.userId} className="share-row">
              <span className="avatar">{initials(m.name)}</span>
              <div className="share-who">
                <strong>{m.name}{m.userId === me?.id && <span className="muted"> (you)</span>}</strong>
                <span className="muted small">{m.email}</span>
              </div>
              {isOwner ? (
                <select
                  value={m.role}
                  title={ROLE_INFO[m.role].hint}
                  onChange={(e) => run(() => api.setMemberRole(wsId, m.userId, e.target.value as Role))}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                </select>
              ) : (
                <span className="role-pill">{ROLE_INFO[m.role].label}</span>
              )}
              {(isOwner || m.userId === me?.id) && (
                <button
                  className="icon-btn danger"
                  title={m.userId === me?.id ? "Leave workspace" : "Remove"}
                  onClick={async () => {
                    const leaving = m.userId === me?.id;
                    const ok = await dialogs.confirm({
                      title: leaving ? "Leave this workspace?" : `Remove ${m.name}?`,
                      message: leaving ? "You'll lose access to its bases." : "They'll lose access to every base in this workspace.",
                      confirmText: leaving ? "Leave" : "Remove",
                      danger: true,
                    });
                    if (ok) run(async () => { await api.removeMember(wsId, m.userId); if (leaving) window.location.href = "/"; });
                  }}
                >
                  <UserMinus size={15} />
                </button>
              )}
            </div>
          ))}
          {q.data?.invites.map((i) => (
            <div key={i.id} className="share-row pending">
              <span className="avatar ghost"><Mail size={14} /></span>
              <div className="share-who">
                <strong>{i.email}</strong>
                <span className="muted small">Invited · link expires {new Date(i.expiresAt).toLocaleDateString()}</span>
              </div>
              <span className="role-pill">{ROLE_INFO[i.role].label}</span>
              <button className="icon-btn danger" title="Cancel invite" onClick={() => run(() => api.cancelInvite(wsId, i.id))}><X size={15} /></button>
            </div>
          ))}
        </div>

        <div className="share-roles">
          {ROLES.map((r) => <span key={r}><b>{ROLE_INFO[r].label}</b> — {ROLE_INFO[r].hint}</span>)}
        </div>
      </div>
    </div>
  );
}
