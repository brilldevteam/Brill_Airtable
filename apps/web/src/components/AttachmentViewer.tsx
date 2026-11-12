import type { AttachmentInfo } from "@brill/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Download, FileText, MessageSquare, Pencil, Send, Trash2, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { initials } from "./AppBar";
import { fileExt, formatBytes, kindOf } from "./attachmentUtils";
import { useDialogs } from "./Dialogs";

interface Props {
  files: AttachmentInfo[];
  startIndex: number;
  canEdit: boolean;
  onClose: () => void;
  /** Remove a file from the cell (the file itself is kept for history). */
  onRemove?: (id: string) => void;
  onRenamed?: (info: AttachmentInfo) => void;
}

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Full-screen viewer for a cell's attachments: preview, navigate, rename, delete, download, comment. */
export function AttachmentViewer({ files, startIndex, canEdit, onClose, onRemove, onRenamed }: Props) {
  const [index, setIndex] = useState(Math.min(startIndex, files.length - 1));
  // Comments start open on wide screens; on narrow ones they would cover the file.
  const [showComments, setShowComments] = useState(() => window.innerWidth > 1000);
  const dialogs = useDialogs();
  const file = files[index];

  // Keep the index valid when files are removed.
  useEffect(() => {
    if (index >= files.length) setIndex(Math.max(0, files.length - 1));
    if (files.length === 0) onClose();
  }, [files.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea");
      if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) onClose();
      if (typing) return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(files.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length, onClose]);

  if (!file) return null;
  const kind = kindOf(file);

  const rename = async () => {
    const dot = file.filename.lastIndexOf(".");
    const name = await dialogs.prompt({ title: "Rename file", label: "File name", defaultValue: file.filename });
    if (!name || name === file.filename) return;
    // Keep the extension if the user dropped it.
    const final = dot > 0 && !name.includes(".") ? name + file.filename.slice(dot) : name;
    const { attachment } = await api.renameAttachment(file.id, final);
    onRenamed?.(attachment);
  };
  const remove = async () => {
    const ok = await dialogs.confirm({
      title: `Remove “${file.filename}”?`,
      message: "It will be removed from this record.",
      confirmText: "Remove",
      danger: true,
    });
    if (ok) onRemove?.(file.id);
  };

  return (
    <div className="viewer" role="dialog" aria-label={file.filename}>
      <div className="viewer-main" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="viewer-top">
          <span className="viewer-title" title={file.filename}>{file.filename}</span>
          <div className="viewer-top-actions">
            <button className="v-btn" title={showComments ? "Hide comments" : "Show comments"} onClick={() => setShowComments(!showComments)}>
              <MessageSquare size={17} />
            </button>
            <button className="v-btn" title="Close (Esc)" onClick={onClose}><X size={19} /></button>
          </div>
        </div>

        <div className="viewer-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          {files.length > 1 && (
            <button className="v-nav left" disabled={index === 0} onClick={() => setIndex(index - 1)} title="Previous (←)">
              <ChevronLeft size={22} />
            </button>
          )}
          <div className="viewer-media" key={file.id}>
            {kind === "image" && <img src={file.url} alt={file.filename} />}
            {kind === "video" && <video src={file.url} controls autoPlay playsInline />}
            {kind === "audio" && (
              <div className="viewer-audio"><FileText size={40} /><audio src={file.url} controls autoPlay /></div>
            )}
            {kind === "pdf" && <iframe src={file.url} title={file.filename} />}
            {kind === "other" && (
              <div className="viewer-nopreview">
                <div className="viewer-ext">{fileExt(file.filename)}</div>
                <strong>No preview available</strong>
                <span>Download the file to open it.</span>
                <a className="btn primary" href={`${file.url}?download=1`}><Download size={15} /> Download</a>
              </div>
            )}
          </div>
          {files.length > 1 && (
            <button className="v-nav right" disabled={index === files.length - 1} onClick={() => setIndex(index + 1)} title="Next (→)">
              <ChevronRight size={22} />
            </button>
          )}
        </div>

        <div className="viewer-bottom">
          <span className="viewer-size">
            {formatBytes(file.size)}
            {file.width && file.height ? ` · ${file.width}×${file.height}` : ""}
          </span>
          <span className="viewer-count">{files.length > 1 ? `${index + 1} of ${files.length}` : ""}</span>
          <div className="viewer-actions">
            {canEdit && onRemove && <button className="v-btn" title="Remove from record" onClick={remove}><Trash2 size={17} /></button>}
            {canEdit && <button className="v-btn" title="Rename" onClick={rename}><Pencil size={16} /></button>}
            <a className="btn primary sm" href={`${file.url}?download=1`}><Download size={14} /> Download</a>
          </div>
        </div>

        {files.length > 1 && (
          <div className="viewer-strip">
            {files.map((f, i) => (
              <button key={f.id} className={"strip-item" + (i === index ? " on" : "")} onClick={() => setIndex(i)} title={f.filename}>
                <MiniThumb file={f} />
              </button>
            ))}
          </div>
        )}
      </div>

      {showComments && <CommentsPanel attachmentId={file.id} onHide={() => setShowComments(false)} />}
    </div>
  );
}

