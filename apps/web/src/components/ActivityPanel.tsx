import { cellToText, type CellValue, type Field } from "@brill/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, MessageSquare, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { initials } from "./AppBar";
import { useCollaborators } from "./PeoplePicker";

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
  const box = useRef<HTMLTextAreaElement>(null);
  const people = useCollaborators().data?.users ?? [];
  // "@Name" typed via the picker → remembered, so the comment is saved as @[Name](id).
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [hi, setHi] = useState(0);
  const matches = mention ? people.filter((p) => p.name.toLowerCase().includes(mention.query.toLowerCase()) || p.email.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  const onType = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    setMention(m ? { start: caret - m[2].length - 1, query: m[2] } : null);
    setHi(0);
  };
  const choose = (p: { id: string; name: string }) => {
    if (!mention) return;
    const caret = box.current?.selectionStart ?? text.length;
    const next = text.slice(0, mention.start) + "@" + p.name + " " + text.slice(caret);
    setText(next);
    setPicked((x) => ({ ...x, [p.name]: p.id }));
    setMention(null);
    setTimeout(() => { const pos = mention.start + p.name.length + 2; box.current?.focus(); box.current?.setSelectionRange(pos, pos); }, 0);
  };
  const encode = (s: string) => {
    let out = s;
    for (const [name, id] of Object.entries(picked).sort((a, b) => b[0].length - a[0].length)) {
      out = out.split("@" + name).join(`@[${name}](${id})`);
    }
    return out;
  };
  const add = useMutation({
    mutationFn: (b: string) => api.addRecordComment(recordId, b),
    onSuccess: () => { setText(""); setPicked({}); qc.invalidateQueries({ queryKey: key }); },
  });
  const del = useMutation({ mutationFn: api.deleteRecordComment, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  const comments = q.data?.comments ?? [];
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [comments.length]);
  const send = () => { if (text.trim() && !add.isPending) add.mutate(encode(text.trim())); };

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
              <div className="act-text"><CommentText body={c.body} /></div>
            </div>
            {c.userId === me?.id && (
              <button className="icon-btn danger act-del" title="Delete comment" onClick={() => del.mutate(c.id)}><Trash2 size={13} /></button>
            )}
          </div>
        ))}
      </div>
      {canComment && (
        <div className="act-input">
          {mention && matches.length > 0 && (
            <div className="mention-menu" role="listbox">
              {matches.map((p, i) => (
                <button key={p.id} className={i === hi ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
                  <span className="avatar sm">{initials(p.name)}</span> <b>{p.name}</b> <small>{p.email}</small>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            rows={2}
            placeholder="Add a comment… type @ to mention someone"
            value={text}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={(e) => {
              if (mention && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + matches.length) % matches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[hi]); return; }
                if (e.key === "Escape") { setMention(null); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
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
              <span>{e.kind === "create" ? "created this record" : e.kind === "delete" ? "deleted this record" : e.kind === "restore" ? "restored this record from the trash" : "edited"} · {timeAgo(e.createdAt)}</span>
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

/** A comment, with @[Name](id) mentions shown as highlighted names. */
function CommentText({ body }: { body: string }) {
  const parts = body.split(/(@\[[^\]\n]{1,100}\]\(usr[A-Za-z0-9]{6,30}\))/g);
  return <>{parts.map((p, i) => {
    const m = /^@\[([^\]]+)\]\(usr[A-Za-z0-9]+\)$/.exec(p);
    return m ? <span key={i} className="mention">@{m[1]}</span> : <span key={i}>{p}</span>;
  })}</>;
}
