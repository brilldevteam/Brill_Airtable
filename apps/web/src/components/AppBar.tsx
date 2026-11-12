import type { User } from "@brill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, LogOut } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
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
export function AppBar({ children }: { children?: ReactNode }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const user = me.data?.user as User | undefined;
  const qc = useQueryClient();
  const [menu, setMenu] = useState<Anchor | null>(null);

  return (
    <header className="appbar">
      <Link to="/" className="logo" title="All bases">
        <LogoMark />
        {!children && <span>Brill Tables</span>}
      </Link>
      {children}
      {!children && <div className="spacer" />}
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
            <button
              onClick={async () => {
                setMenu(null);
                await api.logout();
                qc.clear();
                await qc.invalidateQueries({ queryKey: ["me"] });
              }}
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </Popover>
      )}
    </header>
  );
}
