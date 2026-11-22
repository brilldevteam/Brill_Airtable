import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, CheckCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Popover, anchorOf, type Anchor } from "./Popover";

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The bell in the top bar: mentions and assignments, newest first. */
export function NotificationsBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState<Anchor | null>(null);
  const q = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const unread = q.data?.unread ?? 0;
  const list = q.data?.notifications ?? [];
  const markAll = async () => { await api.markNotificationsRead(); await qc.invalidateQueries({ queryKey: ["notifications"] }); };

  return (
    <>
      <button className={"icon-btn bell" + (open ? " on" : "")} title="Notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        onClick={(e) => setOpen(open ? null : anchorOf(e.currentTarget))}>
        <Bell size={18} />
        {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <Popover anchor={{ ...open, x: open.x - 300 }} onClose={() => setOpen(null)} minWidth={360}>
          <div className="notif-panel">
            <div className="notif-head">
              <b>Notifications</b>
              {unread > 0 && <button className="link" onClick={markAll}><CheckCheck size={14} /> Mark all read</button>}
            </div>
            <div className="notif-list">
              {list.length === 0 && <div className="notif-empty">Nothing yet. You'll see it here when someone @mentions you or adds you to a record.</div>}
              {list.map((n) => (
                <button key={n.id} className={"notif-item" + (n.read ? "" : " unread")} onClick={async () => {
                  setOpen(null);
                  if (!n.read) { await api.markNotificationsRead([n.id]).catch(() => undefined); void qc.invalidateQueries({ queryKey: ["notifications"] }); }
                  nav(n.link);
                }}>
                  <span className={"notif-icon " + n.kind}>{n.kind === "mention" ? <AtSign size={14} /> : <UserPlus size={14} />}</span>
                  <span className="notif-text">
                    <b>{n.title}</b>
                    {n.body && <span className="notif-body">{n.body}</span>}
                    <small>{n.baseName} · {ago(n.createdAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
