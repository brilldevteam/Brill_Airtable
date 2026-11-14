import {
  COMPUTED_TYPES, orderedFieldIds, type AttachmentInfo, type CellValue, type Field, type LinkLabels, type RecordRow, type TableDetail, type View,
  type ViewConfig, type ViewRecords, type EditAccess, type Table,
} from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type FieldInput } from "../api";
import { useDialogs } from "./Dialogs";
import { FieldDialog } from "./FieldDialog";
import { CalendarView } from "./CalendarView";
import { FormBuilderView } from "./FormBuilderView";
import { GalleryView } from "./GalleryView";
import { GridView } from "./GridView";
import { KanbanView } from "./KanbanView";
import { RecordModal } from "./RecordModal";
import { ViewSidebar } from "./ViewSidebar";
import { ViewToolbar } from "./ViewToolbar";

/** Everything a view component needs to read and change data. */
export interface ViewContext {
  tableId: string;
  view: View;
  allFields: Field[];
  /** Visible fields in display order (primary first). */
  fields: Field[];
  primaryFieldId: string | null;
  records: RecordRow[];
  /** Display names of linked records. */
  labels: LinkLabels;
  /** Quick search text from the toolbar (applied on top of the view's filters). */
  search: string;
  setSearch: (s: string) => void;
  /** Details of attachments shown in this view. */
  files: Record<string, AttachmentInfo>;
  /** Add uploaded/renamed files to this view's cache so cells show them straight away. */
  addFiles: (infos: AttachmentInfo[]) => void;
  /** What the signed-in user may do here (the server enforces the same rules). */
  canEdit: boolean;
  /** Invited to this base only (e.g. a client), not a workspace member. */
  guest: boolean;
  /** May the user change this field's values? (role + the field's "who can edit" lock) */
  canEditField: (field: Field) => boolean;
  canAddRecords: boolean;
  canDeleteRecords: boolean;
  canDesign: boolean;
  canComment: boolean;
  /** Reload fields and records (after imports etc.). */
  refresh: () => void;
  saveCells: (recordId: string, patch: Record<string, CellValue>) => void;
  addRecord: (cells?: Record<string, CellValue>) => Promise<RecordRow | undefined>;
  deleteRecords: (ids: string[]) => Promise<void>;
  updateConfig: (patch: Partial<ViewConfig>) => void;
  openRecord: (id: string) => void;
  editField: (field?: Field) => void;
  deleteField: (field: Field) => void;
}

/** Config keys that change which records are shown or their order. */
const QUERY_KEYS: (keyof ViewConfig)[] = ["filters", "sorts"];

/** Does this role pass a field's or table's edit restriction? (Mirrors the server's check.) */
export function accessAllows(role: string, guest: boolean, rule: EditAccess | undefined) {
  if (!["owner", "creator", "editor"].includes(role)) return false;
  if (role === "owner" && !guest) return true;
  if (rule === "creators") return role === "owner" || role === "creator";
  if (rule === "team") return !guest;
  return true;
}

