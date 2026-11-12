import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Users } from "lucide-react";
import { api } from "../api";
import { LogoMark } from "../components/AppBar";

const PREVIEW = [
  ["Order", "Customer", "Status"],
  ["Wedding banner", "Acme Weddings", "In progress"],
  ["Business cards ×500", "Bolt Printing", "Done"],
  ["Shop signage", "Northwind Café", "Todo"],
];

export function LoginPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteToken = /^\/invite\/([\w-]+)/.exec(window.location.pathname)?.[1];
  const [invite, setInvite] = useState<{ email: string; workspace: string; invitedBy: string | null } | null>(null);
  useEffect(() => {
    if (!inviteToken) return;
    api.inviteInfo(inviteToken).then((i) => { setInvite(i); setEmail(i.email); setMode("register"); }, () => undefined);
  }, [inviteToken]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await api.login(email, password);
      else await api.register(name, email, password);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth-brand">
        <span className="logo"><LogoMark size={32} /> Brill Tables</span>
        <div className="auth-pitch">
          <h2>All of Brill’s work, organised in one place.</h2>
          <p>Orders, customers and projects — linked together, filtered your way, and always up to date.</p>
          <div className="auth-preview" aria-hidden>
            {PREVIEW.map((row, i) => (
              <div className="auth-preview-row" key={i}>
                <span>{row[0]}</span>
                <span>{row[1]}</span>
                {i === 0 ? <span>{row[2]}</span> : <span className="tag">{row[2]}</span>}
              </div>
            ))}
          </div>
        </div>
      </aside>

      <div className="auth-form-wrap">
        <form className="auth-card" onSubmit={submit}>
          <span className="logo auth-mobile-logo"><LogoMark /> Brill Tables</span>
          {invite && (
            <div className="invite-banner">
              <Users size={16} />
              <span><b>{invite.invitedBy ?? "Someone"}</b> invited you to <b>{invite.workspace}</b>. {mode === "register" ? "Create an account" : "Sign in"} with {invite.email} to join.</span>
            </div>
          )}
          <div>
            <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          </div>
          <p className="sub">{mode === "login" ? "Sign in to continue to your workspace." : "It only takes a moment."}</p>
          {mode === "register" && (
            <label>
              Full name
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Jane Doe" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={mode === "login"} placeholder="you@company.com" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 8 : undefined}
              placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
            />
          </label>
          {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
          <button className="btn primary lg block" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            {!busy && <ArrowRight size={16} />}
          </button>
          <div className="auth-switch">
            {mode === "login" ? "New to Brill Tables? " : "Already have an account? "}
            <button type="button" className="link" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
