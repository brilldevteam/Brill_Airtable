import type { User } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, LogOut, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { AccountDialog } from "./AccountDialog";
import { NotificationsBell } from "./NotificationsBell";
import { Popover, anchorOf, type Anchor } from "./Popover";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? "")).toUpperCase() || "?";
}

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }}>
      <LayoutGrid size={Math.round(size * 0.55)} strokeWidth={2.2} />
    </span>
  );
}

/** Top bar shared by every signed-in page: logo, page-specific content, user menu. */
export function AppBar({ children, compact = false }: { children?: ReactNode; compact?: boolean }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const user = me.data?.user as User | undefined;
  const qc = useQueryClient();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [account, setAccount] = useState(false);

  return (
    <header className={"appbar" + (compact ? " compact" : "")}>
      <Link to="/" className="logo" title="All bases">
        <LogoMark size={compact ? 28 : 30} />
        {!children && <span>Brill Tables</span>}
      </Link>
      {children}
      {!children && <div className="spacer" />}
      {user && <NotificationsBell />}
      {user && (
        <button className="avatar" title={user.name} onClick={(e) => setMenu(anchorOf(e.currentTarget))}>
          {initials(user.name)}
        </button>
      )}
      {menu && user && (
        <Popover anchor={{ ...menu, x: menu.x - 180 }} onClose={() => setMenu(null)} minWidth={220}>
          <div className="menu">
            <div className="menu-head">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <hr />
            <button onClick={() => { setMenu(null); setAccount(true); }}>
              <Settings size={16} /> Account settings
            </button>
            <button
              onClick={async () => {
                setMenu(null);
                try {
                  await api.logout();
                } finally {
                  // A fresh page load: clears every cached record, closes live-update streams,
                  // and shows the sign-in page.
                  qc.clear();
                  window.location.assign("/");
                }
              }}
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </Popover>
      )}
      {account && user && <AccountDialog user={user} onClose={() => setAccount(false)} />}
    </header>
  );
}
