import { cellToText, type CellValue, type Field } from "@brill/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, MessageSquare, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { initials } from "./AppBar";

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Comments and change history for a record. */
export function ActivityPanel({ recordId, fields, canComment }: { recordId: string; fields: Field[]; canComment: boolean }) {
  const [tab, setTab] = useState<"comments" | "history">("comments");
  return (
    <aside className="activity">
      <div className="activity-tabs">
        <button className={tab === "comments" ? "on" : ""} onClick={() => setTab("comments")}><MessageSquare size={14} /> Comments</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}><History size={14} /> History</button>
      </div>
      {tab === "comments" ? <Comments recordId={recordId} canComment={canComment} /> : <HistoryList recordId={recordId} fields={fields} />}
    </aside>
  );
}

function Comments({ recordId, canComment }: { recordId: string; canComment: boolean }) {
  const qc = useQueryClient();
  const key = ["recordComments", recordId];
  const q = useQuery({ queryKey: key, queryFn: () => api.recordComments(recordId) });
  const me = qc.getQueryData<{ user: { id: string } | null }>(["me"])?.user;
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const add = useMutation({
    mutationFn: (b: string) => api.addRecordComment(recordId, b),
    onSuccess: () => { setText(""); qc.invalidateQueries({ queryKey: key }); },
  });
  const del = useMutation({ mutationFn: api.deleteRecordComment, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  const comments = q.data?.comments ?? [];
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [comments.length]);
  const send = () => { if (text.trim() && !add.isPending) add.mutate(text.trim()); };

  return (
    <>
      <div className="activity-list" ref={list}>
        {q.isLoading && <div className="center"><div className="spinner" /></div>}
        {!q.isLoading && comments.length === 0 && (
          <div className="activity-empty"><MessageSquare size={22} /><span>No comments yet. Start the conversation.</span></div>
        )}
        {comments.map((c) => (
          <div key={c.id} className="act-item">
            <span className="avatar sm">{initials(c.userName)}</span>
            <div className="act-body">
              <div className="act-meta"><b>{c.userName}</b><span>{timeAgo(c.createdAt)}</span></div>
              <div className="act-text">{c.body}</div>
            </div>
            {c.userId === me?.id && (
              <button className="icon-btn danger act-del" title="Delete comment" onClick={() => del.mutate(c.id)}><Trash2 size={13} /></button>
            )}
          </div>
        ))}
      </div>
      {canComment && (
        <div className="act-input">
          <textarea
            rows={2}
            placeholder="Add a comment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="act-send" disabled={!text.trim() || add.isPending} onClick={send} title="Send (Enter)"><Send size={14} /></button>
        </div>
      )}
      {add.isError && <div className="error" style={{ padding: "0 12px 8px" }}>{(add.error as Error).message}</div>}
    </>
  );
}

function HistoryList({ recordId, fields }: { recordId: string; fields: Field[] }) {
  const q = useQuery({ queryKey: ["recordHistory", recordId], queryFn: () => api.recordHistory(recordId) });
  const byId = new Map(fields.map((f) => [f.id, f]));
  const show = (f: Field | undefined, v: CellValue) => {
    if (v === null || v === undefined) return <span className="muted">empty</span>;
    if (!f) return String(v);
    const text = f.type === "checkbox" ? (v ? "checked" : "unchecked") : cellToText(f, v, q.data?.labels ?? {});
    return text || <span className="muted">empty</span>;
  };
  return (
    <div className="activity-list">
      {q.isLoading && <div className="center"><div className="spinner" /></div>}
      {q.data?.entries.length === 0 && <div className="activity-empty"><History size={22} /><span>No changes recorded yet.</span></div>}
      {q.data?.entries.map((e) => (
        <div key={e.id} className="act-item">
          <span className="avatar sm">{initials(e.userName ?? "?")}</span>
          <div className="act-body">
            <div className="act-meta">
              <b>{e.userName ?? "Someone"}</b>
              <span>{e.kind === "create" ? "created this record" : e.kind === "delete" ? "deleted this record" : "edited"} · {timeAgo(e.createdAt)}</span>
            </div>
            {Object.entries(e.changes).map(([fid, ch]) => {
              const f = byId.get(fid);
              return (
                <div key={fid} className="act-change">
                  <div className="act-field">{f?.name ?? "Deleted field"}</div>
                  {e.kind === "create" ? (
                    <div className="act-vals"><span className="to">{show(f, ch.to)}</span></div>
                  ) : (
                    <div className="act-vals">
                      <span className="from">{show(f, ch.from)}</span>
                      <ArrowRight size={12} />
                      <span className="to">{show(f, ch.to)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
