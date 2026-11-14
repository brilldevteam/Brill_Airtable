import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AppBar } from "../components/AppBar";
import { ROLE_INFO } from "../components/ShareDialog";
import { VerifyBanner } from "./AccountPages";

/** Accept a workspace invite (the user is signed in by now). */
export function InvitePage() {
  const { token } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token!), retry: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = qc.getQueryData<{ user: { email: string; emailVerified?: boolean } | null }>(["me"])?.user;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.acceptInvite(token!);
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      nav(r.baseId ? `/base/${r.baseId}` : "/", { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <AppBar />
      <main className="home-main" style={{ maxWidth: 520 }}>
        <div className="invite-card">
          <div className="empty-icon"><Users size={22} /></div>
          {info.isLoading && <div className="spinner" />}
          {info.isError && (
            <>
              <h2>Invite not available</h2>
              <p className="muted">{(info.error as Error).message}</p>
              <button className="btn" onClick={() => nav("/")}>Go to my bases</button>
            </>
          )}
          {info.data && (
            <>
              <h2>{info.data.base ? <>Open “{info.data.base}”</> : <>Join {info.data.workspace}</>}</h2>
              <p className="muted">
                {info.data.invitedBy ?? "Someone"} invited <b>{info.data.email}</b>{info.data.base ? <> to the <b>{info.data.base}</b> base</> : null} as <b>{ROLE_INFO[info.data.role].label}</b>
                {" — "}{ROLE_INFO[info.data.role].hint.toLowerCase()}.
              </p>
              {me && me.email.toLowerCase() !== info.data.email && (
                <div className="hint">You're signed in as {me.email}. Sign out and sign in as {info.data.email} to accept.</div>
              )}
              {me && me.email.toLowerCase() === info.data.email && me.emailVerified === false && (
                <VerifyBanner email={me.email} />
              )}
              {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
              <button className="btn primary lg" onClick={accept} disabled={busy}>
                <CheckCircle2 size={16} /> {busy ? "Joining…" : "Accept invite"}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
