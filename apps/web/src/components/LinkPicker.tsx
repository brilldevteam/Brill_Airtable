import type { Field, LinkLabels } from "@brill/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

interface Props {
  field: Field; // a link field
  value: string[];
  labels: LinkLabels;
  onChange: (ids: string[]) => void;
  /** Focus the search box (yes in popovers; no inside the record form, where it would scroll the form). */
  autoFocus?: boolean;
}

/** Choose records from the linked table. Shows current links, then a searchable list. */
export function LinkPicker({ field, value, labels, onChange, autoFocus = true }: Props) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);

  const tableId = field.options.linkedTableId!;
  const results = useQuery({
    queryKey: ["recordNames", tableId, debounced],
    queryFn: () => api.recordNames(tableId, debounced),
  });
  // Names for records picked in this session that weren't in the original labels.
  const [picked, setPicked] = useState<LinkLabels>({});
  const nameOf = (id: string) => labels[id] ?? picked[id] ?? results.data?.records.find((r) => r.id === id)?.name ?? "…";
  const selected = new Set(value);

  return (
    <div className="link-picker">
      {value.length > 0 && (
        <div className="link-chips">
          {value.map((id) => (
            <span key={id} className="link-chip">
              {nameOf(id) || "Unnamed record"}
              <button title="Remove link" onClick={() => onChange(value.filter((x) => x !== id))}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="input-icon">
        <Search size={14} />
        <input autoFocus={autoFocus} placeholder="Find a record to link…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="link-results">
        {results.isLoading && <div className="menu-label">Searching…</div>}
        {results.data?.records.length === 0 && <div className="menu-label">No matching records.</div>}
        {results.data?.records.map((r) => {
          const on = selected.has(r.id);
          return (
            <button
              key={r.id}
              className={on ? "on" : ""}
              onClick={() => {
                setPicked((p) => ({ ...p, [r.id]: r.name }));
                onChange(on ? value.filter((x) => x !== r.id) : [...value, r.id]);
              }}
            >
              <span className="check">{on && <Check size={15} />}</span>
              {r.name || <span className="muted">Unnamed record</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
