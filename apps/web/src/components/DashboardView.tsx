import {
  CHART_LABELS, CHART_TYPES, COMPUTED_TYPES, METRIC_LABELS, WIDGET_LABELS, cellToText, formatDateCell, isNumericField, effectiveType, newId,
  type ChartType, type Dashboard, type Field, type Metric, type Table, type Widget, type WidgetData, type WidgetType,
} from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft, ArrowLeft, ArrowRight, BarChart3, ChartColumn, ChartLine, ChartPie, Hash, LayoutDashboard, List, Maximize2, Minimize2, Pencil, Plus, Settings2, Trash2, X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { BarChart, ColumnLineChart, DonutChart } from "./Charts";
import { useDialogs } from "./Dialogs";
import { FieldIcon } from "./fieldIcons";

const TYPE_ICONS: Record<WidgetType, typeof Hash> = { number: Hash, chart: BarChart3, list: List, text: AlignLeft };
const CHART_ICONS: Record<ChartType, typeof Hash> = { bar: BarChart3, column: ChartColumn, line: ChartLine, donut: ChartPie };

/** One dashboard: a grid of widget cards. Creators switch to edit mode to add and arrange widgets. */
export function DashboardView({ dashboard, tables, canDesign }: { dashboard: Dashboard; tables: Table[]; canDesign: boolean }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const dataKey = ["dashboardData", dashboard.id];
  const data = useQuery({ queryKey: dataKey, queryFn: () => api.dashboardData(dashboard.id), refetchInterval: 60_000 });
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<{ widget?: Widget } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const widgets = dashboard.widgets;

  const save = async (next: Widget[]) => {
    setError(null);
    qc.setQueryData<{ dashboards: Dashboard[] }>(["dashboards", dashboard.baseId], (d) =>
      d && { dashboards: d.dashboards.map((x) => (x.id === dashboard.id ? { ...x, widgets: next } : x)) });
    try {
      await api.updateDashboard(dashboard.id, { widgets: next });
      await qc.invalidateQueries({ queryKey: ["dashboards", dashboard.baseId] });
      await qc.invalidateQueries({ queryKey: dataKey });
    } catch (e) {
      setError((e as Error).message);
      await qc.invalidateQueries({ queryKey: ["dashboards", dashboard.baseId] });
    }
  };
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= widgets.length) return;
    const next = [...widgets];
    [next[i], next[j]] = [next[j], next[i]];
    void save(next);
  };
  const resize = (i: number, by: number) => {
    const w = widgets[i];
    void save(widgets.map((x, j) => (j === i ? { ...x, width: Math.min(4, Math.max(1, w.width + by)) } : x)));
  };
  const remove = async (w: Widget) => {
    const ok = await dialogs.confirm({ title: `Remove “${w.title || WIDGET_LABELS[w.type]}”?`, message: "Only the widget is removed — your records stay as they are.", confirmText: "Remove", danger: true });
    if (ok) void save(widgets.filter((x) => x.id !== w.id));
  };

  return (
    <div className="dash">
      <div className="dash-bar">
        <h2>{dashboard.name}</h2>
        <span className="muted small">{data.isFetching ? "Updating…" : "Live — updates as records change"}</span>
        <div className="spacer" />
        {canDesign && (
          editing ? (
            <>
              <button className="btn" onClick={() => setDialog({})}><Plus size={15} /> Add widget</button>
              <button className="btn primary" onClick={() => setEditing(false)}>Done</button>
            </>
          ) : (
            <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} /> Edit dashboard</button>
          )
        )}
      </div>
      {error && <div className="error banner" style={{ margin: "0 20px" }}>{error}</div>}

      {widgets.length === 0 ? (
        <div className="dash-empty">
          <LayoutDashboard size={26} />
          <strong>This dashboard is empty</strong>
          <span>Add numbers, charts and lists that update by themselves as your records change.</span>
          {canDesign && <button className="btn primary" onClick={() => { setEditing(true); setDialog({}); }}><Plus size={15} /> Add a widget</button>}
        </div>
      ) : (
        <div className={"dash-grid" + (editing ? " editing" : "")}>
          {widgets.map((w, i) => (
            <section key={w.id} className={`widget w-${w.type}`} style={{ gridColumn: `span ${w.width}` }}>
              <header className="widget-head">
                <h3>{w.title || defaultTitle(w, tables)}</h3>
                {w.type !== "text" && <span className="widget-src">{sourceLabel(w, tables)}</span>}
                {editing && (
                  <div className="widget-tools">
                    <button className="icon-btn" title="Move left" disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft size={14} /></button>
                    <button className="icon-btn" title="Move right" disabled={i === widgets.length - 1} onClick={() => move(i, 1)}><ArrowRight size={14} /></button>
                    <button className="icon-btn" title="Narrower" disabled={w.width <= 1} onClick={() => resize(i, -1)}><Minimize2 size={14} /></button>
                    <button className="icon-btn" title="Wider" disabled={w.width >= 4} onClick={() => resize(i, 1)}><Maximize2 size={14} /></button>
                    <button className="icon-btn" title="Settings" onClick={() => setDialog({ widget: w })}><Settings2 size={14} /></button>
                    <button className="icon-btn danger" title="Remove" onClick={() => remove(w)}><Trash2 size={14} /></button>
                  </div>
                )}
              </header>
              <WidgetBody widget={w} data={data.data?.data[w.id]} loading={data.isLoading} />
            </section>
          ))}
        </div>
      )}

      {dialog && (
        <WidgetDialog
          widget={dialog.widget}
          tables={tables}
          onClose={() => setDialog(null)}
          onSave={(w) => {
            setDialog(null);
            void save(dialog.widget ? widgets.map((x) => (x.id === w.id ? w : x)) : [...widgets, w]);
          }}
        />
      )}
    </div>
  );
}

