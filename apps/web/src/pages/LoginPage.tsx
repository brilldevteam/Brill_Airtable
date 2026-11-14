import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { MailCheck, Users } from "lucide-react";
import { api } from "../api";
import { LogoMark } from "../components/AppBar";

const PREVIEW = [
  ["Order", "Customer", "Status"],
  ["Wedding banner", "Acme Weddings", "In progress"],
  ["Business cards ×500", "Bolt Printing", "Done"],
  ["Shop signage", "Northwind Café", "Todo"],
];

/** The two-column sign-in layout (brand panel + form), shared by the account pages. */
export function AuthLayout({ children }: { children: ReactNode }) {
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
      <div className="auth-form-wrap">{children}</div>
    </div>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [sent, setSent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteToken = /^\/invite\/([\w-]+)/.exec(window.location.pathname)?.[1];
  const [invite, setInvite] = useState<{ email: string; workspace: string; base: string | null; invitedBy: string | null } | null>(null);
  useEffect(() => {
    if (!inviteToken) return;
    api.inviteInfo(inviteToken).then((i) => { setInvite(i); setEmail(i.email); setMode("register"); }, () => undefined);
  }, [inviteToken]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "forgot") {
        await api.forgotPassword(email);
        setSent(true);
        return;
      }
      if (mode === "login") await api.login(email, password);
      else await api.register(name, email, password);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m: typeof mode) => { setMode(m); setError(null); setSent(false); };

  if (mode === "forgot") {
    return (
      <AuthLayout>
        <form className="auth-card" onSubmit={submit}>
          <span className="logo auth-mobile-logo"><LogoMark /> Brill Tables</span>
          <h1>Reset your password</h1>
          {sent ? (
            <div className="auth-note">
              <MailCheck size={18} />
              <span>If an account exists for <b>{email}</b>, we've sent a link to reset its password. It expires in 1 hour — check your spam folder too.</span>
            </div>
          ) : (
            <>
              <p className="sub">Enter your account's email and we'll send you a link to choose a new password.</p>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@company.com" />
              </label>
              {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
              <button className="btn primary lg block" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
            </>
          )}
          <div className="auth-switch">
            <button type="button" className="link" onClick={() => switchTo("login")}>← Back to sign in</button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
        <form className="auth-card" onSubmit={submit}>
          <span className="logo auth-mobile-logo"><LogoMark /> Brill Tables</span>
          {invite && (
            <div className="invite-banner">
              <Users size={16} />
              <span><b>{invite.invitedBy ?? "Someone"}</b> invited you to <b>{invite.base ?? invite.workspace}</b>. {mode === "register" ? "Create an account" : "Sign in"} with {invite.email} to join.</span>
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
            <span className="label-row">
              Password
              {mode === "login" && <button type="button" className="link" onClick={() => switchTo("forgot")}>Forgot password?</button>}
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 10 : undefined}
              placeholder={mode === "register" ? "At least 10 characters" : "••••••••"}
            />
          </label>
          {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
          <button className="btn primary lg block" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            {!busy && <ArrowRight size={16} />}
          </button>
          <div className="auth-switch">
            {mode === "login" ? "New to Brill Tables? " : "Already have an account? "}
            <button type="button" className="link" onClick={() => switchTo(mode === "login" ? "register" : "login")}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </div>
        </form>
    </AuthLayout>
  );
}
