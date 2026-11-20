import {
  LIST_OPS,
  OPERATOR_LABELS,
  isDateLike,
  effectiveType,
  isNumericField,
  VALUELESS_OPS,
  operatorsFor,
  type Field,
  type FilterCondition,
  type FilterOperator,
  type SortSpec,
} from "@brill/shared";
import { ArrowDownUp, CalendarDays, Check, Globe, Image as ImageIcon, Maximize, Palette, Download, EyeOff, FileUp, Kanban, ListFilter, MoreHorizontal, Plus, Rows3, Search, X } from "lucide-react";
import { api } from "../api";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { ShareLinkDialog } from "./ShareLinkDialog";
import { useState } from "react";
import { FieldIcon } from "./fieldIcons";
import { ChoicePill, Popover, anchorOf, type Anchor } from "./Popover";
import type { ViewContext } from "./TableWorkspace";
import { ViewIcon } from "./ViewSidebar";
import { useCollaborators } from "./PeoplePicker";

type Panel = "hide" | "filter" | "sort" | "height" | "stack" | "more" | "date" | "color" | "cover" | "size";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function ViewToolbar({ ctx, recordCount, loading }: { ctx: ViewContext; recordCount: number; loading: boolean }) {
  const [open, setOpen] = useState<{ panel: Panel; anchor: Anchor } | null>(null);
  const [importing, setImporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { view, allFields, updateConfig } = ctx;
  const cfg = view.config;
  const toggle = (panel: Panel) => (e: React.MouseEvent) => {
    if (!ctx.canEdit && panel !== "more") return; // view settings are shared, so editors+ only
    setOpen(open?.panel === panel ? null : { panel, anchor: anchorOf(e.currentTarget) });
  };

  const hiddenCount = cfg.hiddenFieldIds.filter((id) => allFields.some((f) => f.id === id && f.id !== ctx.primaryFieldId)).length;
  const filterCount = cfg.filters.conditions.length;
  const sortCount = cfg.sorts.length;
  const stackField = allFields.find((f) => f.id === cfg.stackFieldId);
  const dateField = allFields.find((f) => f.id === cfg.dateFieldId && isDateLike(f));
  const colorField = allFields.find((f) => f.id === cfg.colorFieldId);
  const coverField = allFields.find((f) => f.id === cfg.coverFieldId);
  const pick = (label: string, list: typeof allFields, current: string | null, onPick: (id: string | null) => void, allowNone = false) => (
    <div className="menu">
      <div className="menu-label">{label}</div>
      {list.map((f) => (
        <button key={f.id} onClick={() => { onPick(f.id); setOpen(null); }}>
          <span className="check">{current === f.id && <Check size={15} />}</span>
          <FieldIcon type={f.type} /> {f.name}
        </button>
      ))}
      {allowNone && (
        <button onClick={() => { onPick(null); setOpen(null); }}>
          <span className="check">{!current && <Check size={15} />}</span> None
        </button>
      )}
      {list.length === 0 && <div className="panel-empty" style={{ padding: "4px 10px 8px" }}>No suitable fields in this table yet.</div>}
    </div>
  );

  return (
    <div className="toolbar">
      <span className="view-title hide-sm"><ViewIcon type={view.type} /> {view.name}</span>
      <span className="sep hide-sm" />
      {view.type === "calendar" && (
        <>
          <button className={"tool" + (dateField ? "" : " warn")} title="Date field" onClick={toggle("date")}>
            <CalendarDays size={15} /> {dateField ? dateField.name : "Choose a date field"}
          </button>
          <button className="tool" title="Colour events by" onClick={toggle("color")}>
            <Palette size={15} /> <span className="tool-label">{colorField ? `Colour: ${colorField.name}` : "Colour"}</span>
          </button>
        </>
      )}
      {view.type === "gallery" && (
        <>
          <button className="tool" title="Card cover" onClick={toggle("cover")}>
            <ImageIcon size={15} /> <span className="tool-label">{coverField ? `Cover: ${coverField.name}` : "Cover"}</span>
          </button>
          <button className="tool" title="Card size" onClick={toggle("size")}><Maximize size={15} /> <span className="tool-label">Card size</span></button>
        </>
      )}
      {view.type === "kanban" && (
        <button className={"tool" + (stackField ? "" : " warn")} onClick={toggle("stack")}>
          <Kanban size={15} /> {stackField ? `Stacked by ${stackField.name}` : "Choose a stacking field"}
        </button>
      )}
      <button className={"tool" + (hiddenCount ? " active-hide" : "")} title="Hide fields" onClick={toggle("hide")}>
        <EyeOff size={15} /> <span className="tool-label">{hiddenCount ? plural(hiddenCount, "hidden field") : "Hide fields"}</span>
      </button>
      <button className={"tool" + (filterCount ? " active-filter" : "")} title="Filter" onClick={toggle("filter")}>
        <ListFilter size={15} /> <span className="tool-label">{filterCount ? `Filtered by ${plural(filterCount, "condition")}` : "Filter"}</span>
      </button>
      <button className={"tool" + (sortCount ? " active-sort" : "")} title="Sort" onClick={toggle("sort")}>
        <ArrowDownUp size={15} /> <span className="tool-label">{sortCount ? `Sorted by ${plural(sortCount, "field")}` : "Sort"}</span>
      </button>
      {view.type === "grid" && (
        <button className="tool" title="Row height" onClick={toggle("height")}><Rows3 size={15} /> <span className="tool-label">Row height</span></button>
      )}
      <div className="spacer" />
      <div className="search input-icon">
        <Search size={14} />
        <input placeholder="Search…" value={ctx.search} onChange={(e) => ctx.setSearch(e.target.value)} />
      </div>
      <span className="count">{loading ? "…" : plural(recordCount, "record")}</span>
      {ctx.canDesign && <button className="btn sm hide-sm" onClick={() => ctx.editField()}><Plus size={14} /> Field</button>}
      {ctx.canAddRecords && <button className="btn primary sm" onClick={() => ctx.addRecord()}><Plus size={14} /> Record</button>}
      {ctx.guest && <span className="role-pill guest" title="You were invited to this base only">Guest · {ctx.canEdit ? "can edit" : ctx.canComment ? "can comment" : "read only"}</span>}
      {!ctx.canEdit && !ctx.guest && <span className="role-pill">{ctx.canComment ? "Can comment" : "Read only"}</span>}
      <button className="icon-btn" title="More" onClick={toggle("more")} style={{ marginLeft: 2 }}><MoreHorizontal size={17} /></button>
      {sharing && (
        <ShareLinkDialog viewId={view.id} viewName={view.name} isForm={false} canManage={ctx.canDesign} onClose={() => setSharing(false)} />
      )}
      {importing && (
        <ImportCsvDialog tableId={ctx.tableId} fields={allFields} onDone={ctx.refresh} onClose={() => setImporting(false)} />
      )}

      {open && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} minWidth={open.panel === "filter" ? 560 : open.panel === "height" ? 180 : open.panel === "more" ? 240 : 300}>
          {open.panel === "hide" && <HideFields ctx={ctx} />}
          {open.panel === "filter" && <FilterEditor ctx={ctx} />}
          {open.panel === "sort" && <SortEditor ctx={ctx} />}
          {open.panel === "height" && (
            <div className="menu">
              <div className="menu-label">Row height</div>
              {(["short", "medium", "tall"] as const).map((h) => (
                <button key={h} onClick={() => { updateConfig({ rowHeight: h }); setOpen(null); }}>
                  <span className="check">{cfg.rowHeight === h && <Check size={15} />}</span>{h[0].toUpperCase() + h.slice(1)}
                </button>
              ))}
            </div>
          )}
          {open.panel === "more" && (
            <div className="menu">
              {ctx.canAddRecords && <button onClick={() => { setOpen(null); setImporting(true); }}><FileUp size={15} /> Import CSV…</button>}
              <button onClick={() => { setOpen(null); setSharing(true); }}><Globe size={15} /> Share view (public link)…</button>
              <button onClick={() => { setOpen(null); window.location.href = api.exportCsvUrl(view.id); }}>
                <Download size={15} /> Download CSV of this view
              </button>
            </div>
          )}
          {open.panel === "date" && pick("Place records by", allFields.filter(isDateLike), cfg.dateFieldId, (id) => updateConfig({ dateFieldId: id }))}
          {open.panel === "color" && pick("Colour events by", allFields.filter((f) => f.type === "singleSelect"), cfg.colorFieldId, (id) => updateConfig({ colorFieldId: id }), true)}
          {open.panel === "cover" && (
            <>
              {pick("Card cover", allFields.filter((f) => f.type === "attachment"), cfg.coverFieldId, (id) => updateConfig({ coverFieldId: id }), true)}
              <div className="menu">
                <hr />
                <div className="menu-label">Image fit</div>
                {(["cover", "contain"] as const).map((fit) => (
                  <button key={fit} onClick={() => { updateConfig({ coverFit: fit }); setOpen(null); }}>
                    <span className="check">{cfg.coverFit === fit && <Check size={15} />}</span>
                    {fit === "cover" ? "Crop to fill" : "Fit whole image"}
                  </button>
                ))}
              </div>
            </>
          )}
          {open.panel === "size" && (
            <div className="menu">
              <div className="menu-label">Card size</div>
              {(["small", "medium", "large"] as const).map((s) => (
                <button key={s} onClick={() => { updateConfig({ cardSize: s }); setOpen(null); }}>
                  <span className="check">{cfg.cardSize === s && <Check size={15} />}</span>{s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          )}
          {open.panel === "stack" && (
            <div className="menu">
              <div className="menu-label">Stack records by</div>
              {allFields.filter((f) => f.type === "singleSelect").map((f) => (
                <button key={f.id} onClick={() => { updateConfig({ stackFieldId: f.id }); setOpen(null); }}>
                  <span className="check">{cfg.stackFieldId === f.id && <Check size={15} />}</span>
                  <FieldIcon type={f.type} /> {f.name}
                </button>
              ))}
              {!allFields.some((f) => f.type === "singleSelect") && (
                <div className="panel-empty" style={{ padding: "4px 10px 8px" }}>Add a single select field first.</div>
              )}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

function HideFields({ ctx }: { ctx: ViewContext }) {
  const { allFields, primaryFieldId, view, updateConfig } = ctx;
  const hidden = new Set(view.config.hiddenFieldIds);
  const [find, setFind] = useState("");
  const others = allFields.filter((f) => f.id !== primaryFieldId && f.name.toLowerCase().includes(find.toLowerCase()));
  return (
    <div className="panel">
      <input placeholder="Find a field" value={find} onChange={(e) => setFind(e.target.value)} autoFocus />
      <div className="field-toggles">
        {others.map((f) => (
          <label key={f.id} className="row toggle">
            <input
              type="checkbox"
              checked={!hidden.has(f.id)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(f.id);
                else next.add(f.id);
                updateConfig({ hiddenFieldIds: [...next] });
              }}
            />
            <FieldIcon type={f.type} size={14} />
            {f.name}
          </label>
        ))}
      </div>
      <div className="panel-actions">
        <button className="link" onClick={() => updateConfig({ hiddenFieldIds: allFields.filter((f) => f.id !== primaryFieldId).map((f) => f.id) })}>Hide all</button>
        <button className="link" onClick={() => updateConfig({ hiddenFieldIds: [] })}>Show all</button>
      </div>
    </div>
  );
}

let condSeq = 0;
const newCondId = () => `c${Date.now().toString(36)}${condSeq++}`;

function defaultOperator(f: Field): FilterOperator {
  return operatorsFor(f)[0];
}

function FilterEditor({ ctx }: { ctx: ViewContext }) {
  const { allFields, view, updateConfig } = ctx;
  const { conjunction, conditions } = view.config.filters;
  const set = (next: FilterCondition[], conj = conjunction) => updateConfig({ filters: { conjunction: conj, conditions: next } });
  const update = (id: string, patch: Partial<FilterCondition>) => set(conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <div className="panel">
      <div className="panel-title">Filter records</div>
      {conditions.length === 0 && <div className="panel-empty">No conditions yet. Add one to show only matching records.</div>}
      {conditions.map((c, i) => {
        const field = allFields.find((f) => f.id === c.fieldId);
        return (
          <div key={c.id} className="filter-row">
            <div className="filter-conj">
              {i === 0 ? "Where" : i === 1 ? (
                <select value={conjunction} onChange={(e) => set(conditions, e.target.value as "and" | "or")}>
                  <option value="and">and</option>
                  <option value="or">or</option>
                </select>
              ) : conjunction}
            </div>
            <select
              value={c.fieldId}
              onChange={(e) => {
                const f = allFields.find((x) => x.id === e.target.value)!;
                update(c.id, { fieldId: f.id, operator: defaultOperator(f), value: null });
              }}
            >
              {!field && <option value={c.fieldId}>(deleted field)</option>}
              {allFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {field && (
              <select
                value={c.operator}
                onChange={(e) => {
                  const op = e.target.value as FilterOperator;
                  // Switching between single-value and list operators resets the value.
                  const keep = LIST_OPS.has(op) === LIST_OPS.has(c.operator);
                  update(c.id, { operator: op, value: keep ? c.value : null });
                }}
              >
                {operatorsFor(field).map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
              </select>
            )}
            <div className="filter-value">
              {field && !VALUELESS_OPS.has(c.operator) && (
                <FilterValueInput field={field} cond={c} onChange={(value) => update(c.id, { value })} />
              )}
            </div>
            <button className="icon-btn" title="Remove condition" onClick={() => set(conditions.filter((x) => x.id !== c.id))}><X size={15} /></button>
          </div>
        );
      })}
      <div className="panel-actions">
        <button
          className="link"
          onClick={() => {
            const f = allFields[0];
            if (f) set([...conditions, { id: newCondId(), fieldId: f.id, operator: defaultOperator(f), value: null }]);
          }}
        >
          <Plus size={14} /> Add condition
        </button>
        {conditions.length > 0 && <button className="link" onClick={() => set([])}>Clear all</button>}
      </div>
    </div>
  );
}

function FilterValueInput({ field, cond, onChange }: { field: Field; cond: FilterCondition; onChange: (v: FilterCondition["value"]) => void }) {
  const v = cond.value;
  if (effectiveType(field) === "user") return <PeopleFilter value={v} onChange={onChange} />;
  if (LIST_OPS.has(cond.operator)) {
    const selected = new Set(Array.isArray(v) ? v : []);
    return (
      <div className="choice-checks">
        {(field.options.choices ?? []).map((c) => (
          <label key={c.id} className="row">
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(c.id);
                else next.delete(c.id);
                onChange([...next]);
              }}
            />
            <ChoicePill field={field} id={c.id} />
          </label>
        ))}
      </div>
    );
  }
  if (field.type === "singleSelect") {
    return (
      <select value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Select an option</option>
        {(field.options.choices ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    );
  }
  if (effectiveType(field) === "date") {
    const rel = v === "today" || v === "tomorrow" || v === "yesterday";
    return (
      <div className="row">
        <select value={rel ? String(v) : "exact"} onChange={(e) => onChange(e.target.value === "exact" ? null : e.target.value)}>
          <option value="today">today</option>
          <option value="tomorrow">tomorrow</option>
          <option value="yesterday">yesterday</option>
          <option value="exact">exact date</option>
        </select>
        {!rel && <input type="date" value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value || null)} />}
      </div>
    );
  }
  return (
    <DebouncedInput
      type={isNumericField(field) ? "number" : "text"}
      value={v === null || v === undefined ? "" : String(v)}
      onChange={(s) => onChange(s === "" ? null : isNumericField(field) ? Number(s) : s)}
    />
  );
}

/** Tick the people to match. */
function PeopleFilter({ value, onChange }: { value: FilterCondition["value"]; onChange: (v: FilterCondition["value"]) => void }) {
  const q = useCollaborators();
  const selected = new Set(Array.isArray(value) ? value : []);
  return (
    <div className="choice-checks">
      {(q.data?.users ?? []).map((u) => (
        <label key={u.id} className="row">
          <input
            type="checkbox"
            checked={selected.has(u.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(u.id);
              else next.delete(u.id);
              onChange([...next]);
            }}
          />
          {u.name}
        </label>
      ))}
    </div>
  );
}

/** Text input that reports changes after typing pauses, so each keystroke doesn't re-query. */
function DebouncedInput({ value, onChange, type }: { value: string; onChange: (v: string) => void; type: string }) {
  const [local, setLocal] = useState(value);
  const [timer, setTimer] = useState<number>();
  return (
    <input
      type={type}
      placeholder="Enter a value"
      value={local}
      onChange={(e) => {
        const s = e.target.value;
        setLocal(s);
        window.clearTimeout(timer);
        setTimer(window.setTimeout(() => onChange(s), 300));
      }}
    />
  );
}

function SortEditor({ ctx }: { ctx: ViewContext }) {
  const { allFields, view, updateConfig } = ctx;
  const sorts = view.config.sorts;
  const set = (next: SortSpec[]) => updateConfig({ sorts: next });
  const used = new Set(sorts.map((s) => s.fieldId));
  const dirLabels = (f?: Field): [string, string] =>
    f?.type === "number" ? ["1 → 9", "9 → 1"]
      : f?.type === "date" ? ["Oldest first", "Newest first"]
      : f?.type === "checkbox" ? ["☐ → ☑", "☑ → ☐"]
      : f?.type === "singleSelect" ? ["First → Last", "Last → First"]
      : ["A → Z", "Z → A"];

  return (
    <div className="panel">
      <div className="panel-title">Sort records</div>
      {sorts.length === 0 && <div className="panel-empty">Not sorted. Add a field to sort by.</div>}
      {sorts.map((s, i) => {
        const f = allFields.find((x) => x.id === s.fieldId);
        const [asc, desc] = dirLabels(f);
        return (
          <div key={i} className="filter-row">
            <select
              value={s.fieldId}
              onChange={(e) => set(sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}
            >
              {!f && <option value={s.fieldId}>(deleted field)</option>}
              {allFields.filter((x) => x.id === s.fieldId || !used.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select value={s.direction} onChange={(e) => set(sorts.map((x, j) => (j === i ? { ...x, direction: e.target.value as "asc" | "desc" } : x)))}>
              <option value="asc">{asc}</option>
              <option value="desc">{desc}</option>
            </select>
            <button className="icon-btn" title="Remove sort" onClick={() => set(sorts.filter((_, j) => j !== i))}><X size={15} /></button>
          </div>
        );
      })}
      <div className="panel-actions">
        {allFields.some((f) => !used.has(f.id)) && (
          <button className="link" onClick={() => set([...sorts, { fieldId: allFields.find((f) => !used.has(f.id))!.id, direction: "asc" }])}>
            <Plus size={14} /> Add {sorts.length ? "another " : ""}sort
          </button>
        )}
        {sorts.length > 0 && <button className="link" onClick={() => set([])}>Clear sorts</button>}
      </div>
    </div>
  );
}