function defaultTitle(w: Widget, tables: Table[]) {
  const t = tables.find((x) => w.type !== "text" && x.id === w.tableId)?.name ?? "";
  if (w.type === "number") return w.metric.kind === "count" ? `${t} records` : `${METRIC_LABELS[w.metric.kind]} · ${t}`;
  if (w.type === "chart") return `${t} chart`;
  if (w.type === "list") return t;
  return "";
}
function sourceLabel(w: Widget, tables: Table[]) {
  if (w.type === "text") return "";
  return tables.find((x) => x.id === w.tableId)?.name ?? "(deleted table)";
}

function WidgetBody({ widget, data, loading }: { widget: Widget; data: WidgetData | undefined; loading: boolean }) {
  if (widget.type === "text") return <div className="widget-text">{widget.text || <span className="muted">Empty note.</span>}</div>;
  if (loading || !data) return <div className="widget-loading"><div className="spinner" /></div>;
  if (data.type === "error") return <div className="widget-error">{data.message}</div>;
  if (data.type === "number") {
    return (
      <div className="widget-number">
        <span className="big">{data.display}</span>
        <span className="muted small">{data.records} record{data.records === 1 ? "" : "s"}</span>
      </div>
    );
  }
  if (data.type === "list") {
    const fields = data.fields as unknown as Field[];
    return (
      <div className="widget-list">
        <table>
          <thead><tr>{fields.map((f) => <th key={f.id}>{f.name}</th>)}</tr></thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.id}>
                {fields.map((f) => {
                  const v = (r.cells[f.id] ?? null) as Parameters<typeof cellToText>[1];
                  const text = f.type === "checkbox" ? (v ? "✓" : "") : f.type === "attachment" ? `${(v as string[] | null)?.length ?? 0} files` : f.type === "date" && v ? formatDateCell(String(v)) : cellToText(f, v, data.labels);
                  return <td key={f.id} className={isNumericField(f) ? "num" : ""}>{text}</td>;
                })}
              </tr>
            ))}
            {data.records.length === 0 && <tr><td colSpan={fields.length} className="muted">No records.</td></tr>}
          </tbody>
        </table>
        {data.more > 0 && <div className="widget-more">+ {data.more} more</div>}
      </div>
    );
  }
  if (data.type === "chart" && widget.type === "chart") {
    if (data.groups.length === 0) return <div className="widget-error muted">No records to chart yet.</div>;
    return (
      <div className="widget-chart">
        <div className="chart-caption">{data.valueLabel} · total {data.totalDisplay}</div>
        {widget.chartType === "bar" && <BarChart groups={data.groups} total={data.total} />}
        {widget.chartType === "column" && <ColumnLineChart groups={data.groups} total={data.total} />}
        {widget.chartType === "line" && <ColumnLineChart groups={data.groups} total={data.total} line />}
        {widget.chartType === "donut" && <DonutChart groups={data.groups} total={data.total} totalDisplay={data.totalDisplay} />}
      </div>
    );
  }
  return null;
}

