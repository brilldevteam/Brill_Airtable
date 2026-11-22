import type { Base, User } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink, FolderInput, Trash2, Upload, X as XIcon,
  ArrowRightLeft, Building2, ChevronDown, ChevronRight, Database, Home as HomeIcon, LayoutGrid, List, MoreHorizontal, Palette, Pencil, Plus, Search, Share2, Star,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type SharedBase, type Workspace } from "../api";
import { AppBar } from "../components/AppBar";
import { BASE_ICONS, BaseIcon } from "../components/BaseIcon";
import { useDialogs } from "../components/Dialogs";
import { ImportAirtableDialog } from "../components/ImportAirtableDialog";
import { Popover, anchorOf, type Anchor } from "../components/Popover";
import { BASE_COLORS } from "../colors";
import { VerifyBanner } from "./AccountPages";

type Section = { kind: "home" } | { kind: "starred" } | { kind: "shared" } | { kind: "workspace"; id: string };
type Item = Base & { role?: string; shared?: boolean; workspaceName?: string };

function ago(iso: string | null | undefined): string {
  if (!iso) return "Not opened yet";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Opened just now";
  if (mins < 60) return `Opened ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Opened ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `Opened ${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `Opened ${months} month${months === 1 ? "" : "s"} ago` : "Opened over a year ago";
}
/** "Today", "Past 7 days", "Past 30 days" or "Earlier", by when the person last opened the base. */
function period(iso: string | null | undefined): string {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d >= today) return "Today";
  const days = (today.getTime() - d.getTime()) / 86400000;
  return days < 7 ? "Past 7 days" : days < 30 ? "Past 30 days" : "Earlier";
}
const PERIODS = ["Today", "Past 7 days", "Past 30 days", "Earlier"];
const canCreate = (role?: string) => role === "owner" || role === "creator";

