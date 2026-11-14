import type { User } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MonitorSmartphone, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { initials } from "./AppBar";

/** Account settings: name, password, and signing out of other devices. */
export function AccountDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; part: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const run = async (part: string, fn: () => Promise<string>) => {
    setBusy(part);
    setMsg(null);
    try {
      setMsg({ kind: "ok", text: await fn(), part });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message, part });
    } finally {
      setBusy(null);
    }
  };
  const note = (part: string) =>
    msg?.part === part ? <div className={msg.kind === "ok" ? "acct-ok" : "error"}>{msg.text}</div> : null;

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    run("name", async () => {
      await api.updateMe(name.trim());
      await qc.invalidateQueries({ queryKey: ["me"] });
      return "Name saved.";
    });
  };
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    run("password", async () => {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      await qc.invalidateQueries({ queryKey: ["sessions"] });
      return "Password changed. Your other devices have been signed out.";
    });
  };

  const others = Math.max(0, (sessions.data?.active ?? 1) - 1);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal acct-modal" role="dialog" aria-modal="true" aria-labelledby="acct-title">
        <div className="modal-head">
          <span className="avatar acct-avatar">{initials(user.name)}</span>
          <div>
            <h3 id="acct-title">Account settings</h3>
            <p className="modal-sub">{user.email}</p>
          </div>
        </div>

        <form className="acct-section" onSubmit={saveName}>
          <div className="acct-title"><UserRound size={15} /> Profile</div>
          <label className="field-label" htmlFor="acct-name">Full name</label>
          <div className="acct-row">
            <input id="acct-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={busy === "name" || !name.trim() || name.trim() === user.name}>Save</button>
          </div>
          {note("name")}
        </form>

        <form className="acct-section" onSubmit={savePassword}>
          <div className="acct-title"><KeyRound size={15} /> Password</div>
          <label className="field-label" htmlFor="acct-cur">Current password</label>
          <input id="acct-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <label className="field-label" htmlFor="acct-new">New password</label>
          <input id="acct-new" type="password" autoComplete="new-password" minLength={10} placeholder="At least 10 characters" value={next} onChange={(e) => setNext(e.target.value)} />
          <div><button className="btn" disabled={busy === "password" || !current || next.length < 10}>Change password</button></div>
          {note("password")}
        </form>

        <div className="acct-section">
          <div className="acct-title"><MonitorSmartphone size={15} /> Devices</div>
          <p className="modal-sub" style={{ margin: 0 }}>
            {sessions.isLoading ? "…" : others === 0 ? "You're only signed in here." : `You're also signed in on ${others} other ${others === 1 ? "device or browser" : "devices or browsers"}.`}
          </p>
          <div>
            <button
              className="btn"
              disabled={busy === "devices" || others === 0}
              onClick={() => run("devices", async () => {
                await api.revokeOtherSessions();
                await qc.invalidateQueries({ queryKey: ["sessions"] });
                return "Signed out of all other devices.";
              })}
            >
              Sign out of other devices
            </button>
          </div>
          {note("devices")}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
