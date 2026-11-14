import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Copy, Link2, Lock, Mail, UserMinus, Users, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type Member, type Role } from "../api";
import { initials } from "./AppBar";
import { useDialogs } from "./Dialogs";

export const ROLE_INFO: Record<Role, { label: string; hint: string }> = {
  owner: { label: "Owner", hint: "Full access, manages members" },
  creator: { label: "Creator", hint: "Builds tables, fields and views" },
  editor: { label: "Editor", hint: "Adds and edits records" },
  commenter: { label: "Commenter", hint: "Views and comments" },
  read: { label: "Read only", hint: "Can only view" },
};
const WS_ROLES: Role[] = ["owner", "creator", "editor", "commenter", "read"];
const BASE_ROLES: Role[] = ["creator", "editor", "commenter", "read"];
type Scope = "base" | "workspace";

/** Who can open this base: people invited to just this base (e.g. clients) and the workspace team. */
export function ShareDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const key = ["baseSharing", baseId];
  const q = useQuery({ queryKey: key, queryFn: () => api.baseSharing(baseId) });
  const me = qc.getQueryData<{ user: { id: string } | null }>(["me"])?.user;
  const d = q.data;

  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<Scope>("base");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; emailed: boolean; scope: Scope } | null>(null);
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
    if (!d) return;
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const r = scope === "base"
        ? await api.inviteToBase(baseId, email.trim(), role)
        : await api.invite(d.workspace.id, email.trim(), role);
      setLink({ email: r.invite.email, url: window.location.origin + r.invite.path, emailed: r.invite.emailed, scope });
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

  const remove = async (m: Member, kind: Scope) => {
    const leaving = m.userId === me?.id;
    const where = kind === "base" ? "this base" : "this workspace";
    const ok = await dialogs.confirm({
      title: leaving ? `Leave ${where}?` : `Remove ${m.name}?`,
      message: leaving
        ? "You'll lose access to it."
        : kind === "base" ? "They'll lose access to this base." : "They'll lose access to every base in this workspace.",
      confirmText: leaving ? "Leave" : "Remove",
      danger: true,
    });
    if (!ok || !d) return;
    run(async () => {
      if (kind === "base") await api.removeBaseMember(baseId, m.userId);
      else await api.removeMember(d.workspace.id, m.userId);
      if (leaving) window.location.href = "/";
    });
  };

  const row = (m: Member, kind: Scope) => {
    const manage = kind === "base" ? d!.canManageBase : d!.canManageWorkspace;
    const roles = kind === "base" ? BASE_ROLES : WS_ROLES;
    return (
      <div key={kind + m.userId} className="share-row">
        <span className={"avatar" + (kind === "base" ? " guest" : "")}>{initials(m.name)}</span>
        <div className="share-who">
          <strong>{m.name}{m.userId === me?.id && <span className="muted"> (you)</span>}</strong>
          {m.email && <span className="muted small">{m.email}</span>}
        </div>
        {manage ? (
          <select
            value={m.role}
            title={ROLE_INFO[m.role].hint}
            onChange={(e) => run(() => kind === "base"
              ? api.setBaseMemberRole(baseId, m.userId, e.target.value as Role)
              : api.setMemberRole(d!.workspace.id, m.userId, e.target.value as Role))}
          >
            {roles.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
          </select>
        ) : (
          <span className="role-pill">{ROLE_INFO[m.role].label}</span>
        )}
        {(manage || m.userId === me?.id) && (
          <button className="icon-btn danger" title={m.userId === me?.id ? "Leave" : "Remove access"} onClick={() => remove(m, kind)}>
            <UserMinus size={15} />
          </button>
        )}
      </div>
    );
  };

  const canInvite = d && (d.canManageBase || d.canManageWorkspace);
  const scopeRoles = scope === "base" ? BASE_ROLES : WS_ROLES;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal">
        <div className="modal-head">
          <div className="modal-icon"><Users size={18} /></div>
          <div>
            <h3>Share “{d?.base.name ?? "…"}”</h3>
            <p className="modal-sub">
              {d?.guest
                ? "You were invited to this base only."
                : "Invite a client to just this base, or a teammate to the whole workspace."}
            </p>
          </div>
          <div className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </div>

        {canInvite && (
          <form className="share-invite-box" onSubmit={invite}>
            <div className="share-scope" role="radiogroup" aria-label="Give access to">
              <button type="button" role="radio" aria-checked={scope === "base"} className={scope === "base" ? "on" : ""}
                disabled={!d!.canManageBase}
                onClick={() => { setScope("base"); if (role === "owner") setRole("editor"); }}>
                <Lock size={14} /> Only this base
                <small>For clients — they won't see your other bases</small>
              </button>
              <button type="button" role="radio" aria-checked={scope === "workspace"} className={scope === "workspace" ? "on" : ""}
                disabled={!d!.canManageWorkspace} title={d!.canManageWorkspace ? "" : "Only workspace owners can add people to the workspace"}
                onClick={() => setScope("workspace")}>
                <Building2 size={14} /> Whole workspace
                <small>For your team — every base in “{d!.workspace.name}”</small>
              </button>
            </div>
            <div className="share-invite">
              <div className="input-icon">
                <Mail size={15} />
                <input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {scopeRoles.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
              </select>
              <button className="btn primary" disabled={busy || !email.trim()}>{busy ? "Inviting…" : "Invite"}</button>
            </div>
          </form>
        )}

        {link && (
          <div className="share-link">
            <div className="share-link-head"><Link2 size={15} /> {link.emailed ? <>Invite emailed to <b>{link.email}</b></> : <>Send this link to <b>{link.email}</b></>}</div>
            <p className="muted small">
              {link.emailed ? "They get access once they accept. You can also send them this link another way. " : "We couldn't send the email, so copy the link and send it yourself. "}
              It works only for this email and expires in 14 days.
            </p>
            <div className="share-link-row">
              <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={copy}>{copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}</button>
            </div>
          </div>
        )}
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}

        <div className="share-list">
          {q.isLoading && <div className="center"><div className="spinner" /></div>}
          {d && (
            <>
              <div className="share-group">
                <Lock size={13} /> Only this base <span className="muted">· {d.guests.length}</span>
              </div>
              {d.guests.length === 0 && <div className="share-empty">Nobody yet. Invite a client here to let them see and edit just this base.</div>}
              {d.guests.map((m) => row(m, "base"))}

              <div className="share-group">
                <Building2 size={13} /> Workspace team · {d.workspace.name} <span className="muted">· {d.members.length}</span>
              </div>
              {d.members.map((m) => row(m, "workspace"))}

              {d.invites.length > 0 && <div className="share-group"><Mail size={13} /> Waiting to accept</div>}
              {d.invites.map((i) => (
                <div key={i.id} className="share-row pending">
                  <span className="avatar ghost"><Mail size={14} /></span>
                  <div className="share-who">
                    <strong>{i.email}</strong>
                    <span className="muted small">
                      {i.scope === "base" ? "This base only" : "Whole workspace"} · expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="role-pill">{ROLE_INFO[i.role].label}</span>
                  <button className="icon-btn danger" title="Cancel invite"
                    onClick={() => run(() => i.scope === "base" ? api.cancelBaseInvite(baseId, i.id) : api.cancelInvite(d.workspace.id, i.id))}>
                    <X size={15} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {d && !d.guest && (
          <div className="share-tip">
            <Lock size={14} />
            <span>
              To let a client write captions but not change the reel or status, open a field's <b>Edit field</b> and set
              <b> Who can edit</b> to <b>Workspace team only</b>.
            </span>
          </div>
        )}
        <div className="share-roles">
          {WS_ROLES.map((r) => <span key={r}><b>{ROLE_INFO[r].label}</b> — {ROLE_INFO[r].hint}</span>)}
        </div>
      </div>
    </div>
  );
}
