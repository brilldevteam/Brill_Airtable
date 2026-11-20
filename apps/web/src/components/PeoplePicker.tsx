import type { CellValue, Field } from "@brill/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Search, Star } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { initials } from "./AppBar";

/** People who can open the current base (from the URL), for user fields and filters. */
export function useCollaborators() {
  const { baseId } = useParams();
  return useQuery({
    queryKey: ["collaborators", baseId],
    queryFn: () => api.collaborators(baseId!),
    enabled: !!baseId,
    staleTime: 60_000,
  });
}

/** Pick one person (or several, if the field allows) from the base's collaborators. */
export function UserPicker({ field, value, onChange, autoFocus = true }: {
  field: Pick<Field, "options">; value: CellValue; onChange: (v: string[] | null) => void; autoFocus?: boolean;
}) {
  const q = useCollaborators();
  const [find, setFind] = useState("");
  const multi = !!field.options.multiple;
  const selected = new Set(Array.isArray(value) ? value : []);
  const people = (q.data?.users ?? []).filter((u) => (u.name + " " + u.email).toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <div className="menu user-picker">
      <div className="input-icon user-find">
        <Search size={14} />
        <input autoFocus={autoFocus} placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      {q.isLoading && <div className="menu-label">Loading…</div>}
      {people.map((u) => {
        const on = selected.has(u.id);
        return (
          <button
            key={u.id}
            onClick={() => {
              if (!multi) return onChange(on ? null : [u.id]);
              const next = new Set(selected);
              if (on) next.delete(u.id);
              else next.add(u.id);
              onChange(next.size ? [...next] : null);
            }}
          >
            <span className="check">{on && <Check size={15} />}</span>
            <span className="avatar sm">{initials(u.name)}</span>
            <span className="user-pick-name">
              {u.name}
              {u.email && <small>{u.email}</small>}
            </span>
          </button>
        );
      })}
      {!q.isLoading && people.length === 0 && <div className="menu-label">Nobody matches.</div>}
      {selected.size > 0 && <button className="muted" onClick={() => onChange(null)}>Clear</button>}
    </div>
  );
}

/** People as small avatar chips (record form, cards). */
export function UserChips({ ids, labels }: { ids: string[]; labels: Record<string, string> }) {
  if (!ids.length) return <span className="muted">—</span>;
  return (
    <span className="user-chips">
      {ids.map((id) => (
        <span key={id} className="user-chip">
          <span className="avatar sm">{initials(labels[id] ?? "?")}</span>
          {labels[id] ?? "Unknown user"}
        </span>
      ))}
    </span>
  );
}

/** Clickable stars; clicking the current rating clears it. */
export function RatingInput({ max = 5, value, onChange, disabled, size = 18 }: {
  max?: number; value: number | null; onChange: (v: number | null) => void; disabled?: boolean; size?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <span className="rating-input" onMouseLeave={() => setHover(null)} role="radiogroup" aria-label="Rating">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of ${max}`}
          disabled={disabled}
          className={"star" + (n <= shown ? " on" : "")}
          onMouseEnter={() => !disabled && setHover(n)}
          onClick={() => onChange(value === n ? null : n)}
        >
          <Star size={size} />
        </button>
      ))}
    </span>
  );
}
