import type { Table } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, LayoutDashboard, Pencil, Plus, Sheet, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { BASE_COLORS, BASE_TINTS } from "../colors";
import { AppBar } from "../components/AppBar";
import { useDialogs } from "../components/Dialogs";
import { Popover, anchorOf, type Anchor } from "../components/Popover";
import { ShareDialog } from "../components/ShareDialog";
import { AutomationsPanel } from "../components/AutomationsPanel";
import { DashboardView, NewDashboardDialog, useDashboards } from "../components/DashboardView";
import type { Dashboard } from "@brill/shared";
import { TableWorkspace } from "../components/TableWorkspace";
import { FormsPage } from "../components/FormsPage";
import { BaseIcon } from "../components/BaseIcon";
import { useBaseEvents } from "../useBaseEvents";

const RECORD_ACCESS_LABEL = { all: "Everyone who can edit", team: "Workspace team only", creators: "Creators and owners only" } as const;

export function BasePage() {
  const { baseId, tableId, dashId } = useParams();
  const pathname = useLocation().pathname;
  const dashMode = pathname.startsWith(`/base/${baseId}/dash`);
  const formsMode = pathname === `/base/${baseId}/forms`;
  const dataMode = !dashMode && !formsMode;
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
  const [newDash, setNewDash] = useState(false);
  const live = useBaseEvents(baseId);
  // "Recently opened" on the home page.
  useEffect(() => { if (baseId) api.baseOpened(baseId).catch(() => undefined); }, [baseId]);

  const tables = q.data?.tables ?? [];
  useEffect(() => {
    if (!dataMode) return;
    if (q.data && (!tableId || !tables.some((t) => t.id === tableId)) && tables[0]) {
      nav(`/base/${baseId}/${tables[0].id}`, { replace: true });
    }
  }, [q.data, tableId, dataMode]);
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
  const addDashboard = () => setNewDash(true);
  /** One ready-made dashboard per table that doesn't have one yet. */
  const dashboardPerTable = () => run(async () => {
    const have = new Set(dashboards.map((d) => d.tableId));
    let first: string | null = null;
    for (const t of tables.filter((x) => !have.has(x.id))) {
      const { dashboard } = await api.createDashboard(baseId!, { name: t.name, tableId: t.id, starter: true });
      first ??= dashboard.id;
    }
    await qc.invalidateQueries({ queryKey: ["dashboards", baseId] });
    if (first) nav(`/base/${baseId}/dash/${first}`);
  });
  const addTable = async () => {
    const name = await dialogs.prompt({ title: "Add a table", label: "Table name", defaultValue: `Table ${tables.length + 1}`, confirmText: "Create table" });
    if (name) run(async () => { const { table } = await api.createTable(base.id, name); await refresh(); nav(`/base/${baseId}/${table.id}`); });
  };

  return (
    <div className="base-page">
      <AppBar compact>
        <button className="base-switch" onClick={(e) => canDesign && setBaseMenu(anchorOf(e.currentTarget))} title={canDesign ? "Base options" : base.name}>
          <BaseIcon name={base.name} color={base.color} icon={base.icon} logo={base.logo} baseId={base.id} size={28} />
          <span className="name">{base.name}</span>
          {canDesign && <ChevronDown size={15} />}
        </button>
        <nav className="base-nav" aria-label="Base sections">
          <Link className={dataMode ? "on" : ""} to={`/base/${baseId}/${dataTableId ?? ""}`}>Data</Link>
          {canDesign && !guest && <button className={automating ? "on" : ""} onClick={() => setAutomating(true)}>Automations</button>}
          <Link className={dashMode ? "on" : ""} to={`/base/${baseId}/dash`}>Dashboards</Link>
          <Link className={formsMode ? "on" : ""} to={`/base/${baseId}/forms`}>Forms</Link>
        </nav>
        <span className={"live-dot" + (live ? " on" : "")} title={live ? "Live — changes from your team appear automatically" : "Reconnecting…"}>
          <span /> <i className="live-label hide-sm">{live ? "Live" : "Offline"}</i>
        </span>
        <button className="btn sm share-btn" onClick={() => setSharing(true)}><Users size={14} /> Share</button>
      </AppBar>
      {sharing && <ShareDialog baseId={base.id} onClose={() => setSharing(false)} />}
      {automating && <AutomationsPanel baseId={base.id} tables={tables} onClose={() => setAutomating(false)} />}

      {!formsMode && <nav className="table-tabs" style={{ ["--base-tint" as string]: BASE_TINTS[base.color] ?? BASE_TINTS.blue }}>
        {dashMode && dashboards.map((d) => (
          <Link
            key={d.id}
            to={`/base/${baseId}/dash/${d.id}`}
            className={"tab" + (d.id === dashId ? " active" : "")}
            onContextMenu={(e) => { if (!canDesign) return; e.preventDefault(); setDashMenu({ dash: d, anchor: anchorOf(e.currentTarget) }); }}
          >
            {d.tableId ? <Sheet size={15} /> : <LayoutDashboard size={15} />}
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
        {dataMode && tables.map((t) => {
          const active = t.id === tableId;
          return (
            <Link
              key={t.id}
              to={`/base/${baseId}/${t.id}`}
              className={"tab" + (active ? " active" : "")}
              onDoubleClick={(e) => { e.preventDefault(); if (canDesign) renameTable(t); }}
              onContextMenu={(e) => { if (!canDesign) return; e.preventDefault(); setTableMenu({ table: t, anchor: anchorOf(e.currentTarget) }); }}
            >
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
        {dataMode && canDesign && (
          <button className="tab add" onClick={addTable} title="Add a table">
            <Plus size={15} /> <span className="hide-sm">Add table</span>
          </button>
        )}
      </nav>}

      {error && <div className="error banner" onClick={() => setError(null)}>{error}</div>}
      {formsMode && <FormsPage baseId={baseId!} tables={tables} canEdit={role !== "commenter" && role !== "read"} />}
      {dataMode && tableId && tables.some((t) => t.id === tableId) && (
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
              <span>Dashboards show numbers, charts and the latest records from your tables — they update as records change.</span>
              {canDesign && (
                <div className="dash-empty-actions">
                  {tables.length > 0 && <button className="btn primary" onClick={dashboardPerTable}><Sheet size={15} /> Create a dashboard for each table</button>}
                  <button className="btn" onClick={addDashboard}><Plus size={15} /> New dashboard</button>
                </div>
              )}
            </div>
          );
        }
        return <DashboardView key={d.id} dashboard={d} tables={tables} canDesign={canDesign} />;
      })()}
      {newDash && (
        <NewDashboardDialog
          tables={tables}
          dashboards={dashboards}
          onClose={() => setNewDash(false)}
          onCreate={(body) => run(async () => {
            setNewDash(false);
            const { dashboard } = await api.createDashboard(baseId!, body);
            await qc.invalidateQueries({ queryKey: ["dashboards", baseId] });
            nav(`/base/${baseId}/dash/${dashboard.id}`);
          })}
        />
      )}
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
