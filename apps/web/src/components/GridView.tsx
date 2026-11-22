import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type FillPatternEventArgs,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import {
  cellToText, COMPUTED_TYPES, FIELD_TYPE_LABELS, fillSeries, groupKey, isNumericField, orderedFieldIds, summarize, SUMMARY_LABELS, summaryKindsFor,
  type CellValue, type Field, type LinkLabels, type RecordRow, type SummaryKind,
} from "@brill/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check, EyeOff, Maximize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useDialogs } from "./Dialogs";
import { CUSTOM_HEADER_ICONS, GRID_ICONS } from "./fieldIcons";
import { AttachmentStrip, AttachmentTiles } from "./AttachmentPicker";
import { gridBadge } from "./attachmentUtils";
import { LinkPicker } from "./LinkPicker";
import { RatingInput, UserPicker } from "./PeoplePicker";
import { Popover, SelectPicker, anchorOf, type Anchor } from "./Popover";
import type { ViewContext } from "./TableWorkspace";

export const TYPE_ICON: Record<string, string> = {
  singleLineText: "A", longText: "¶", number: "#", checkbox: "☑", singleSelect: "◉",
  multipleSelect: "☰", date: "📅", email: "@", url: "🔗", phone: "☎",
  link: "↗", lookup: "⤷", rollup: "Σ", count: "№", formula: "ƒ",
};
const ROW_HEIGHT = { short: 34, medium: 56, tall: 90 };