/** Add or change a widget. */
function WidgetDialog({ widget, tables, onSave, onClose }: {
  widget?: Widget; tables: Table[]; onSave: (w: Widget) => void; onClose: () => void;
}) {
  const [type, setType] = useState<WidgetType>(widget?.type ?? "number");
  const [title, setTitle] = useState(widget?.title ?? "");
  const [width, setWidth] = useState(widget?.width ?? 1);
  const [tableId, setTableId] = useState(widget && widget.type !== "text" ? widget.tableId : tables[0]?.id ?? "");
  const [viewId, setViewId] = useState<string | null>(widget && widget.type !== "text" ? widget.viewId : null);
  const [metric, setMetric] = useState<Metric>(widget && (widget.type === "number" || widget.type === "chart") ? widget.metric : { kind: "count", fieldId: null });
  const [chartType, setChartType] = useState<ChartType>(widget?.type === "chart" ? widget.chartType : "bar");
  const [groupFieldId, setGroupFieldId] = useState<string | null>(widget?.type === "chart" ? widget.groupFieldId : null);
  const [dateBucket, setDateBucket] = useState<"day" | "week" | "month">(widget?.type === "chart" ? widget.dateBucket : "month");
  const [limit, setLimit] = useState(widget?.type === "chart" || widget?.type === "list" ? widget.limit : 8);
  const [fieldIds, setFieldIds] = useState<string[]>(widget?.type === "list" ? widget.fieldIds : []);
  const [text, setText] = useState(widget?.type === "text" ? widget.text : "");
  const schema = useQuery({ queryKey: ["table", tableId], queryFn: () => api.table(tableId), enabled: !!tableId });
  const fields = schema.data?.fields ?? [];
  const views = (schema.data?.views ?? []).filter((v) => v.type !== "form");
  const numeric = fields.filter((f) => isNumericField(f));
  const groupable = fields.filter((f) => f.type !== "attachment" && f.type !== "longText" && !(isNumericField(f) && !COMPUTED_TYPES.has(f.type) && f.type !== "rating"));
  const groupField = fields.find((f) => f.id === groupFieldId);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  // Sensible defaults when switching type or table.
  useEffect(() => { if (!widget) setWidth(type === "number" ? 1 : type === "text" ? 4 : 2); }, [type]);
  useEffect(() => {
    if (!fields.length) return;
    if (!groupFieldId || !fields.some((f) => f.id === groupFieldId)) {
      setGroupFieldId((fields.find((f) => f.type === "singleSelect") ?? groupable[0])?.id ?? null);
    }
    if (metric.fieldId && !fields.some((f) => f.id === metric.fieldId)) setMetric({ kind: "count", fieldId: null });
  }, [schema.data]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = widget?.id ?? newId("wdg");
    // An empty title gets a descriptive one, e.g. "Clients by Industry" or "Sum of Budget".
    const tableName = tables.find((t) => t.id === tableId)?.name ?? "";
    const metricName = metric.kind === "count" ? "" : `${METRIC_LABELS[metric.kind]} of ${fields.find((f) => f.id === metric.fieldId)?.name ?? ""}`;
    const auto = type === "chart" ? `${metricName || tableName} by ${groupField?.name ?? ""}`
      : type === "number" ? (metricName || `${tableName} records`)
      : type === "list" ? tableName : "";
    const base = { id, title: title.trim() || auto, width };
    if (type === "text") return onSave({ ...base, type, text });
    const src = { tableId, viewId };
    if (type === "number") return onSave({ ...base, ...src, type, metric });
    if (type === "list") return onSave({ ...base, ...src, type, fieldIds, limit });
    onSave({ ...base, ...src, type, chartType, groupFieldId, dateBucket, metric, limit });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal widget-modal" onSubmit={submit}>
        <div className="modal-head">
          <h3>{widget ? "Widget settings" : "Add a widget"}</h3>
          <div className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} title="Close"><X size={18} /></button>
        </div>
        {!widget && (
          <div className="widget-types">
            {(Object.keys(WIDGET_LABELS) as WidgetType[]).map((t) => {
              const Icon = TYPE_ICONS[t];
              return (
                <button type="button" key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                  <Icon size={18} /> {WIDGET_LABELS[t]}
                </button>
              );
            })}
          </div>
        )}
        <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="(automatic)" maxLength={120} /></label>

        {type === "text" ? (
          <label>Text <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="A heading, a note for the team, links…" /></label>
        ) : (
          <>
            <div className="form-2col">
              <label>Table
                <select value={tableId} onChange={(e) => { setTableId(e.target.value); setViewId(null); setFieldIds([]); }}>
                  {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label>Records
                <select value={viewId ?? ""} onChange={(e) => setViewId(e.target.value || null)}>
                  <option value="">All records</option>
                  {views.map((v) => <option key={v.id} value={v.id}>Only those in “{v.name}”</option>)}
                </select>
              </label>
            </div>

            {type === "chart" && (
              <>
                <div className="chart-types">
                  {CHART_TYPES.map((c) => {
                    const Icon = CHART_ICONS[c];
                    return <button type="button" key={c} className={chartType === c ? "on" : ""} onClick={() => setChartType(c)}><Icon size={16} /> {CHART_LABELS[c]}</button>;
                  })}
                </div>
                <div className="form-2col">
                  <label>Group by
                    <select value={groupFieldId ?? ""} onChange={(e) => setGroupFieldId(e.target.value || null)}>
                      {groupable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </label>
                  {groupField && effectiveType(groupField) === "date" ? (
                    <label>Period
                      <select value={dateBucket} onChange={(e) => setDateBucket(e.target.value as "day" | "week" | "month")}>
                        <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
                      </select>
                    </label>
                  ) : (
                    <label>Show the top
                      <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                        {[3, 4, 5, 6, 8, 10, 12, 15, 20].map((n) => <option key={n} value={n}>{n} groups</option>)}
                      </select>
                    </label>
                  )}
                </div>
                {chartType === "donut" && <span className="field-hint">Donuts work best with up to 6 groups; more are added up as “Other”.</span>}
              </>
            )}

            {(type === "number" || type === "chart") && (
              <div className="form-2col">
                <label>{type === "chart" ? (chartType === "donut" ? "Slice size" : chartType === "line" ? "Values" : "Bar size") : "Show"}
                  <select value={metric.kind} onChange={(e) => {
                    const kind = e.target.value as Metric["kind"];
                    setMetric({ kind, fieldId: kind === "count" ? null : metric.fieldId ?? numeric[0]?.id ?? null });
                  }}>
                    {(Object.keys(METRIC_LABELS) as Metric["kind"][]).map((k) => (
                      <option key={k} value={k} disabled={k !== "count" && !numeric.length}>{METRIC_LABELS[k]}</option>
                    ))}
                  </select>
                </label>
                {metric.kind !== "count" && (
                  <label>Of
                    <select value={metric.fieldId ?? ""} onChange={(e) => setMetric({ ...metric, fieldId: e.target.value })}>
                      {numeric.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}

            {type === "list" && (
              <>
                <label>Fields to show <span className="field-hint">(up to 8 — none ticked shows the first 4)</span></label>
                <div className="widget-fields">
                  {fields.map((f) => (
                    <label key={f.id} className="row">
                      <input
                        type="checkbox"
                        checked={fieldIds.includes(f.id)}
                        disabled={!fieldIds.includes(f.id) && fieldIds.length >= 8}
                        onChange={(e) => setFieldIds(e.target.checked ? [...fieldIds, f.id] : fieldIds.filter((x) => x !== f.id))}
                      />
                      <FieldIcon type={f.type} size={13} /> {f.name}
                    </label>
                  ))}
                </div>
                <label>How many records
                  <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {[3, 5, 8, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <span className="field-hint">Records come in the order of the chosen view (sort it there).</span>
              </>
            )}
          </>
        )}

        <label>Width
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            <option value={1}>Quarter</option><option value={2}>Half</option><option value={3}>Three quarters</option><option value={4}>Full width</option>
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={type !== "text" && !tableId}>{widget ? "Save" : "Add widget"}</button>
        </div>
      </form>
    </div>
  );
}

/** Dashboards of a base: the tab list and the selected one. */
export function useDashboards(baseId: string) {
  return useQuery({ queryKey: ["dashboards", baseId], queryFn: () => api.dashboards(baseId) });
}
