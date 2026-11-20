import type { Table } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, LayoutDashboard, Pencil, Plus, Sheet, Trash2, Users, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { BASE_COLORS } from "../colors";
import { AppBar } from "../components/AppBar";
import { useDialogs } from "../components/Dialogs";
import { Popover, anchorOf, type Anchor } from "../components/Popover";
import { ShareDialog } from "../components/ShareDialog";
import { AutomationsPanel } from "../components/AutomationsPanel";
import { DashboardView, useDashboards } from "../components/DashboardView";
import type { Dashboard } from "@brill/shared";
import { TableWorkspace } from "../components/TableWorkspace";
import { useBaseEvents } from "../useBaseEvents";

const RECORD_ACCESS_LABEL = { all: "Everyone who can edit", team: "Workspace team only", creators: "Creators and owners only" } as const;

export function BasePage() {
  const { baseId, tableId, dashId } = useParams();
  const dashMode = useLocation().pathname.startsWith(`/base/${baseId}/dash`);
  const dashQ = useDashboards(baseId!);
  const dashboards = dashQ.data?.dashboards ?? [];
  const [dashMenu, setDashMenu] = useState<{ dash: Dashboard; anchor: Anchor } | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ["base", baseId], queryFn: () => api.base(baseId!) });
  const [error, setError] = useState<string | null>(null);
  const [baseMenu, setBaseMenu] = useState<Anchor | null>(null);
  const [tableMenu, setTableMenu] = useState<{ table: Table; anchor: Anchor } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [automating, setAutomating] = useState(false);
  const live = useBaseEvents(baseId);

  const tables = q.data?.tables ?? [];
  useEffect(() => {
    if (dashMode) return;
    // Opening a base (no table in the address) shows its first dashboard when it has one.
    if (!tableId) {
      if (dashQ.isLoading) return;
      if (dashboards[0]) return nav(`/base/${baseId}/dash/${dashboards[0].id}`, { replace: true });
    }
    if (q.data && (!tableId || !tables.some((t) => t.id === tableId)) && tables[0]) {
      nav(`/base/${baseId}/${tables[0].id}`, { replace: true });
    }
  }, [q.data, tableId, dashMode, dashQ.isLoading, dashboards.length]);
  // "Data" goes back to the table you last had open in this base (remembered in this browser).
  const lastKey = `brill.lastTable.${baseId}`;
  useEffect(() => {
    if (tableId) try { localStorage.setItem(lastKey, tableId); } catch { /* private mode */ }
  }, [tableId, lastKey]);
  const remembered = (() => { try { return localStorage.getItem(lastKey); } catch { return null; } })();
  const dataTableId = tables.find((t) => t.id === remembered)?.id ?? tables[0]?.id;
  // On the dashboards side, open the first dashboard if none is chosen.
  useEffect(() => {
    if (dashMode && !dashId && dashboards[0]) nav(`/base/${baseId}/dash/${dashboards[0].id}`, { replace: true });
  }, [dashMode, dashId, dashboards.length]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["base", baseId] });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (q.isLoading) return <div className="center"><div className="spinner" /></div>;
  if (q.isError) return <div className="center error">{(q.error as Error).message} — <Link to="/">back home</Link></div>;
  const base = q.data!.base;
  const role = q.data!.role;
  const guest = q.data!.guest;
  const canDesign = role === "owner" || role === "creator";
  const color = BASE_COLORS[base.color] ?? BASE_COLORS.blue;

  const renameBase = async () => {
    const name = await dialogs.prompt({ title: "Rename base", label: "Base name", defaultValue: base.name });
    if (name) run(async () => { await api.updateBase(base.id, { name }); await refresh(); await qc.invalidateQueries({ queryKey: ["workspaces"] }); });
  };
  const deleteBase = async () => {
    const ok = await dialogs.confirm({
      title: `Delete “${base.name}”?`,
      message: "All tables, records and views in this base will be permanently deleted. This can't be undone.",
      confirmText: "Delete base",
      danger: true,
    });
    if (ok) run(async () => { await api.deleteBase(base.id); await qc.invalidateQueries({ queryKey: ["workspaces"] }); nav("/"); });
  };
  const renameTable = async (t: Table) => {
    const name = await dialogs.prompt({ title: "Rename table", label: "Table name", defaultValue: t.name });
    if (name) run(async () => { await api.renameTable(t.id, name); await refresh(); });
  };
  const deleteTable = async (t: Table) => {
    const ok = await dialogs.confirm({
      title: `Delete “${t.name}”?`,
      message: "The table and all of its records will be permanently deleted. This can't be undone.",
      confirmText: "Delete table",
      danger: true,
    });
    if (ok) run(async () => { await api.deleteTable(t.id); await refresh(); });
  };
  const addDashboard = async () => {
    const name = await dialogs.prompt({ title: "New dashboard", label: "Dashboard name", defaultValue: `Dashboard ${dashboards.length + 1}`, confirmText: "Create dashboard" });
    if (name) run(async () => {
      const { dashboard } = await api.createDashboard(baseId!, name);
      await qc.invalidateQueries({ queryKey: ["dashboards", baseId] });
      nav(`/base/${baseId}/dash/${dashboard.id}`);
    });
  };
  const addTable = async () => {
    const name = await dialogs.prompt({ title: "Add a table", label: "Table name", defaultValue: `Table ${tables.length + 1}`, confirmText: "Create table" });
    if (name) run(async () => { const { table } = await api.createTable(base.id, name); await refresh(); nav(`/base/${baseId}/${table.id}`); });
  };

  return (
    <div className="base-page">
      <AppBar>
        <div className="divider" />
        <Link to="/" className="muted hide-sm" style={{ textDecoration: "none", fontSize: 13.5 }}>Bases</Link>
        <ChevronRight size={14} className="muted hide-sm" />
        <button className="base-switch" onClick={(e) => canDesign && setBaseMenu(anchorOf(e.currentTarget))}>
          <span className="base-dot" style={{ background: color }}>{base.name.slice(0, 2)}</span>
          <span className="name">{base.name}</span>
          {canDesign && <ChevronDown size={15} />}
        </button>
        <div className="spacer" />
        <span className={"live-dot" + (live ? " on" : "")} title={live ? "Live — changes from your team appear automatically" : "Reconnecting…"}>
          <span /> {live ? "Live" : "Offline"}
        </span>
        {canDesign && !guest && (
          <button className="btn sm" onClick={() => setAutomating(true)} title="Automations"><Zap size={14} /> <span className="hide-sm">Automations</span></button>
        )}
        <button className="btn sm" onClick={() => setSharing(true)}><Users size={14} /> Share</button>
      </AppBar>
      {sharing && <ShareDialog baseId={base.id} onClose={() => setSharing(false)} />}
      {automating && <AutomationsPanel baseId={base.id} tables={tables} onClose={() => setAutomating(false)} />}

      <nav className="table-tabs">
        <div className="mode-switch" role="tablist" aria-label="Dashboards or data">
          <Link role="tab" aria-selected={dashMode} className={dashMode ? "on" : ""} to={`/base/${baseId}/dash`}><LayoutDashboard size={14} /> Dashboards</Link>
          <Link role="tab" aria-selected={!dashMode} className={!dashMode ? "on" : ""} to={`/base/${baseId}/${dataTableId ?? ""}`}><Sheet size={14} /> Data</Link>
        </div>
        {dashMode && dashboards.map((d) => (
          <Link
            key={d.id}
            to={`/base/${baseId}/dash/${d.id}`}
            className={"tab" + (d.id === dashId ? " active" : "")}
            onContextMenu={(e) => { if (!canDesign) return; e.preventDefault(); setDashMenu({ dash: d, anchor: anchorOf(e.currentTarget) }); }}
          >
            <LayoutDashboard size={15} />
            {d.name}
            {d.id === dashId && canDesign && (
              <span className="tab-menu" role="button" title="Dashboard options"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDashMenu({ dash: d, anchor: anchorOf(e.currentTarget.parentElement!) }); }}>
                <ChevronDown size={14} />
              </span>
            )}
          </Link>
        ))}
        {dashMode && canDesign && (
          <button className="tab add" onClick={addDashboard}><Plus size={15} /> New dashboard</button>
        )}
        {!dashMode && tables.map((t) => {
          const active = t.id === tableId;
          return (
            <Link
              key={t.id}
              to={`/base/${baseId}/${t.id}`}
              className={"tab" + (active ? " active" : "")}
              onDoubleClick={(e) => { e.preventDefault(); if (canDesign) renameTable(t); }}
              onContextMenu={(e) => { if (!canDesign) return; e.preventDefault(); setTableMenu({ table: t, anchor: anchorOf(e.currentTarget) }); }}
            >
              <Sheet size={15} />
              {t.name}
              {active && canDesign && (
                <span
                  className="tab-menu"
                  role="button"
                  title="Table options"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTableMenu({ table: t, anchor: anchorOf(e.currentTarget.parentElement!) }); }}
                >
                  <ChevronDown size={14} />
                </span>
              )}
            </Link>
          );
        })}
        {!dashMode && canDesign && (
          <button className="tab add" onClick={addTable}>
            <Plus size={15} /> Add table
          </button>
        )}
      </nav>

      {error && <div className="error banner" onClick={() => setError(null)}>{error}</div>}
      {!dashMode && tableId && tables.some((t) => t.id === tableId) && (
        <TableWorkspace key={tableId} baseId={baseId!} tableId={tableId} tables={tables} role={role} guest={guest} />
      )}
      {dashMode && (() => {
        const d = dashboards.find((x) => x.id === dashId);
        if (dashQ.isLoading) return <div className="center"><div className="spinner" /></div>;
        if (!d) {
          return (
            <div className="dash-empty" style={{ marginTop: 60 }}>
              <LayoutDashboard size={26} />
              <strong>No dashboards yet</strong>
              <span>Dashboards show numbers, charts and lists from your tables — they update as records change.</span>
              {canDesign && <button className="btn primary" onClick={addDashboard}><Plus size={15} /> Create a dashboard</button>}
            </div>
          );
        }
        return <DashboardView key={d.id} dashboard={d} tables={tables} canDesign={canDesign} />;
      })()}
      {dashMenu && (
        <Popover anchor={dashMenu.anchor} onClose={() => setDashMenu(null)} minWidth={200}>
          <div className="menu">
            <button onClick={async () => {
              const d = dashMenu.dash;
              setDashMenu(null);
              const name = await dialogs.prompt({ title: "Rename dashboard", label: "Dashboard name", defaultValue: d.name });
              if (name) run(async () => { await api.updateDashboard(d.id, { name }); await qc.invalidateQueries({ queryKey: ["dashboards", baseId] }); });
            }}><Pencil size={15} /> Rename dashboard</button>
            <hr />
            <button className="danger" onClick={async () => {
              const d = dashMenu.dash;
              setDashMenu(null);
              const ok = await dialogs.confirm({ title: `Delete “${d.name}”?`, message: "Only the dashboard is deleted — your records stay as they are.", confirmText: "Delete dashboard", danger: true });
              if (ok) run(async () => { await api.deleteDashboard(d.id); await qc.invalidateQueries({ queryKey: ["dashboards", baseId] }); nav(`/base/${baseId}/dash`); });
            }}><Trash2 size={15} /> Delete dashboard</button>
          </div>
        </Popover>
      )}

      {baseMenu && (
        <Popover anchor={baseMenu} onClose={() => setBaseMenu(null)} minWidth={210}>
          <div className="menu">
            <button onClick={() => { setBaseMenu(null); renameBase(); }}><Pencil size={15} /> Rename base</button>
            {role === "owner" && (
              <>
                <hr />
                <button className="danger" onClick={() => { setBaseMenu(null); deleteBase(); }}><Trash2 size={15} /> Delete base</button>
              </>
            )}
          </div>
        </Popover>
      )}
      {tableMenu && (
        <Popover anchor={tableMenu.anchor} onClose={() => setTableMenu(null)} minWidth={200}>
          <div className="menu">
            <button onClick={() => { const t = tableMenu.table; setTableMenu(null); renameTable(t); }}><Pencil size={15} /> Rename table</button>
            <div className="menu-label">Who can add and delete records</div>
            {(["all", "team", "creators"] as const).map((v) => (
              <button key={v} className={tableMenu.table.recordAccess === v ? "checked" : ""} onClick={() => {
                const t = tableMenu.table;
                setTableMenu(null);
                run(async () => { await api.setRecordAccess(t.id, v); await refresh(); });
              }}>
                <span className="menu-check">{tableMenu.table.recordAccess === v ? <Check size={14} /> : null}</span>
                {RECORD_ACCESS_LABEL[v]}
              </button>
            ))}
            {tables.length > 1 && (
              <>
                <hr />
                <button className="danger" onClick={() => { const t = tableMenu.table; setTableMenu(null); deleteTable(t); }}>
                  <Trash2 size={15} /> Delete table
                </button>
              </>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