/** Rating cells: gold stars for the score, light grey for the rest. */
function drawStars(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, max: number, value: number) {
  const size = 13;
  const gap = 3;
  const cy = rect.y + rect.height / 2;
  ctx.save();
  for (let i = 0; i < max; i++) {
    const cx = rect.x + 10 + size / 2 + i * (size + gap);
    if (cx + size / 2 > rect.x + rect.width - 4) break;
    ctx.beginPath();
    for (let p = 0; p < 10; p++) {
      const r = p % 2 === 0 ? size / 2 : size / 4.6;
      const a = -Math.PI / 2 + (p * Math.PI) / 5;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = i < value ? "#f59e0b" : "#e4e4e7";
    ctx.fill();
  }
  ctx.restore();
}
const emptySelection: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

// ---------------- grouping ----------------
type GroupRow = { kind: "group"; depth: number; path: string; label: string; fieldName: string; recs: RecordRow[] };
type DisplayRow = { kind: "rec"; rec: RecordRow } | GroupRow;
const GROUP_BG = ["#f1f1f5", "#f6f6f9", "#fafafc"];

/** Records in view order, with a header row before each group (and nested groups inside). */
function buildRows(recs: RecordRow[], groupFields: Field[], collapsed: Set<string>, labels: LinkLabels, depth = 0, parent = ""): DisplayRow[] {
  if (depth >= groupFields.length) return recs.map((rec) => ({ kind: "rec", rec }));
  const f = groupFields[depth];
  const groups = new Map<string, { label: string; recs: RecordRow[] }>();
  for (const r of recs) {
    const [key, label] = groupKey(f, r.cells[f.id] ?? null, labels);
    const g = groups.get(key) ?? { label, recs: [] };
    g.recs.push(r);
    groups.set(key, g);
  }
  const out: DisplayRow[] = [];
  for (const [key, g] of groups) {
    const path = `${parent}/${f.id}:${key}`;
    out.push({ kind: "group", depth, path, label: g.label, fieldName: f.name, recs: g.recs });
    if (!collapsed.has(path)) out.push(...buildRows(g.recs, groupFields, collapsed, labels, depth + 1, path));
  }
  return out;
}

const FONT = '"Instrument Sans", ui-sans-serif, system-ui, sans-serif';
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** First cell of a group header row: chevron, field name, value and a count. */
function drawGroupHeader(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, g: GroupRow, isCollapsed: boolean) {
  ctx.save();
  const cy = rect.y + rect.height / 2;
  let x = rect.x + 10 + g.depth * 14;
  // chevron
  ctx.strokeStyle = "#71717a";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (isCollapsed) { ctx.moveTo(x + 2, cy - 4); ctx.lineTo(x + 6, cy); ctx.lineTo(x + 2, cy + 4); }
  else { ctx.moveTo(x, cy - 2); ctx.lineTo(x + 4, cy + 2); ctx.lineTo(x + 8, cy - 2); }
  ctx.stroke();
  x += 16;
  const right = rect.x + rect.width - 8;
  ctx.textBaseline = "middle";
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = "#8b8b95";
  const name = fit(ctx, g.fieldName.toUpperCase(), Math.max(0, right - x - 60));
  ctx.fillText(name, x, cy - 7);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = g.label === "(Empty)" ? "#8b8b95" : "#18181b";
  const count = String(g.recs.length);
  ctx.font = `600 11px ${FONT}`;
  const pillW = ctx.measureText(count).width + 12;
  ctx.font = `600 13px ${FONT}`;
  const label = fit(ctx, g.label, Math.max(0, right - x - pillW - 8));
  ctx.fillText(label, x, cy + 7);
  const lw = ctx.measureText(label).width;
  // count pill
  const px = x + lw + 8;
  ctx.fillStyle = "#e4e4e9";
  ctx.beginPath();
  ctx.roundRect(px, cy + 7 - 8, pillW, 16, 8);
  ctx.fill();
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = "#52525b";
  ctx.fillText(count, px + 6, cy + 7.5);
  ctx.restore();
}

/** Other cells of a group header row: that column's summary for the group. */
function drawGroupSummary(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, label: string, value: string, right: boolean) {
  if (!value) return;
  ctx.save();
  ctx.textBaseline = "middle";
  const cy = rect.y + rect.height / 2;
  ctx.font = `600 12.5px ${FONT}`;
  const v = fit(ctx, value, rect.width - 20);
  const vw = ctx.measureText(v).width;
  ctx.font = `500 10.5px ${FONT}`;
  const l = label.toUpperCase();
  const lw = ctx.measureText(l).width;
  const total = lw + 6 + vw;
  const x0 = right ? rect.x + rect.width - 10 - total : rect.x + 10;
  if (total < rect.width - 16) {
    ctx.fillStyle = "#a1a1aa";
    ctx.fillText(l, x0, cy + 0.5);
  }
  ctx.font = `600 12.5px ${FONT}`;
  ctx.fillStyle = "#3f3f46";
  ctx.fillText(v, total < rect.width - 16 ? x0 + lw + 6 : right ? rect.x + rect.width - 10 - vw : rect.x + 10, cy);
  ctx.restore();
}

export function GridView({ ctx }: { ctx: ViewContext }) {
  const { fields, records, labels, files, view, primaryFieldId, saveCells, updateConfig } = ctx;
  const cfg = view.config;
  const gridRef = useRef<DataEditorRef>(null);
  const gridAreaRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const search = ctx.search;
  const dialogs = useDialogs();
  const [fieldMenu, setFieldMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  const [picker, setPicker] = useState<{ field: Field; recordId: string; anchor: Anchor } | null>(null);
  const [expanded, setExpanded] = useState<{ field: Field; recordId: string } | null>(null);
  // Column widths change continuously while dragging; keep them local and save on a pause.
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});

  // Quick search on top of the view's own filters.
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return records;
    return records.filter((r) => fields.some((f) => cellToText(f, r.cells[f.id] ?? null, labels).toLowerCase().includes(s)));
  }, [records, fields, search, labels]);

  // Grouping: header rows between records. Collapsed groups are remembered per view, in this browser.
  const groupFields = cfg.groupBy.map((g) => ctx.allFields.find((f) => f.id === g.fieldId)).filter((f): f is Field => !!f);
  const collapseKey = `brill.grid.collapsed.${view.id}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(collapseKey) ?? "[]")); } catch { return new Set(); }
  });
  const toggleGroup = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try { localStorage.setItem(collapseKey, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  };
  const items = useMemo(() => buildRows(visible, groupFields, collapsed, labels), [visible, cfg.groupBy, ctx.allFields, collapsed, labels]);
  const grouped = groupFields.length > 0;
  /** The record on each grid row (undefined for group header rows). */
  const rows = useMemo(() => items.map((it) => (it.kind === "rec" ? it.rec : undefined)), [items]);

  const columns: GridColumn[] = fields.map((f) => ({
    id: f.id,
    title: f.options.editAccess && f.options.editAccess !== "all" ? `${f.name}  🔒` : f.name,
    icon: GRID_ICONS[f.type],
    width: liveWidths[f.id] ?? cfg.columnWidths[f.id] ?? (f.id === primaryFieldId ? 220 : 160),
    hasMenu: true,
  }));

  const getCellContent = useCallback(
    (item: Item): GridCell => {
      const it = items[item[1]];
      if (it?.kind === "group") {
        return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true };
      }
      const cell = cellFor(item);
      const f = fields[item[0]];
      if (ctx.canEdit && f && ctx.canEditField(f)) return cell;
      // Locked fields can still be opened (to read long text, play a reel...), just not changed.
      if (ctx.canEdit && f && (f.type === "attachment" || f.type === "longText")) return { ...cell, readonly: true } as GridCell;
      return { ...cell, readonly: true, allowOverlay: false } as GridCell;
    },
    [fields, rows, items, cfg.rowHeight, labels, files, ctx.canEdit, ctx.canEditField],
  );
  const cellFor = useCallback(
    ([col, row]: Item): GridCell => {
      const f = fields[col];
      const r = rows[row];
      const v = r?.cells[f.id] ?? null;
      switch (f.type) {
        case "attachment": {
          const ids = (v as string[] | null) ?? [];
          return {
            kind: GridCellKind.Image,
            data: ids.map((id) => files[id]?.thumbUrl ?? gridBadge(files[id])),
            allowOverlay: false,
            readonly: false, // must stay false so double-click opens the upload popover
            rounding: 4,
          };
        }
        case "link":
          return { kind: GridCellKind.Bubble, data: cellToText(f, v, labels).split(", ").filter(Boolean), allowOverlay: false };
        case "lookup":
          return { kind: GridCellKind.Bubble, data: Array.isArray(v) ? v : [], allowOverlay: false };
        case "formula": {
          const rt = f.options.resultType;
          if (rt === "boolean") return { kind: GridCellKind.Boolean, data: v === true, allowOverlay: false, readonly: true };
          const text = cellToText(f, v);
          if (rt === "number" && typeof v === "number") {
            return { kind: GridCellKind.Number, data: v, displayData: text, allowOverlay: false, readonly: true, contentAlign: "right" };
          }
          return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, allowWrapping: cfg.rowHeight !== "short" };
        }
        case "count":
        case "rollup": {
          const text = cellToText(f, v);
          return typeof v === "number"
            ? { kind: GridCellKind.Number, data: v, displayData: text, allowOverlay: false, readonly: true, contentAlign: "right" }
            : { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true };
        }
        case "number": {
          const p = f.options.precision ?? 0;
          return {
            kind: GridCellKind.Number, data: typeof v === "number" ? v : undefined, allowOverlay: true, contentAlign: "right",
            displayData: typeof v === "number" ? v.toLocaleString(undefined, { minimumFractionDigits: p, maximumFractionDigits: p }) : "",
          };
        }
        case "currency":
        case "percent":
          return {
            kind: GridCellKind.Number, data: typeof v === "number" ? v : undefined, allowOverlay: true, contentAlign: "right",
            displayData: cellToText(f, v),
          };
        case "rating":
          // Stars; Enter or double-click opens the star picker. Typing/pasting a number also works.
          return { kind: GridCellKind.Text, data: typeof v === "number" ? String(v) : "", displayData: cellToText(f, v), allowOverlay: false };
        case "duration":
          return { kind: GridCellKind.Text, data: cellToText(f, v), displayData: cellToText(f, v), allowOverlay: true, contentAlign: "right" };
        case "autonumber":
          return { kind: GridCellKind.Number, data: typeof v === "number" ? v : undefined, displayData: cellToText(f, v), allowOverlay: false, readonly: true, contentAlign: "right" };
        case "createdTime":
        case "lastModifiedTime": {
          const text = cellToText(f, v);
          return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true };
        }
        case "user":
        case "createdBy":
        case "lastModifiedBy":
          return {
            kind: GridCellKind.Bubble, data: cellToText(f, v, labels).split(", ").filter(Boolean), allowOverlay: false,
            ...(f.type === "user" ? {} : { readonly: true }),
          } as GridCell;
        case "checkbox":
          return { kind: GridCellKind.Boolean, data: v === true, allowOverlay: false };
        case "singleSelect":
        case "multipleSelect":
          return { kind: GridCellKind.Bubble, data: cellToText(f, v).split(", ").filter(Boolean), allowOverlay: false };
        case "date": {
          const s = typeof v === "string" ? v : "";
          const display = !s ? "" : f.options.includeTime ? new Date(s).toLocaleString() : new Date(s + "T00:00:00").toLocaleDateString();
          return { kind: GridCellKind.Text, data: s, displayData: display, allowOverlay: true };
        }
        case "url":
          return { kind: GridCellKind.Uri, data: typeof v === "string" ? v : "", allowOverlay: true };
        default: {
          const s = v === null ? "" : String(v);
          return { kind: GridCellKind.Text, data: s, displayData: s, allowOverlay: true, allowWrapping: cfg.rowHeight !== "short" };
        }
      }
    },
    [fields, rows, cfg.rowHeight, labels, files],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      const f = fields[col];
      const r = rows[row];
      if (!f || !r || COMPUTED_TYPES.has(f.type) || f.type === "link" || !ctx.canEditField(f)) return;
      let value: unknown;
      if (cell.kind === GridCellKind.Number) value = cell.data ?? null;
      else if (cell.kind === GridCellKind.Boolean) value = cell.data === true;
      else if (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Uri) value = cell.data;
      else return;
      if (value === "" || value === false) value = null;
      saveCells(r.id, { [f.id]: value as CellValue });
    },
    [fields, rows, saveCells],
  );

  const selectedIds = selection.rows.toArray().map((i) => rows[i]?.id).filter(Boolean) as string[];

  /**
   * Drag-to-fill down (or up): dates, numbered text and number steps continue as a series
   * (see fillSeries); other values repeat. Sideways fills keep the grid's plain copy.
   */
  const onFillPattern = ({ patternSource: src, fillDestination: dest, preventDefault }: FillPatternEventArgs) => {
    if (dest.x !== src.x || dest.width !== src.width || dest.height <= src.height) return;
    preventDefault();
    if (!ctx.canEdit) return;
    const up = dest.y < src.y;
    const sourceRecs = rows.slice(src.y, src.y + src.height).filter((r): r is RecordRow => !!r);
    const targetRows: number[] = [];
    if (up) for (let y = src.y - 1; y >= dest.y; y--) targetRows.push(y);
    else for (let y = src.y + src.height; y < dest.y + dest.height; y++) targetRows.push(y);
    const targets = targetRows.map((y) => rows[y]).filter((r): r is RecordRow => !!r);
    if (!sourceRecs.length || !targets.length) return;
    const patches = new Map<string, Record<string, CellValue>>();
    for (let col = src.x; col < src.x + src.width; col++) {
      const f = fields[col];
      if (!f || COMPUTED_TYPES.has(f.type) || f.type === "link" || f.type === "attachment" || !ctx.canEditField(f)) continue;
      const vals = sourceRecs.map((r) => r.cells[f.id] ?? null);
      const out = fillSeries(f, up ? [...vals].reverse() : vals, targets.length, up ? -1 : 1);
      targets.forEach((r, i) => {
        const p = patches.get(r.id) ?? {};
        p[f.id] = out[i] ?? null;
        patches.set(r.id, p);
      });
    }
    for (const [id, patch] of patches) saveCells(id, patch);
    // Show the filled range as the new selection, like a spreadsheet.
    setSelection((sel) => ({ ...sel, current: sel.current && { ...sel.current, range: dest, rangeStack: [] } }));
  };

  const deleteSelectedRecords = async (ids: string[]) => {
    if (!ctx.canDeleteRecords || ids.length === 0) return;
    const n = ids.length;
    const ok = await dialogs.confirm({
      title: `Delete ${n} record${n === 1 ? "" : "s"}?`,
      message: "They move to the Trash (⋯ → Trash) for 30 days, and you can undo straight away with Ctrl+Z.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) { void ctx.deleteRecords(ids); setSelection(emptySelection); }
  };

  // Right-click on a record: act on it (or on all selected records, if it's one of them).
  const [rowMenu, setRowMenu] = useState<{ ids: string[]; anchor: Anchor } | null>(null);
  const onCellContextMenu = ([, row]: Item, e: { bounds: Anchor; localEventX: number; localEventY: number; preventDefault: () => void }) => {
    e.preventDefault();
    const r = rows[row];
    if (!r) return;
    let ids = selectedIds;
    if (!selection.rows.hasIndex(row)) {
      ids = [r.id];
      if (selection.rows.length) setSelection({ ...emptySelection, rows: CompactSelection.fromSingleSelection(row) });
    }
    setRowMenu({ ids, anchor: { x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY, width: 0, height: 0 } });
  };

  const onDelete = (sel: GridSelection) => {
    if (!ctx.canEdit) return false;
    // Whole records selected (row checkboxes): Delete removes the records, after asking.
    if (sel.rows.length > 0) {
      void deleteSelectedRecords(sel.rows.toArray().map((i) => rows[i]?.id).filter(Boolean) as string[]);
      return false;
    }
    const rect = sel.current?.range;
    if (!rect) return true;
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      const r = rows[row];
      if (!r) continue;
      const patch: Record<string, CellValue> = {};
      for (let col = rect.x; col < rect.x + rect.width; col++) {
        if (fields[col] && !COMPUTED_TYPES.has(fields[col].type) && ctx.canEditField(fields[col])) patch[fields[col].id] = null;
      }
      if (Object.keys(patch).length === 0) continue;
      saveCells(r.id, patch);
    }
    return false;
  };

  const onCellActivated = ([col, row]: Item) => {
    const it = items[row];
    if (it?.kind === "group") return toggleGroup(it.path);
    if (!ctx.canEdit) { const r = rows[row]; if (r) ctx.openRecord(r.id); return; }
    const f = fields[col];
    const r = rows[row];
    if (!f || !r || !["singleSelect", "multipleSelect", "link", "attachment", "rating", "user"].includes(f.type)) return;
    if (!ctx.canEditField(f) && f.type !== "attachment") return;
    const b = gridRef.current?.getBounds(col, row);
    if (b) setPicker({ field: f, recordId: r.id, anchor: b });
  };

  const widthTimer = useRef<number>();
  const onColumnResize = (c: GridColumn, w: number) => {
    setLiveWidths((s) => ({ ...s, [c.id!]: w }));
    window.clearTimeout(widthTimer.current);
    widthTimer.current = window.setTimeout(() => {
      setLiveWidths((s) => {
        updateConfig({ columnWidths: { ...cfg.columnWidths, ...s } });
        return {};
      });
    }, 400);
  };

  const onColumnMoved = (from: number, to: number) => {
    if (from === 0 || to === 0) return; // the primary field stays first
    const visible = fields.map((f) => f.id);
    const moved = visible[from];
    const target = visible[to];
    const full = orderedFieldIds(cfg, ctx.allFields.map((f) => f.id), primaryFieldId).filter((id) => id !== moved);
    const idx = full.indexOf(target);
    full.splice(to > from ? idx + 1 : idx, 0, moved);
    updateConfig({ fieldOrder: full });
  };

  const pickerRecord = picker && records.find((r) => r.id === picker.recordId);

  return (
    <div className="grid-wrap">
      <div className="grid-area" ref={gridAreaRef}>
        <DataEditor
          ref={gridRef}
          columns={columns}
          rows={rows.length}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          onCellActivated={onCellActivated}
          onDelete={onDelete}
          getCellsForSelection={true}
          onPaste={true}
          fillHandle={true}
          onFillPattern={onFillPattern}
          onCellContextMenu={onCellContextMenu}
          rowSelectionMode="multi"
          rowMarkers={grouped ? "checkbox" : "both"}
          rowMarkerWidth={grouped ? 40 : 52}
          onCellClicked={([, row]) => { const it = items[row]; if (it?.kind === "group") toggleGroup(it.path); }}
          getRowThemeOverride={(row) => {
            const it = items[row];
            if (it?.kind !== "group") return undefined;
            const bg = GROUP_BG[Math.min(it.depth, GROUP_BG.length - 1)];
            return { bgCell: bg, bgCellMedium: bg };
          }}
          freezeColumns={1}
          smoothScrollX
          smoothScrollY
          width="100%"
          height="100%"
          rowHeight={(row) => (items[row]?.kind === "group" ? 40 : ROW_HEIGHT[cfg.rowHeight])}
          headerHeight={38}
          gridSelection={selection}
          onGridSelectionChange={(sel) => {
            // Group header rows can't be selected as records.
            if (grouped && sel.rows.length) {
              let rowsSel = sel.rows;
              items.forEach((it, i) => { if (it.kind === "group" && rowsSel.hasIndex(i)) rowsSel = rowsSel.remove(i); });
              sel = { ...sel, rows: rowsSel };
            }
            setSelection(sel);
          }}
          onColumnResize={onColumnResize}
          onColumnMoved={onColumnMoved}
          onHeaderMenuClick={(col, bounds) => ctx.canEdit && setFieldMenu({ field: fields[col], anchor: bounds })}
          trailingRowOptions={ctx.canAddRecords ? { hint: "New record", sticky: true, tint: true } : undefined}
          onRowAppended={() => { void ctx.addRecord(); }}
          rightElement={ctx.canDesign ? <button className="add-col" title="Add field" onClick={() => ctx.editField()}><Plus size={16} /></button> : undefined}
          rightElementProps={{ fill: false, sticky: false }}
          theme={GRID_THEME}
          headerIcons={CUSTOM_HEADER_ICONS}
          drawCell={(args, drawContent) => {
            const it = items[args.row];
            if (it?.kind === "group") {
              const f = fields[args.col];
              if (args.col === 0) return drawGroupHeader(args.ctx, args.rect, it, collapsed.has(it.path));
              const kind = f && cfg.summaries[f.id];
              if (f && kind && kind !== "none") {
                drawGroupSummary(args.ctx, args.rect, SUMMARY_LABELS[kind], summarize(f, it.recs.map((r) => r.cells[f.id] ?? null), kind, labels), isNumericField(f));
              }
              return;
            }
            const f = fields[args.col];
            if (f?.type !== "rating") return drawContent();
            const v = rows[args.row]?.cells[f.id];
            drawStars(args.ctx, args.rect, f.options.max ?? 5, typeof v === "number" ? v : 0);
          }}
        />
      </div>
      <SummaryBar
        ctx={ctx}
        columns={columns}
        recordsShown={visible}
        markerWidth={grouped ? 40 : 52}
        gridWrap={gridAreaRef}
      />

      {expanded && (() => {
        const rec = records.find((r) => r.id === expanded.recordId);
        if (!rec) return null;
        const primary = ctx.allFields.find((f) => f.id === primaryFieldId);
        return (
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setExpanded(null)}>
            <div className="modal att-expanded">
              <div className="modal-head">
                <div>
                  <h3>{expanded.field.name}</h3>
                  <p className="modal-sub">{primary ? cellToText(primary, rec.cells[primary.id] ?? null) || "Unnamed record" : ""}</p>
                </div>
                <div className="spacer" />
                <button className="icon-btn" title="Close" onClick={() => setExpanded(null)}><X size={18} /></button>
              </div>
              <AttachmentTiles
                tableId={ctx.tableId}
                value={(rec.cells[expanded.field.id] as string[] | undefined) ?? []}
                files={files}
                onFiles={ctx.addFiles}
                onChange={(ids) => saveCells(rec.id, { [expanded.field.id]: ids.length ? ids : null })}
              />
            </div>
          </div>
        );
      })()}

      {selectedIds.length > 0 && (
        <div className="selection-bar">
          <span className="label">{selectedIds.length} selected</span>
          {selectedIds.length === 1 && (
            <button className="btn sm" onClick={() => ctx.openRecord(selectedIds[0])}><Maximize2 size={14} /> Expand</button>
          )}
          {ctx.canDeleteRecords && <button className="btn sm danger" onClick={() => deleteSelectedRecords(selectedIds)}>
            <Trash2 size={14} /> Delete
          </button>}
          <button className="icon-btn" title="Clear selection" onClick={() => setSelection(emptySelection)}><X size={15} /></button>
        </div>
      )}

      {rowMenu && (
        <Popover anchor={rowMenu.anchor} onClose={() => setRowMenu(null)} minWidth={230}>
          <div className="menu">
            {rowMenu.ids.length === 1 && (
              <button onClick={() => { ctx.openRecord(rowMenu.ids[0]); setRowMenu(null); }}><Maximize2 size={15} /> Expand record</button>
            )}
            {rowMenu.ids.length > 1 && <div className="menu-label">{rowMenu.ids.length} records selected</div>}
            <button onClick={() => { setSelection(emptySelection); setRowMenu(null); }}><X size={15} /> Clear selection</button>
            {ctx.canDeleteRecords && (
              <><hr />
                <button className="danger" onClick={() => { const ids = rowMenu.ids; setRowMenu(null); void deleteSelectedRecords(ids); }}>
                  <Trash2 size={15} /> {rowMenu.ids.length === 1 ? "Delete record" : `Delete all ${rowMenu.ids.length} selected records`}
                </button>
              </>
            )}
          </div>
        </Popover>
      )}

      {fieldMenu && (
        <Popover anchor={fieldMenu.anchor} onClose={() => setFieldMenu(null)}>
          <div className="menu">
            <div className="menu-label">{fieldMenu.field.name} · {FIELD_TYPE_LABELS[fieldMenu.field.type]}</div>
            {ctx.canDesign && <button onClick={() => { ctx.editField(fieldMenu.field); setFieldMenu(null); }}><Pencil size={15} /> Edit field</button>}
            <button onClick={() => { updateConfig({ sorts: [{ fieldId: fieldMenu.field.id, direction: "asc" }] }); setFieldMenu(null); }}><ArrowUpNarrowWide size={15} /> Sort first → last</button>
            <button onClick={() => { updateConfig({ sorts: [{ fieldId: fieldMenu.field.id, direction: "desc" }] }); setFieldMenu(null); }}><ArrowDownWideNarrow size={15} /> Sort last → first</button>
            {fieldMenu.field.id !== primaryFieldId && (
              <><hr />
                <button onClick={() => { updateConfig({ hiddenFieldIds: [...cfg.hiddenFieldIds, fieldMenu.field.id] }); setFieldMenu(null); }}><EyeOff size={15} /> Hide field</button><hr />
                {ctx.canDesign && <button className="danger" onClick={() => { const f = fieldMenu.field; setFieldMenu(null); ctx.deleteField(f); }}><Trash2 size={15} /> Delete field</button>}
              </>
            )}
          </div>
        </Popover>
      )}

      {picker && pickerRecord && (
        <Popover
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          cover={picker.field.type === "attachment"}
          className={picker.field.type === "attachment" ? "att-cell-pop" : ""}
          minWidth={picker.field.type === "attachment" ? Math.max(picker.anchor.width + 2, 220) : picker.field.type === "link" || picker.field.type === "user" ? 280 : picker.field.type === "rating" ? 0 : 200}
        >
          {picker.field.type === "attachment" ? (
            <AttachmentStrip
              tableId={ctx.tableId}
              value={(pickerRecord.cells[picker.field.id] as string[] | undefined) ?? []}
              files={files}
              onFiles={ctx.addFiles}
              onChange={(ids) => saveCells(picker.recordId, { [picker.field.id]: ids.length ? ids : null })}
              onExpand={() => { setExpanded({ field: picker.field, recordId: picker.recordId }); setPicker(null); }}
            />
          ) : picker.field.type === "rating" ? (
            <div className="rating-pop">
              <RatingInput
                max={picker.field.options.max ?? 5}
                size={22}
                value={(pickerRecord.cells[picker.field.id] as number | undefined) ?? null}
                onChange={(n) => { saveCells(picker.recordId, { [picker.field.id]: n }); setPicker(null); }}
              />
            </div>
          ) : picker.field.type === "user" ? (
            <UserPicker
              field={picker.field}
              value={(pickerRecord.cells[picker.field.id] ?? null) as CellValue}
              onChange={(ids) => {
                saveCells(picker.recordId, { [picker.field.id]: ids });
                if (!picker.field.options.multiple) setPicker(null);
              }}
            />
          ) : picker.field.type === "link" ? (
            <LinkPicker
              field={picker.field}
              value={(pickerRecord.cells[picker.field.id] as string[] | undefined) ?? []}
              labels={labels}
              onChange={(ids) => saveCells(picker.recordId, { [picker.field.id]: ids.length ? ids : null })}
            />
          ) : (
          <SelectPicker
            field={picker.field}
            value={(pickerRecord.cells[picker.field.id] ?? null) as CellValue}
            onChange={(v) => {
              saveCells(picker.recordId, { [picker.field.id]: v });
              if (picker.field.type === "singleSelect") setPicker(null);
            }}
          />
          )}
        </Popover>
      )}
    </div>
  );
}

/** Grid colours and type matched to the app's design tokens. */
const GRID_THEME = {
  accentColor: "#4f46e5",
  accentFg: "#ffffff",
  accentLight: "rgba(79, 70, 229, 0.08)",
  textDark: "#18181b",
  textMedium: "#52525b",
  textLight: "#8b8b95",
  textBubble: "#3f3f46",
  bgIconHeader: "#8b8b95",
  fgIconHeader: "#ffffff",
  textHeader: "#3f3f46",
  textHeaderSelected: "#ffffff",
  bgCell: "#ffffff",
  bgCellMedium: "#fafafb",
  bgHeader: "#fafafb",
  bgHeaderHasFocus: "#f1f1f4",
  bgHeaderHovered: "#f3f3f6",
  bgBubble: "#f1f1f4",
  bgBubbleSelected: "#ffffff",
  bgSearchResult: "#fef3c7",
  borderColor: "rgba(16, 24, 40, 0.07)",
  horizontalBorderColor: "rgba(16, 24, 40, 0.06)",
  drilldownBorder: "rgba(0, 0, 0, 0)",
  linkColor: "#4f46e5",
  cellHorizontalPadding: 10,
  cellVerticalPadding: 4,
  headerFontStyle: "600 12.5px",
  baseFontStyle: "13.5px",
  markerFontStyle: "11px",
  fontFamily: '"Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  editorFontSize: "13.5px",
  lineHeight: 1.45,
  headerIconSize: 16,
  roundingRadius: 6,
};


/**
 * The bar under the grid: one summary per column (Sum, Average, Earliest, Filled…), chosen per view.
 * It's plain HTML kept in line with the grid's columns and horizontal scroll.
 */
function SummaryBar({ ctx, columns, recordsShown, markerWidth, gridWrap }: {
  ctx: ViewContext; columns: GridColumn[]; recordsShown: RecordRow[]; markerWidth: number; gridWrap: RefObject<HTMLDivElement>;
}) {
  const { fields, view, updateConfig, labels } = ctx;
  const [scrollLeft, setScrollLeft] = useState(0);
  const [menu, setMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  useEffect(() => {
    // Scroll events don't bubble, but they can be caught on the way down — so this works even
    // though the grid creates its scroller after we mount.
    const wrap = gridWrap.current;
    if (!wrap) return;
    const on = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains("dvn-scroller")) setScrollLeft(t.scrollLeft);
    };
    wrap.addEventListener("scroll", on, { capture: true, passive: true });
    const el = wrap.querySelector<HTMLElement>(".dvn-scroller");
    if (el) setScrollLeft(el.scrollLeft);
    return () => wrap.removeEventListener("scroll", on, { capture: true });
  }, [gridWrap]);

  const widths = columns.map((c) => ("width" in c ? c.width : 160));
  const summaries = view.config.summaries;
  const cell = (f: Field, w: number) => {
    const kind = summaries[f.id] ?? "none";
    const value = kind === "none" ? "" : summarize(f, recordsShown.map((r) => r.cells[f.id] ?? null), kind, labels);
    const num = isNumericField(f);
    return (
      <button
        key={f.id}
        className={"sb-cell" + (kind === "none" ? " empty" : "") + (num ? " num" : "")}
        style={{ width: w }}
        disabled={!ctx.canEdit}
        title={ctx.canEdit ? `Summarize ${f.name}` : undefined}
        onClick={(e) => setMenu({ field: f, anchor: anchorOf(e.currentTarget) })}
      >
        {kind === "none" ? <span className="sb-hint">Summarize ▾</span> : <><span className="sb-label">{SUMMARY_LABELS[kind]}</span> <b>{value}</b></>}
      </button>
    );
  };
  const [first, ...rest] = fields;
  return (
    <div className="summary-bar">
      <div className="sb-frozen" style={{ width: markerWidth + (widths[0] ?? 0) }}>
        <span className="sb-count">{recordsShown.length} {recordsShown.length === 1 ? "record" : "records"}</span>
        {first && summaries[first.id] && summaries[first.id] !== "none" && (
          <button className="sb-cell" onClick={(e) => setMenu({ field: first, anchor: anchorOf(e.currentTarget) })}>
            <span className="sb-label">{SUMMARY_LABELS[summaries[first.id]]}</span>{" "}
            <b>{summarize(first, recordsShown.map((r) => r.cells[first.id] ?? null), summaries[first.id], labels)}</b>
          </button>
        )}
        {first && (!summaries[first.id] || summaries[first.id] === "none") && ctx.canEdit && (
          <button className="sb-cell empty" onClick={(e) => setMenu({ field: first, anchor: anchorOf(e.currentTarget) })}><span className="sb-hint">Summarize ▾</span></button>
        )}
      </div>
      {/* The track moves with the grid; never let the browser scroll this strip on its own (e.g. on focus). */}
      <div className="sb-scroll" onScroll={(e) => { e.currentTarget.scrollLeft = 0; }} onMouseDown={(e) => e.preventDefault()}>
        <div className="sb-track" style={{ transform: `translateX(${-scrollLeft}px)` }}>
          {rest.map((f, i) => cell(f, widths[i + 1]))}
        </div>
      </div>
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} minWidth={190}>
          <div className="menu">
            <div className="menu-label">Summarize {menu.field.name}</div>
            {summaryKindsFor(menu.field).map((k: SummaryKind) => (
              <button
                key={k}
                onClick={() => {
                  const next = { ...summaries };
                  if (k === "none") delete next[menu.field.id];
                  else next[menu.field.id] = k;
                  updateConfig({ summaries: next });
                  setMenu(null);
                }}
              >
                <span className="check">{(summaries[menu.field.id] ?? "none") === k && <Check size={15} />}</span>
                {SUMMARY_LABELS[k]}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
