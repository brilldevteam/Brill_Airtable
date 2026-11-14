import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Inbox, KeyRound, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { LogoMark } from "../components/AppBar";
import { AuthLayout } from "./LoginPage";

/** /verify-email/:token — confirms the address from the emailed link (signed in or not). */
export function VerifyEmailPage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // the link works once — don't spend it twice in StrictMode
    started.current = true;
    api.verifyEmail(token!).then(
      (r) => { setState({ ok: true, text: `${r.email} is confirmed. You're all set.` }); void qc.invalidateQueries({ queryKey: ["me"] }); },
      (e) => setState({ ok: false, text: (e as Error).message }),
    );
  }, [token, qc]);

  return (
    <AuthLayout>
      <div className="auth-card">
        <span className="logo auth-mobile-logo"><LogoMark /> Brill Tables</span>
        {!state ? <div className="spinner" /> : (
          <>
            <div className={"auth-status " + (state.ok ? "ok" : "bad")}>{state.ok ? <CheckCircle2 size={26} /> : <XCircle size={26} />}</div>
            <h1>{state.ok ? "Email confirmed" : "Link not valid"}</h1>
            <p className="sub">{state.text}{!state.ok && " Sign in and use “Resend email” on the home page to get a new link."}</p>
            <Link className="btn primary lg block" to="/">Continue to Brill Tables <ArrowRight size={16} /></Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

/** /reset-password/:token — choose a new password from the emailed link. */
export function ResetPasswordPage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token!, password);
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form className="auth-card" onSubmit={submit}>
        <span className="logo auth-mobile-logo"><LogoMark /> Brill Tables</span>
        <div className="auth-status"><KeyRound size={24} /></div>
        <h1>Choose a new password</h1>
        <p className="sub">You'll be signed out everywhere else and signed in here.</p>
        <label>
          New password
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus placeholder="At least 10 characters" />
        </label>
        <label>
          Repeat it
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={10} />
        </label>
        {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
        <div className="auth-switch"><Link className="link" to="/">← Back to sign in</Link></div>
      </form>
    </AuthLayout>
  );
}

/** /dev/mail — the development outbox: every email the API would have sent (dev only). */
export function DevMailPage() {
  const q = useQuery({ queryKey: ["devMail"], queryFn: api.devMail, refetchInterval: 3000 });
  const [openId, setOpenId] = useState<number | null>(null);
  const emails = q.data?.emails ?? [];
  const open = emails.find((m) => m.id === openId) ?? emails[0];

  return (
    <div className="devmail">
      <header className="devmail-head">
        <LogoMark size={26} />
        <div>
          <strong>Dev mailbox</strong>
          <span>Emails the API sent while running locally. In production they go out through the mail provider instead.</span>
        </div>
        <div className="spacer" />
        <Link className="btn" to="/">Back to the app</Link>
      </header>
      {q.isError ? (
        <div className="center error">The dev mailbox is only available on a local API (not in production).</div>
      ) : emails.length === 0 ? (
        <div className="center muted"><Inbox size={22} /> No emails yet. Sign up, reset a password or invite someone.</div>
      ) : (
        <div className="devmail-body">
          <ul className="devmail-list">
            {emails.map((m) => (
              <li key={m.id}>
                <button className={m.id === open?.id ? "on" : ""} onClick={() => setOpenId(m.id)}>
                  <b>{m.subject}</b>
                  <span>To {m.to} · {new Date(m.sentAt).toLocaleTimeString()}</span>
                </button>
              </li>
            ))}
          </ul>
          {open && <iframe className="devmail-view" title={open.subject} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={open.html.replace("<head>", "<head><base target=\"_blank\">")} />}
        </div>
      )}
    </div>
  );
}

/** Home-page banner until the user confirms their email address. */
export function VerifyBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const resend = async () => {
    setState("sending");
    try { await api.resendVerification(); setState("sent"); } catch (e) { setState((e as Error).message); }
  };
  return (
    <div className="verify-banner" role="status">
      <Inbox size={17} />
      <span>
        Confirm your email — we sent a link to <b>{email}</b>. You need it to join teams that invite you.
        {state !== "idle" && state !== "sending" && state !== "sent" && <span className="error"> {state}</span>}
      </span>
      <button className="btn sm" onClick={resend} disabled={state === "sending" || state === "sent"}>
        {state === "sent" ? "Sent ✓" : state === "sending" ? "Sending…" : "Resend email"}
      </button>
    </div>
  );
}
