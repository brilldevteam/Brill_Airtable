import { cellToText, isDateLike, type CellValue, type Field, type RecordRow } from "@brill/shared";
import { CalendarX2, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { CHOICE_COLORS } from "../colors";
import { Popover, anchorOf, type Anchor } from "./Popover";
import type { ViewContext } from "./TableWorkspace";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local calendar day of a stored date ("YYYY-MM-DD" stays as is; full ISO uses local time). */
function dayKey(v: CellValue): string | null {
  if (typeof v !== "string" || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : keyOf(d);
}

/** Move a stored date to another day, keeping its time of day. */
function moveToDay(v: CellValue, day: string, includeTime: boolean): string {
  if (!includeTime) return day;
  const [y, m, d] = day.split("-").map(Number);
  const old = typeof v === "string" && v.includes("T") ? new Date(v) : null;
  const next = new Date(y, m - 1, d, old?.getHours() ?? 9, old?.getMinutes() ?? 0);
  return next.toISOString();
}

export function CalendarView({ ctx }: { ctx: ViewContext }) {
  const { view, allFields, records, primaryFieldId, saveCells } = ctx;
  const dateField = allFields.find((f) => f.id === view.config.dateFieldId && isDateLike(f));
  const colorField = allFields.find((f) => f.id === view.config.colorFieldId && f.type === "singleSelect");
  const primary = allFields.find((f) => f.id === primaryFieldId);
  const editable = dateField?.type === "date" && ctx.canEdit;

  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [more, setMore] = useState<{ day: string; anchor: Anchor } | null>(null);
  const [undated, setUndated] = useState(false);

  // 6 weeks starting on the Monday on/before the 1st.
  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const q = ctx.search.trim().toLowerCase();
  const shown = q
    ? records.filter((r) => allFields.some((f) => cellToText(f, r.cells[f.id] ?? null, ctx.labels).toLowerCase().includes(q)))
    : records;

  const byDay = useMemo(() => {
    const m = new Map<string, RecordRow[]>();
    if (!dateField) return m;
    for (const r of shown) {
      const k = dayKey(r.cells[dateField.id] ?? null);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    // Timed events in time order, then untimed by name.
    for (const list of m.values()) {
      list.sort((a, b) => String(a.cells[dateField.id]).localeCompare(String(b.cells[dateField.id])));
    }
    return m;
  }, [shown, dateField]);
  const withoutDate = dateField ? shown.filter((r) => !dayKey(r.cells[dateField.id] ?? null)) : [];

  if (!dateField) {
    return (
      <div className="center muted kanban-empty">
        <div>
          <CalendarX2 size={30} />
          <p>Choose a date field to place records on the calendar, using “Date field” in the toolbar.</p>
        </div>
      </div>
    );
  }

  const today = keyOf(new Date());
  const title = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  const drop = (day: string) => {
    const r = records.find((x) => x.id === dragId);
    if (r && editable) {
      const next = moveToDay(r.cells[dateField.id] ?? null, day, !!dateField.options.includeTime);
      if (next !== r.cells[dateField.id]) saveCells(r.id, { [dateField.id]: next });
    }
    setDragId(null);
    setOverDay(null);
  };

  const chip = (r: RecordRow) => {
    const choiceId = colorField ? (r.cells[colorField.id] as string | undefined) : undefined;
    const color = colorField?.options.choices?.find((c) => c.id === choiceId)?.color;
    const tone = color ? CHOICE_COLORS[color] : null;
    const v = r.cells[dateField.id];
    const time = dateField.options.includeTime && typeof v === "string" && v.includes("T")
      ? new Date(v).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : null;
    const name = primary ? cellToText(primary, r.cells[primary.id] ?? null, ctx.labels) : "";
    return (
      <button
        key={r.id}
        className={"cal-chip" + (dragId === r.id ? " dragging" : "")}
        style={tone ? { background: tone.bg, color: tone.fg, borderColor: "transparent" } : undefined}
        draggable={editable}
        onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => { setDragId(null); setOverDay(null); }}
        onClick={(e) => { e.stopPropagation(); ctx.openRecord(r.id); }}
        title={name || "Unnamed record"}
      >
        {time && <span className="cal-time">{time}</span>}
        <span className="cal-name">{name || "Unnamed record"}</span>
      </button>
    );
  };

  return (
    <div className="calendar">
      <div className="cal-head">
        <h2>{title}</h2>
        <div className="cal-nav">
          <button className="icon-btn" title="Previous month" onClick={() => shift(-1)}><ChevronLeft size={18} /></button>
          <button className="btn sm" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)); }}>Today</button>
          <button className="icon-btn" title="Next month" onClick={() => shift(1)}><ChevronRight size={18} /></button>
        </div>
        <div className="spacer" />
        {withoutDate.length > 0 && (
          <button className={"tool" + (undated ? " active-hide" : " warn")} onClick={() => setUndated(!undated)}>
            <CalendarX2 size={15} /> {withoutDate.length} without a date
          </button>
        )}
        {!editable && <span className="muted small">Dates come from a formula, so events can't be dragged.</span>}
      </div>

      <div className="cal-body">
      <div className="cal-grid">
        {WEEKDAYS.map((d) => <div key={d} className="cal-weekday">{d}</div>)}
        {days.map((d) => {
          const k = keyOf(d);
          const list = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div
              key={k}
              className={"cal-day" + (inMonth ? "" : " out") + (k === today ? " today" : "") + (overDay === k ? " over" : "")}
              onDragOver={(e) => { if (dragId && editable) { e.preventDefault(); setOverDay(k); } }}
              onDragLeave={() => setOverDay((o) => (o === k ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(k); }}
            >
              <div className="cal-day-head">
                <span className="cal-date">{d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getDate()}</span>
                {editable && (
                  <button
                    className="cal-add"
                    title="Add a record on this day"
                    onClick={async () => {
                      const rec = await ctx.addRecord({ [dateField.id]: moveToDay(null, k, !!dateField.options.includeTime) });
                      if (rec) ctx.openRecord(rec.id);
                    }}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              <div className="cal-chips">
                {list.slice(0, MAX_CHIPS).map(chip)}
                {list.length > MAX_CHIPS && (
                  <button className="cal-more" onClick={(e) => setMore({ day: k, anchor: anchorOf(e.currentTarget) })}>
                    +{list.length - MAX_CHIPS} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {undated && (
        <aside className="cal-undated">
          <div className="menu-label">Without a date{editable ? " — drag onto a day" : ""}</div>
          <div className="cal-chips">{withoutDate.map(chip)}</div>
          {withoutDate.length === 0 && <div className="panel-empty">Every record has a date.</div>}
        </aside>
      )}
      </div>

      {more && (
        <Popover anchor={more.anchor} onClose={() => setMore(null)} minWidth={240}>
          <div className="menu-label">{new Date(more.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
          <div className="cal-chips pop">{(byDay.get(more.day) ?? []).map(chip)}</div>
        </Popover>
      )}
    </div>
  );
}

export const dateFieldsOf = (fields: Field[]) => fields.filter((f) => isDateLike(f));