export function HomePage({ user }: { user: User }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const dialogs = useDialogs();
  const ws = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>({ kind: "home" });
  const [layout, setLayout] = useState<"grid" | "list">(() => { try { return localStorage.getItem("brill.homeLayout") === "list" ? "list" : "grid"; } catch { return "grid"; } });
  const [starredOpen, setStarredOpen] = useState(true);
  const [wsOpen, setWsOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [createMenu, setCreateMenu] = useState<Anchor | null>(null);
  const [cardMenu, setCardMenu] = useState<{ base: Item; anchor: Anchor } | null>(null);
  const [styling, setStyling] = useState<Item | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
  const [finder, setFinder] = useState(false);

  useEffect(() => { try { localStorage.setItem("brill.homeLayout", layout); } catch { /* private mode */ } }, [layout]);
  // Ctrl+K (⌘K) opens quick search.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setFinder(true); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const workspaces: Workspace[] = ws.data?.workspaces ?? [];
  const all: Item[] = useMemo(() => {
    if (!ws.data) return [];
    const role = new Map(ws.data.workspaces.map((w) => [w.id, w.role]));
    const wsName = new Map(ws.data.workspaces.map((w) => [w.id, w.name]));
    return [
      ...ws.data.bases.map((b) => ({ ...b, role: role.get(b.workspaceId), workspaceName: wsName.get(b.workspaceId) })),
      ...ws.data.sharedBases.map((b: SharedBase) => ({ ...b, shared: true })),
    ];
  }, [ws.data]);
  const starred = all.filter((b) => b.starred);
  const firstWritable = workspaces.find((w) => canCreate(w.role));

  const shown = section.kind === "home" ? all
    : section.kind === "starred" ? starred
    : section.kind === "shared" ? all.filter((b) => b.shared)
    : all.filter((b) => !b.shared && b.workspaceId === section.id);
  const title = section.kind === "home" ? "Home" : section.kind === "starred" ? "Starred" : section.kind === "shared" ? "Shared with me"
    : workspaces.find((w) => w.id === section.id)?.name ?? "Workspace";
  const targetWs = section.kind === "workspace" ? workspaces.find((w) => w.id === section.id && canCreate(w.role)) : firstWritable;

  const groups = useMemo(() => {
    const sorted = [...shown].sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") || a.name.localeCompare(b.name));
    if (section.kind !== "home") return [{ label: "", items: sorted }];
    return PERIODS.map((p) => ({ label: p, items: sorted.filter((b) => period(b.lastOpenedAt) === p) })).filter((g) => g.items.length);
  }, [shown, section.kind]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["workspaces"] });
  async function createBase(wsId: string) {
    const name = await dialogs.prompt({
      title: "Create a base",
      message: "A base holds related tables — for example Posts, Clients and Invoices.",
      label: "Base name",
      defaultValue: "Untitled Base",
      confirmText: "Create base",
    });
    if (!name) return;
    try {
      const keys = Object.keys(BASE_COLORS).filter((k) => k !== "gray");
      const color = keys[Math.floor(Math.random() * keys.length)];
      const { base, firstTableId } = await api.createBase(wsId, name, color);
      await refresh();
      nav(`/base/${base.id}/${firstTableId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const toggleStar = async (b: Item) => {
    qc.setQueryData<typeof ws.data>(["workspaces"], (d) => d && {
      ...d,
      bases: d.bases.map((x) => (x.id === b.id ? { ...x, starred: !b.starred } : x)),
      sharedBases: d.sharedBases.map((x) => (x.id === b.id ? { ...x, starred: !b.starred } : x)),
    });
    try { await api.starBase(b.id, !b.starred); } catch (e) { setError((e as Error).message); }
    void refresh();
  };
  const remove = async (b: Item) => {
    const ok = await dialogs.confirm({
      title: `Delete “${b.name}”?`,
      message: "All its tables, records, files and views will be permanently deleted. This can't be undone.",
      confirmText: "Delete base",
      danger: true,
    });
    if (ok) try { await api.deleteBase(b.id); await refresh(); } catch (e) { setError((e as Error).message); }
  };
  const rename = async (b: Item) => {
    const name = await dialogs.prompt({ title: "Rename base", label: "Base name", defaultValue: b.name });
    if (name) try { await api.updateBase(b.id, { name }); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const firstName = user.name.split(" ")[0];
  const navBtn = (s: Section, label: string, icon: JSX.Element, extra?: JSX.Element) => {
    const on = JSON.stringify(s) === JSON.stringify(section);
    return <button className={"hs-item" + (on ? " on" : "")} onClick={() => setSection(s)}>{icon}<span>{label}</span>{extra}</button>;
  };

  return (
    <div className="home">
      <AppBar>
        <button className="home-search" onClick={() => setFinder(true)}>
          <Search size={15} /> <span>Search bases…</span> <kbd>Ctrl K</kbd>
        </button>
        <div className="spacer" />
      </AppBar>
      <div className="home-body">
        <aside className="home-side">
          {navBtn({ kind: "home" }, "Home", <HomeIcon size={17} />)}
          <button className="hs-item" onClick={() => setStarredOpen((o) => !o)}>
            <Star size={17} /><span>Starred</span>{starredOpen ? <ChevronDown size={14} className="hs-chev" /> : <ChevronRight size={14} className="hs-chev" />}
          </button>
          {starredOpen && (
            <div className="hs-sub">
              {starred.length === 0 && <div className="hs-hint">Star a base to keep it here.</div>}
              {starred.map((b) => (
                <Link key={b.id} to={`/base/${b.id}`} className="hs-base"><BaseIcon name={b.name} color={b.color} icon={b.icon} logo={b.logo} baseId={b.id} size={22} /> <span>{b.name}</span></Link>
              ))}
            </div>
          )}
          {all.some((b) => b.shared) && navBtn({ kind: "shared" }, "Shared with me", <Share2 size={17} />)}
          <button className="hs-item" onClick={() => setWsOpen((o) => !o)}>
            <Building2 size={17} /><span>Workspaces</span>{wsOpen ? <ChevronDown size={14} className="hs-chev" /> : <ChevronRight size={14} className="hs-chev" />}
          </button>
          {wsOpen && (
            <div className="hs-sub">
              {workspaces.map((w) => (
                <button key={w.id} className={"hs-ws" + (section.kind === "workspace" && section.id === w.id ? " on" : "")} onClick={() => setSection({ kind: "workspace", id: w.id })}>
                  <span className="hs-ws-dot">{w.name.slice(0, 1).toUpperCase()}</span><span>{w.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="spacer" />
          {firstWritable && (
            <button className="hs-item" onClick={() => setImporting(true)}><ArrowRightLeft size={17} /><span>Import from Airtable</span></button>
          )}
          {firstWritable && (
            <button className="btn primary block hs-create" onClick={(e) => setCreateMenu(anchorOf(e.currentTarget))}><Plus size={16} /> Create</button>
          )}
        </aside>

        <main className="home-main">
          {user.emailVerified === false && <VerifyBanner email={user.email} />}
          <div className="home-hero">
            <div>
              <h1>{section.kind === "home" ? `Welcome back, ${firstName}` : title}</h1>
              {section.kind === "home" && <p>Your bases, most recently opened first.</p>}
            </div>
            <div className="home-tools">
              <div className="seg" role="group" aria-label="Layout">
                <button className={layout === "list" ? "on" : ""} title="List" onClick={() => setLayout("list")}><List size={16} /></button>
                <button className={layout === "grid" ? "on" : ""} title="Grid" onClick={() => setLayout("grid")}><LayoutGrid size={16} /></button>
              </div>
            </div>
          </div>

          {error && <div className="error banner" style={{ margin: "0 0 16px" }}>{error}</div>}
          {ws.isLoading && <div className="center"><div className="spinner" /></div>}

          {ws.data && shown.length === 0 && (
            <div className="empty">
              <div className="empty-icon">{section.kind === "starred" ? <Star size={22} /> : <Database size={22} />}</div>
              <h3>{section.kind === "starred" ? "Nothing starred yet" : "No bases here yet"}</h3>
              <p>{section.kind === "starred" ? "Use the star on a base to pin it here and in the sidebar." : "Create a base from scratch, or bring your bases over from Airtable."}</p>
              {section.kind !== "starred" && targetWs && (
                <div className="dash-empty-actions">
                  <button className="btn primary" onClick={() => createBase(targetWs.id)}><Plus size={16} /> Create base</button>
                  <button className="btn" onClick={() => setImporting(true)}><ArrowRightLeft size={15} /> Import from Airtable</button>
                </div>
              )}
            </div>
          )}

          {groups.map((g) => (
            <section key={g.label || "all"} className="home-group">
              {g.label && <h2 className="home-group-title">{g.label}</h2>}
              <div className={layout === "grid" ? "home-grid" : "home-list"}>
                {g.items.map((b) => (
                  <div key={b.id} className="home-card" onContextMenu={(e) => { e.preventDefault(); setCardMenu({ base: b, anchor: { x: e.clientX, y: e.clientY, width: 0, height: 0 } }); }}>
                    <Link to={`/base/${b.id}`} className="home-card-link">
                      <BaseIcon name={b.name} color={b.color} icon={b.icon} logo={b.logo} baseId={b.id} size={layout === "grid" ? 48 : 32} />
                      <span className="home-card-text">
                        <b>{b.name}</b>
                        <small>{b.shared ? `Shared from ${b.workspaceName}` : ago(b.lastOpenedAt)}</small>
                      </span>
                    </Link>
                    {layout === "list" && <span className="home-card-ws muted small">{b.workspaceName}</span>}
                    <button className={"home-star" + (b.starred ? " on" : "")} title={b.starred ? "Unstar" : "Star"} onClick={() => toggleStar(b)}>
                      <Star size={15} fill={b.starred ? "currentColor" : "none"} />
                    </button>
                    {canCreate(b.role) && (
                      <button className="home-more" title="Base options" onClick={(e) => setCardMenu({ base: b, anchor: anchorOf(e.currentTarget) })}><MoreHorizontal size={16} /></button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>

      {createMenu && (
        <Popover anchor={createMenu} onClose={() => setCreateMenu(null)} minWidth={250}>
          <div className="menu">
            <div className="menu-label">Create</div>
            {targetWs && <button onClick={() => { setCreateMenu(null); void createBase(targetWs.id); }}><Plus size={15} /> New base from scratch</button>}
            <button onClick={() => { setCreateMenu(null); setImporting(true); }}><ArrowRightLeft size={15} /> Import bases from Airtable</button>
          </div>
        </Popover>
      )}
      {cardMenu && (
        <Popover anchor={cardMenu.anchor} onClose={() => setCardMenu(null)} minWidth={210}>
          <div className="menu">
            <button onClick={() => { const b = cardMenu.base; setCardMenu(null); nav(`/base/${b.id}`); }}><ExternalLink size={15} /> Open</button>
            <button onClick={() => { const b = cardMenu.base; setCardMenu(null); void toggleStar(b); }}><Star size={15} /> {cardMenu.base.starred ? "Remove from starred" : "Add to starred"}</button>
            {canCreate(cardMenu.base.role) && <button onClick={() => { const b = cardMenu.base; setCardMenu(null); void rename(b); }}><Pencil size={15} /> Rename</button>}
            {canCreate(cardMenu.base.role) && <button onClick={() => { const b = cardMenu.base; setCardMenu(null); setStyling(b); }}><Palette size={15} /> Customise appearance</button>}
            {cardMenu.base.role === "owner" && workspaces.filter((w) => canCreate(w.role)).length > 1 && (
              <button onClick={() => { const b = cardMenu.base; setCardMenu(null); setMoving(b); }}><FolderInput size={15} /> Move to workspace…</button>
            )}
            {cardMenu.base.role === "owner" && (
              <><hr /><button className="danger" onClick={() => { const b = cardMenu.base; setCardMenu(null); void remove(b); }}><Trash2 size={15} /> Delete base</button></>
            )}
          </div>
        </Popover>
      )}
      {styling && <IconDialog base={styling} onClose={() => setStyling(null)} onSaved={refresh} />}
      {moving && (
        <MoveDialog base={moving} workspaces={workspaces.filter((w) => canCreate(w.role) && w.id !== moving.workspaceId)} onClose={() => setMoving(null)}
          onMove={async (wsId) => { try { await api.moveBase(moving.id, wsId); setMoving(null); await refresh(); } catch (e) { setError((e as Error).message); } }} />
      )}
      {importing && <ImportAirtableDialog workspaces={workspaces} onClose={() => setImporting(false)} />}
      {finder && <QuickFind bases={all} onClose={() => setFinder(false)} onPick={(b) => { setFinder(false); nav(`/base/${b.id}`); }} />}
    </div>
  );
}

/** Pick a base's icon and colour. */
function IconDialog({ base, onClose, onSaved }: { base: Item; onClose: () => void; onSaved: () => void }) {
  const [icon, setIcon] = useState<string | null>(base.icon ?? null);
  const [color, setColor] = useState(base.color);
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<string | null>(base.logo ?? null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setLogoError(null);
    setBusy(true);
    try { const r = await api.uploadBaseLogo(base.id, file); setLogo(r.logo); onSaved(); } catch (e) { setLogoError((e as Error).message); } finally { setBusy(false); }
  };
  const dropLogo = async () => {
    setBusy(true);
    try { await api.removeBaseLogo(base.id); setLogo(null); onSaved(); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await api.updateBase(base.id, { icon, color }); onSaved(); onClose(); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal icon-modal">
        <div className="modal-head">
          <BaseIcon name={base.name} color={color} icon={icon} logo={logo} baseId={base.id} size={44} />
          <div><h3>Customise appearance</h3><p className="modal-sub">{base.name}</p></div>
        </div>
        <div className="logo-row">
          <label className="btn">
            <Upload size={15} /> {logo ? "Replace logo" : "Upload a logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          {logo && <button className="btn" onClick={dropLogo} disabled={busy}><XIcon size={15} /> Remove logo</button>}
          <span className="field-hint">{logo ? "The logo is shown instead of the icon." : "A client's logo — PNG, JPG, WebP or SVG, up to 5 MB."}</span>
        </div>
        {logoError && <div className="error">{logoError}</div>}
        {!logo && <div className="field-label" style={{ margin: 0 }}>Or an icon and colour</div>}
        <div className="icon-colors">
          {Object.keys(BASE_COLORS).map((c) => (
            <button key={c} className={"icon-color" + (c === color ? " on" : "")} style={{ background: BASE_COLORS[c] }} title={c} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className="icon-grid">
          <button className={"icon-pick letters" + (!icon ? " on" : "")} onClick={() => setIcon(null)} title="Letters">{base.name.slice(0, 2)}</button>
          {Object.entries(BASE_ICONS).map(([k, I]) => (
            <button key={k} className={"icon-pick" + (icon === k ? " on" : "")} title={k.replace(/-/g, " ")} onClick={() => setIcon(k)}><I size={18} /></button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Ctrl+K: jump to any base by typing part of its name. */
function QuickFind({ bases, onPick, onClose }: { bases: Item[]; onPick: (b: Item) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const hits = bases
    .filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
    .slice(0, 12);
  useEffect(() => setI(0), [q]);
  return (
    <div className="modal-backdrop finder-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-label="Find a base">
        <div className="finder-input input-icon">
          <Search size={16} />
          <input
            autoFocus placeholder="Find a base…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(hits.length - 1, x + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              if (e.key === "Enter" && hits[i]) onPick(hits[i]);
            }}
          />
        </div>
        <div className="finder-list">
          {hits.map((b, k) => (
            <button key={b.id} className={k === i ? "on" : ""} onMouseEnter={() => setI(k)} onClick={() => onPick(b)}>
              <BaseIcon name={b.name} color={b.color} icon={b.icon} logo={b.logo} baseId={b.id} size={26} />
              <span>{b.name}</span>
              <small>{b.workspaceName}</small>
            </button>
          ))}
          {hits.length === 0 && <div className="panel-empty" style={{ padding: 14 }}>No bases match “{q}”.</div>}
        </div>
      </div>
    </div>
  );
}

/** Move a base into another workspace. */
function MoveDialog({ base, workspaces, onMove, onClose }: { base: Item; workspaces: Workspace[]; onMove: (wsId: string) => void; onClose: () => void }) {
  const [wsId, setWsId] = useState(workspaces[0]?.id ?? "");
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Move “{base.name}”</h3>
        <label>To workspace
          <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <p className="field-hint">People in the new workspace get access; people who only had access through the old one lose it.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!wsId} onClick={() => onMove(wsId)}>Move base</button>
        </div>
      </div>
    </div>
  );
}