export function TableWorkspace({ baseId, tableId, tables, role, guest }: {
  baseId: string; tableId: string; tables: Table[]; role: string; guest: boolean;
}) {
  const canEdit = ["owner", "creator", "editor"].includes(role);
  const recordAccess = tables.find((t) => t.id === tableId)?.recordAccess ?? "all";
  const canAddRecords = accessAllows(role, guest, recordAccess);
  const canEditField = (f: Field) => accessAllows(role, guest, f.options.editAccess);
  const canDesign = ["owner", "creator"].includes(role);
  const canComment = role !== "read";
  const { viewId: viewParam } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const schemaKey = ["table", tableId];
  const schema = useQuery({ queryKey: schemaKey, queryFn: () => api.table(tableId) });
  const views = schema.data?.views ?? [];
  const view = views.find((v) => v.id === viewParam) ?? views[0];
  const recordsKey = ["viewRecords", view?.id];
  const recordsQ = useQuery({ queryKey: recordsKey, queryFn: () => api.viewRecords(view!.id), enabled: !!view });

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ field?: Field } | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const dialogs = useDialogs();

  // Keep the URL pointing at a real view.
  useEffect(() => {
    if (view && view.id !== viewParam) nav(`/base/${baseId}/${tableId}/${view.id}`, { replace: true });
  }, [view?.id, viewParam]);

  const fail = (e: unknown) => {
    setError((e as Error).message);
    qc.invalidateQueries({ queryKey: recordsKey });
  };

  // After edits, re-run the view query (debounced) so filters and sorts re-apply.
  const refetchTimer = useRef<number>();
  const scheduleRefetch = () => {
    window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => qc.invalidateQueries({ queryKey: ["viewRecords", view?.id] }), 800);
  };

  const setRecords = (fn: (r: RecordRow[]) => RecordRow[], labels?: LinkLabels) =>
    qc.setQueryData<ViewRecords>(recordsKey, (d) => (d ? { ...d, records: fn(d.records), labels: { ...d.labels, ...labels } } : d));

  const saveCells: ViewContext["saveCells"] = (recordId, patch) => {
    setError(null);
    setRecords((rs) => rs.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, ...patch } } : r)));
    api.updateRecord(recordId, patch).then(({ record }) => {
      setRecords((rs) => rs.map((r) => (r.id === recordId ? record : r)));
      // Links and calculated fields can change other records (here and in other tables):
      // mark every other view stale, and refresh this one when it could be affected.
      const fields = schema.data?.fields ?? [];
      const touchesLinks = Object.keys(patch).some((id) => fields.find((f) => f.id === id)?.type === "link");
      const hasComputed = fields.some((f) => COMPUTED_TYPES.has(f.type) || f.type === "link");
      qc.invalidateQueries({ queryKey: ["viewRecords"], refetchType: "none" });
      if (view && (touchesLinks || hasComputed || view.config.filters.conditions.length || view.config.sorts.length)) scheduleRefetch();
    }, fail);
  };

  const addRecord: ViewContext["addRecord"] = async (cells = {}) => {
    try {
      const { record } = await api.createRecord(tableId, cells);
      setRecords((rs) => [...rs, record]);
      return record;
    } catch (e) {
      fail(e);
    }
  };

  const deleteRecords: ViewContext["deleteRecords"] = async (ids) => {
    const set = new Set(ids);
    setRecords((rs) => rs.filter((r) => !set.has(r.id)));
    try {
      await Promise.all(ids.map((id) => api.deleteRecord(id)));
      // Deleting removes the record from links and lookups elsewhere.
      qc.invalidateQueries({ queryKey: ["viewRecords"] });
    } catch (e) {
      fail(e);
    }
  };

  // View config: update the cache immediately, save after a short pause.
  const saveTimer = useRef<number>();
  const pendingRefetch = useRef(false);
  const updateConfig: ViewContext["updateConfig"] = (patch) => {
    if (!view) return;
    // Read the latest config from the cache, so quick successive changes don't overwrite each other.
    const latest = qc.getQueryData<TableDetail>(schemaKey)?.views.find((v) => v.id === view.id)?.config ?? view.config;
    const config = { ...latest, ...patch };
    qc.setQueryData<TableDetail>(schemaKey, (d) => d && { ...d, views: d.views.map((v) => (v.id === view.id ? { ...v, config } : v)) });
    if (QUERY_KEYS.some((k) => k in patch)) pendingRefetch.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api.updateView(view.id, { config });
        if (pendingRefetch.current) {
          pendingRefetch.current = false;
          await qc.invalidateQueries({ queryKey: ["viewRecords", view.id] });
        }
      } catch (e) {
        setError((e as Error).message);
        qc.invalidateQueries({ queryKey: schemaKey });
      }
    }, 350);
  };

  const allFields = schema.data?.fields ?? [];
  const primaryFieldId = schema.data?.table.primaryFieldId ?? null;
  const visibleFields = useMemo(() => {
    if (!view) return [];
    const byId = new Map(allFields.map((f) => [f.id, f]));
    const hidden = new Set(view.config.hiddenFieldIds);
    return orderedFieldIds(view.config, allFields.map((f) => f.id), primaryFieldId)
      .filter((id) => id === primaryFieldId || !hidden.has(id))
      .map((id) => byId.get(id)!)
      .filter(Boolean);
  }, [allFields, view, primaryFieldId]);

  if (schema.isLoading) return <div className="center"><div className="spinner" /></div>;
  if (schema.isError) return <div className="center error">{(schema.error as Error).message}</div>;
  if (!view) return null;

  const ctx: ViewContext = {
    tableId, view, allFields, fields: visibleFields, primaryFieldId,
    records: recordsQ.data?.records ?? [],
    labels: recordsQ.data?.labels ?? {},
    search,
    setSearch,
    files: recordsQ.data?.files ?? {},
    canEdit,
    guest,
    canEditField,
    canAddRecords,
    canDeleteRecords: canAddRecords,
    canDesign,
    canComment,
    refresh: () => {
      qc.invalidateQueries({ queryKey: ["table"] });
      qc.invalidateQueries({ queryKey: ["viewRecords"] });
    },
    addFiles: (saved) => {
      qc.setQueryData<ViewRecords>(recordsKey, (d) =>
        d && {
          ...d,
          files: { ...d.files, ...Object.fromEntries(saved.map((a) => [a.id, a])) },
          labels: { ...d.labels, ...Object.fromEntries(saved.map((a) => [a.id, a.filename])) },
        });
    },
    saveCells, addRecord, deleteRecords, updateConfig,
    openRecord: setOpenRecordId,
    editField: (field) => setDialog({ field }),
    deleteField: async (f) => {
      const ok = await dialogs.confirm({
        title: `Delete the field “${f.name}”?`,
        message: "All values in this field will be permanently deleted from every record.",
        confirmText: "Delete field",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteField(f.id);
        await qc.invalidateQueries({ queryKey: schemaKey });
        await qc.invalidateQueries({ queryKey: ["viewRecords"] });
      } catch (e) {
        fail(e);
      }
    },
  };
  const openRecord = ctx.records.find((r) => r.id === openRecordId);

  return (
    <div className="workspace">
      <ViewSidebar
        canEdit={canEdit}
        views={views}
        currentId={view.id}
        onSelect={(id) => nav(`/base/${baseId}/${tableId}/${id}`)}
        onCreate={async (name, type, copyFrom) => {
          try {
            const { view: v } = await api.createView(tableId, name, type, copyFrom);
            await qc.invalidateQueries({ queryKey: schemaKey });
            nav(`/base/${baseId}/${tableId}/${v.id}`);
          } catch (e) { setError((e as Error).message); }
        }}
        onRename={async (id, name) => {
          try { await api.updateView(id, { name }); await qc.invalidateQueries({ queryKey: schemaKey }); }
          catch (e) { setError((e as Error).message); }
        }}
        onDelete={async (id) => {
          try { await api.deleteView(id); await qc.invalidateQueries({ queryKey: schemaKey }); }
          catch (e) { setError((e as Error).message); }
        }}
      />
      <div className="view-main">
        {view.type !== "form" && <ViewToolbar ctx={ctx} recordCount={ctx.records.length} loading={recordsQ.isFetching} />}
        {error && <div className="error banner" onClick={() => setError(null)}>{error} (click to dismiss)</div>}
        {recordsQ.isLoading ? (
          <div className="center"><div className="spinner" /></div>
        ) : view.type === "kanban" ? (
          <KanbanView ctx={ctx} />
        ) : view.type === "calendar" ? (
          <CalendarView ctx={ctx} />
        ) : view.type === "gallery" ? (
          <GalleryView ctx={ctx} />
        ) : view.type === "form" ? (
          <FormBuilderView ctx={ctx} />
        ) : (
          <GridView ctx={ctx} />
        )}
      </div>

      {openRecord && (
        <RecordModal
          record={openRecord}
          fields={orderedFieldIds(view.config, allFields.map((f) => f.id), primaryFieldId).map((id) => allFields.find((f) => f.id === id)!).filter(Boolean)}
          primaryFieldId={primaryFieldId}
          labels={ctx.labels}
          files={ctx.files}
          tableId={tableId}
          addFiles={ctx.addFiles}
          canEdit={canEdit}
          canEditField={canEditField}
          canDelete={canAddRecords}
          canComment={canComment}
          allFields={allFields}
          onSave={(patch) => saveCells(openRecord.id, patch)}
          onDelete={async () => { setOpenRecordId(null); await deleteRecords([openRecord.id]); }}
          onClose={() => setOpenRecordId(null)}
        />
      )}

      {dialog && (
        <FieldDialog
          field={dialog.field}
          isPrimary={dialog.field?.id === primaryFieldId}
          tableId={tableId}
          tables={tables}
          tableFields={allFields}
          onClose={() => setDialog(null)}
          onSave={async (input: FieldInput) => {
            if (dialog.field) await api.updateField(dialog.field.id, input);
            else await api.createField(tableId, input);
            // A new link field also adds a field to the linked table.
            await qc.invalidateQueries({ queryKey: ["table"] });
            await qc.invalidateQueries({ queryKey: ["viewRecords"] });
          }}
        />
      )}
    </div>
  );
}
