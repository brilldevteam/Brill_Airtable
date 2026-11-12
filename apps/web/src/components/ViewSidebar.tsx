import type { View, ViewType } from "@brill/shared";
import { CalendarDays, ClipboardList, Copy, Kanban, LayoutGrid, MoreHorizontal, Pencil, Plus, Search, Sheet, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDialogs } from "./Dialogs";
import { Popover, anchorOf, type Anchor } from "./Popover";

const VIEW_LABEL: Record<ViewType, string> = { grid: "Grid", kanban: "Kanban", calendar: "Calendar", gallery: "Gallery", form: "Form" };

export function ViewIcon({ type, size = 16 }: { type: ViewType; size?: number }) {
  switch (type) {
    case "kanban": return <Kanban size={size} className="view-icon vi-kanban" />;
    case "calendar": return <CalendarDays size={size} className="view-icon vi-calendar" />;
    case "gallery": return <LayoutGrid size={size} className="view-icon vi-gallery" />;
    case "form": return <ClipboardList size={size} className="view-icon vi-form" />;
    default: return <Sheet size={size} className="view-icon vi-grid" />;
  }
}

interface Props {
  canEdit: boolean;
  views: View[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string, type: ViewType, copyFromViewId?: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function ViewSidebar({ canEdit, views, currentId, onSelect, onCreate, onRename, onDelete }: Props) {
  const dialogs = useDialogs();
  const [menu, setMenu] = useState<{ view: View; anchor: Anchor } | null>(null);
  const [find, setFind] = useState("");
  const shown = views.filter((v) => v.name.toLowerCase().includes(find.trim().toLowerCase()));

  const create = async (type: ViewType) => {
    const n = views.filter((v) => v.type === type).length + 1;
    const name = await dialogs.prompt({
      title: `New ${VIEW_LABEL[type].toLowerCase()} view`,
      message: "Each view keeps its own filters, sorts and hidden fields.",
      label: "View name",
      defaultValue: `${VIEW_LABEL[type]} view${n > 1 ? " " + n : ""}`,
      confirmText: "Create view",
    });
    if (name) onCreate(name, type);
  };
  const rename = async (v: View) => {
    const name = await dialogs.prompt({ title: "Rename view", label: "View name", defaultValue: v.name });
    if (name) onRename(v.id, name);
  };
  const remove = async (v: View) => {
    const ok = await dialogs.confirm({
      title: `Delete “${v.name}”?`,
      message: "Only the view is deleted — your records stay as they are.",
      confirmText: "Delete view",
      danger: true,
    });
    if (ok) onDelete(v.id);
  };

  return (
    <aside className="view-sidebar">
      <div className="view-find input-icon">
        <Search size={14} />
        <input placeholder="Find a view" value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      <div className="sidebar-label">Views</div>
      <div className="view-list">
        {shown.map((v) => (
          <div key={v.id} className={"view-item" + (v.id === currentId ? " active" : "")}>
            <button className="view-name" onClick={() => onSelect(v.id)} onDoubleClick={() => canEdit && rename(v)}>
              <ViewIcon type={v.type} />
              <span>{v.name}</span>
            </button>
            {canEdit && <button className="icon-btn view-more" title="View options" onClick={(e) => setMenu({ view: v, anchor: anchorOf(e.currentTarget) })}>
              <MoreHorizontal size={16} />
            </button>}
          </div>
        ))}
        {shown.length === 0 && <div className="panel-empty" style={{ padding: "4px 8px" }}>No views match.</div>}
      </div>

      {canEdit && <div className="view-create">
        <div className="sidebar-label" style={{ paddingBottom: 4 }}>Create</div>
        {(["grid", "kanban", "calendar", "gallery", "form"] as ViewType[]).map((t) => (
          <button key={t} className="view-name" onClick={() => create(t)}>
            <ViewIcon type={t} />
            {VIEW_LABEL[t]}
            <Plus size={15} className="plus" />
          </button>
        ))}
      </div>}

      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} minWidth={190}>
          <div className="menu">
            <button onClick={() => { const v = menu.view; setMenu(null); rename(v); }}><Pencil size={15} /> Rename view</button>
            <button onClick={() => { const v = menu.view; setMenu(null); onCreate(`${v.name} copy`, v.type, v.id); }}><Copy size={15} /> Duplicate view</button>
            {views.length > 1 && (
              <>
                <hr />
                <button className="danger" onClick={() => { const v = menu.view; setMenu(null); remove(v); }}><Trash2 size={15} /> Delete view</button>
              </>
            )}
          </div>
        </Popover>
      )}
    </aside>
  );
}
