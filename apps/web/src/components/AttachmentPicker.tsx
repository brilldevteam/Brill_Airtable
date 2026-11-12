import type { AttachmentInfo } from "@brill/shared";
import { Maximize2, Paperclip, Play, Plus, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { AttachmentViewer, MiniThumb } from "./AttachmentViewer";
import { fileExt, formatBytes, kindOf } from "./attachmentUtils";
import { UploadDialog } from "./UploadDialog";

export { fileExt, formatBytes };

export interface AttachmentFieldProps {
  tableId: string;
  value: string[];
  files: Record<string, AttachmentInfo>;
  /** Add new/renamed files to the view's cache. */
  onFiles: (infos: AttachmentInfo[]) => void;
  onChange: (ids: string[]) => void;
  canEdit?: boolean;
}

/** Shared state: which file is open in the viewer, and whether the upload dialog is open. */
function useAttachmentUi(p: AttachmentFieldProps) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const list = p.value.map((id) => p.files[id]).filter((f): f is AttachmentInfo => !!f);
  // Rendered at the top of the page so they cover everything, even when opened from a popover.
  const ui = createPortal(
    <>
      {uploading && (
        <UploadDialog
          tableId={p.tableId}
          onClose={() => setUploading(false)}
          onUploaded={(infos) => {
            p.onFiles(infos);
            p.onChange([...p.value, ...infos.map((i) => i.id)]);
          }}
        />
      )}
      {viewing !== null && list.length > 0 && (
        <AttachmentViewer
          files={list}
          startIndex={viewing}
          canEdit={p.canEdit !== false}
          onClose={() => setViewing(null)}
          onRemove={(id) => p.onChange(p.value.filter((x) => x !== id))}
          onRenamed={(info) => p.onFiles([info])}
        />
      )}
    </>,
    document.body,
  );
  return { list, ui, open: setViewing, upload: () => setUploading(true) };
}

/**
 * The compact editor shown on a selected grid cell, like Airtable:
 * small thumbnails, a paperclip to add files, and an expand button.
 */
export function AttachmentStrip(p: AttachmentFieldProps & { onExpand: () => void }) {
  const { list, ui, open, upload } = useAttachmentUi(p);
  return (
    <div className="att-strip">
      {p.canEdit !== false && (
        <button className="att-strip-add" title="Add attachment" onClick={upload}><Paperclip size={15} /></button>
      )}
      {list.map((f, i) => (
        <button key={f.id} className="att-strip-thumb" title={f.filename} onClick={() => open(i)}>
          <MiniThumb file={f} />
          {kindOf(f) === "video" && <span className="play-badge"><Play size={10} fill="currentColor" /></span>}
        </button>
      ))}
      <div className="spacer" />
      <button className="icon-btn att-strip-expand" title="Expand" onClick={p.onExpand}><Maximize2 size={14} /></button>
      {ui}
    </div>
  );
}

/** Large tiles with names and sizes, plus an "add" tile — used in the record form and the expanded cell. */
export function AttachmentTiles(p: AttachmentFieldProps) {
  const { list, ui, open, upload } = useAttachmentUi(p);
  const [over, setOver] = useState(false);
  return (
    <div
      className={"att-tiles" + (over ? " over" : "")}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(); }}
    >
      {list.map((f, i) => (
        <div key={f.id} className="att-tile" title={f.filename}>
          <button className="att-thumb" onClick={() => open(i)}>
            {f.thumbUrl ? <img src={f.thumbUrl} alt={f.filename} loading="lazy" />
              : kindOf(f) === "video" ? <video src={`${f.url}#t=0.1`} preload="metadata" muted playsInline />
              : <span className="att-file"><b>{fileExt(f.filename)}</b></span>}
            {kindOf(f) === "video" && <span className="play-badge lg"><Play size={14} fill="currentColor" /></span>}
          </button>
          <div className="att-meta">
            <span className="att-name">{f.filename}</span>
            <span className="att-size">{formatBytes(f.size)}</span>
          </div>
          {p.canEdit !== false && (
            <button className="icon-btn danger att-remove" title="Remove" onClick={() => p.onChange(p.value.filter((x) => x !== f.id))}>
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {p.canEdit !== false && (
        <button className="att-tile att-add" onClick={upload}>
          <Plus size={20} />
          <span>Add file</span>
        </button>
      )}
      {ui}
    </div>
  );
}
