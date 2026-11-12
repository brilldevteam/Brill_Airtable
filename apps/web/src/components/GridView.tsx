import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import { cellToText, COMPUTED_TYPES, FIELD_TYPE_LABELS, orderedFieldIds, type CellValue, type Field } from "@brill/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, EyeOff, Maximize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useDialogs } from "./Dialogs";
import { GRID_ICONS } from "./fieldIcons";
import { AttachmentStrip, AttachmentTiles } from "./AttachmentPicker";
import { gridBadge } from "./attachmentUtils";
import { LinkPicker } from "./LinkPicker";
import { Popover, SelectPicker, type Anchor } from "./Popover";
import type { ViewContext } from "./TableWorkspace";

export const TYPE_ICON: Record<string, string> = {
  singleLineText: "A", longText: "¶", number: "#", checkbox: "☑", singleSelect: "◉",
  multipleSelect: "☰", date: "📅", email: "@", url: "🔗", phone: "☎",
  link: "↗", lookup: "⤷", rollup: "Σ", count: "№", formula: "ƒ",
};
const ROW_HEIGHT = { short: 34, medium: 56, tall: 90 };
const emptySelection: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

export function GridView({ ctx }: { ctx: ViewContext }) {
  const { fields, records, labels, files, view, primaryFieldId, saveCells, updateConfig } = ctx;
  const cfg = view.config;
  const gridRef = useRef<DataEditorRef>(null);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const search = ctx.search;
  const dialogs = useDialogs();
  const [fieldMenu, setFieldMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  const [picker, setPicker] = useState<{ field: Field; recordId: string; anchor: Anchor } | null>(null);
  const [expanded, setExpanded] = useState<{ field: Field; recordId: string } | null>(null);
  // Column widths change continuously while dragging; keep them local and save on a pause.
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});

  // Quick search on top of the view's own filters.
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return records;
    return records.filter((r) => fields.some((f) => cellToText(f, r.cells[f.id] ?? null, labels).toLowerCase().includes(s)));
  }, [records, fields, search, labels]);

  const columns: GridColumn[] = fields.map((f) => ({
    id: f.id,
    title: f.name,
    icon: GRID_ICONS[f.type],
    width: liveWidths[f.id] ?? cfg.columnWidths[f.id] ?? (f.id === primaryFieldId ? 220 : 160),
    hasMenu: true,
  }));

  const getCellContent = useCallback(
    (item: Item): GridCell => {
      const cell = cellFor(item);
      return ctx.canEdit ? cell : ({ ...cell, readonly: true, allowOverlay: false } as GridCell);
    },
    [fields, rows, cfg.rowHeight, labels, files, ctx.canEdit],
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
      if (!f || !r || COMPUTED_TYPES.has(f.type) || f.type === "link") return;
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

  const onDelete = (sel: GridSelection) => {
    if (!ctx.canEdit) return false;
    const rect = sel.current?.range;
    if (!rect) return true;
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      const r = rows[row];
      if (!r) continue;
      const patch: Record<string, CellValue> = {};
      for (let col = rect.x; col < rect.x + rect.width; col++) {
        if (fields[col] && !COMPUTED_TYPES.has(fields[col].type)) patch[fields[col].id] = null;
      }
      if (Object.keys(patch).length === 0) continue;
      saveCells(r.id, patch);
    }
    return false;
  };

  const onCellActivated = ([col, row]: Item) => {
    if (!ctx.canEdit) { const r = rows[row]; if (r) ctx.openRecord(r.id); return; }
    const f = fields[col];
    const r = rows[row];
    if (!f || !r || !["singleSelect", "multipleSelect", "link", "attachment"].includes(f.type)) return;
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
      <div className="grid-area">
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
          rowMarkers="both"
          freezeColumns={1}
          smoothScrollX
          smoothScrollY
          width="100%"
          height="100%"
          rowHeight={ROW_HEIGHT[cfg.rowHeight]}
          headerHeight={38}
          gridSelection={selection}
          onGridSelectionChange={setSelection}
          onColumnResize={onColumnResize}
          onColumnMoved={onColumnMoved}
          onHeaderMenuClick={(col, bounds) => ctx.canEdit && setFieldMenu({ field: fields[col], anchor: bounds })}
          trailingRowOptions={ctx.canEdit ? { hint: "New record", sticky: true, tint: true } : undefined}
          onRowAppended={() => { void ctx.addRecord(); }}
          rightElement={ctx.canDesign ? <button className="add-col" title="Add field" onClick={() => ctx.editField()}><Plus size={16} /></button> : undefined}
          rightElementProps={{ fill: false, sticky: false }}
          theme={GRID_THEME}
        />
      </div>

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
          {ctx.canEdit && <button
            className="btn sm danger"
            onClick={async () => {
              const n = selectedIds.length;
              const ok = await dialogs.confirm({
                title: `Delete ${n} record${n === 1 ? "" : "s"}?`,
                message: "Deleted records are removed from every view and from any links to them.",
                confirmText: "Delete",
                danger: true,
              });
              if (ok) { ctx.deleteRecords(selectedIds); setSelection(emptySelection); }
            }}
          >
            <Trash2 size={14} /> Delete
          </button>}
          <button className="icon-btn" title="Clear selection" onClick={() => setSelection(emptySelection)}><X size={15} /></button>
        </div>
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
          minWidth={picker.field.type === "attachment" ? Math.max(picker.anchor.width + 2, 220) : picker.field.type === "link" ? 300 : 200}
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

