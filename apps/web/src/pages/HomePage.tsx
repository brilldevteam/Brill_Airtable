import type { User } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Database, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { AppBar } from "../components/AppBar";
import { useDialogs } from "../components/Dialogs";
import { BASE_COLORS } from "../colors";
import { VerifyBanner } from "./AccountPages";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function HomePage({ user }: { user: User }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const dialogs = useDialogs();
  const ws = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [error, setError] = useState<string | null>(null);

  async function createBase(wsId: string) {
    const name = await dialogs.prompt({
      title: "Create a base",
      message: "A base holds related tables — for example Orders, Customers and Products.",
      label: "Base name",
      defaultValue: "Untitled Base",
      confirmText: "Create base",
    });
    if (!name) return;
    try {
      const keys = Object.keys(BASE_COLORS).filter((k) => k !== "gray");
      const color = keys[Math.floor(Math.random() * keys.length)];
      const { base, firstTableId } = await api.createBase(wsId, name, color);
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      nav(`/base/${base.id}/${firstTableId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const firstName = user.name.split(" ")[0];
  const canCreate = (role: string) => role === "owner" || role === "creator";

  return (
    <div className="home">
      <AppBar />
      <main className="home-main">
        {user.emailVerified === false && <VerifyBanner email={user.email} />}
        <div className="home-hero">
          <div>
            <h1>{greeting()}, {firstName}</h1>
            <p>Pick up where you left off, or start something new.</p>
          </div>
          {ws.data?.workspaces[0] && canCreate(ws.data.workspaces[0].role) && (
            <button className="btn primary" onClick={() => createBase(ws.data!.workspaces[0].id)}>
              <Plus size={16} /> Create base
            </button>
          )}
        </div>

        {error && <div className="error banner" style={{ margin: "0 0 16px" }}>{error}</div>}
        {ws.isLoading && <div className="center"><div className="spinner" /></div>}

        {ws.data?.workspaces.map((w) => {
          const bases = ws.data.bases.filter((b) => b.workspaceId === w.id);
          return (
            <section key={w.id} className="ws-section">
              <div className="ws-head">
                <h2>{w.name}</h2>
                <span className="count">{bases.length} {bases.length === 1 ? "base" : "bases"}</span>
              </div>
              {bases.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon"><Database size={22} /></div>
                  <h3>No bases yet</h3>
                  <p>Create your first base to start organising your work.</p>
                  {canCreate(w.role) && (
                    <button className="btn primary" onClick={() => createBase(w.id)}><Plus size={16} /> Create base</button>
                  )}
                </div>
              ) : (
                <div className="base-grid">
                  {bases.map((b) => {
                    const color = BASE_COLORS[b.color] ?? BASE_COLORS.blue;
                    return (
                      <Link key={b.id} to={`/base/${b.id}`} className="base-card">
                        <div className="base-icon" style={{ background: color }}>{b.name.slice(0, 2)}</div>
                        <ArrowUpRight size={16} className="open-hint" />
                        <div>
                          <div className="base-name">{b.name}</div>
                          <div className="base-meta"><Database size={13} /> Base</div>
                        </div>
                      </Link>
                    );
                  })}
                  {canCreate(w.role) && (
                    <button className="base-card new" onClick={() => createBase(w.id)}>
                      <Plus size={20} /> New base
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}