export function MiniThumb({ file }: { file: AttachmentInfo }) {
  const kind = kindOf(file);
  if (file.thumbUrl) return <img src={file.thumbUrl} alt="" loading="lazy" />;
  if (kind === "video") return <video src={`${file.url}#t=0.1`} preload="metadata" muted playsInline />;
  return <span className="mini-ext">{fileExt(file.filename)}</span>;
}

function CommentsPanel({ attachmentId, onHide }: { attachmentId: string; onHide: () => void }) {
  const qc = useQueryClient();
  const me = qc.getQueryData<{ user: { id: string } | null }>(["me"])?.user;
  const key = ["attComments", attachmentId];
  const q = useQuery({ queryKey: key, queryFn: () => api.attachmentComments(attachmentId) });
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const add = useMutation({
    mutationFn: (body: string) => api.addAttachmentComment(attachmentId, body),
    onSuccess: () => { setText(""); qc.invalidateQueries({ queryKey: key }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteAttachmentComment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [q.data?.comments.length]);
  const comments = q.data?.comments ?? [];

  const send = () => { if (text.trim() && !add.isPending) add.mutate(text.trim()); };

  return (
    <aside className="viewer-comments">
      <div className="vc-head">
        <strong>Comments</strong>
        {comments.length > 0 && <span className="vc-count">{comments.length}</span>}
        <div className="spacer" />
        <button className="v-btn" title="Hide comments" onClick={onHide}><X size={16} /></button>
      </div>
      <div className="vc-list" ref={list}>
        {q.isLoading && <div className="vc-empty"><div className="spinner" /></div>}
        {!q.isLoading && comments.length === 0 && (
          <div className="vc-empty">
            <MessageSquare size={26} />
            <strong>No comments on this file yet</strong>
            <span>Leave feedback for your team — it stays with the file.</span>
          </div>
        )}
        {comments.map((c) => (
          <div key={c.id} className="vc-item">
            <span className="vc-avatar">{initials(c.userName)}</span>
            <div className="vc-body">
              <div className="vc-meta"><b>{c.userName}</b><span>{timeAgo(c.createdAt)}</span></div>
              <div className="vc-text">{c.body}</div>
            </div>
            {c.userId === me?.id && (
              <button className="v-btn vc-del" title="Delete comment" onClick={() => del.mutate(c.id)}><Trash2 size={14} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="vc-input">
        <textarea
          rows={2}
          placeholder="Leave a comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="v-send" title="Send (Enter)" disabled={!text.trim() || add.isPending} onClick={send}><Send size={15} /></button>
      </div>
      {add.isError && <div className="error" style={{ padding: "0 14px 10px" }}>{(add.error as Error).message}</div>}
    </aside>
  );
}
