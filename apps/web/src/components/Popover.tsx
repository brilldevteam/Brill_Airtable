import type { CellValue, Field } from "@brill/shared";
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CHOICE_COLORS } from "../colors";

export interface Anchor { x: number; y: number; width: number; height: number }

export const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/** A floating panel under an anchor rectangle. Clicking outside closes it. */
export function Popover({ anchor, onClose, children, minWidth = 200, cover = false, className = "" }: {
  anchor: Anchor; onClose: () => void; children: ReactNode; minWidth?: number;
  /** Sit on top of the anchor (like an in-cell editor) instead of below it. */
  cover?: boolean;
  className?: string;
}) {
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - minWidth - 16));
  const below = cover ? anchor.y - 1 : anchor.y + anchor.height + 4;
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(below);
  // Open upwards when there isn't room below (e.g. menus on the summary bar).
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    if (!cover && below + h > window.innerHeight - 8 && anchor.y - h - 4 >= 8) setTop(anchor.y - h - 4);
    else if (below + h > window.innerHeight - 8) setTop(Math.max(8, window.innerHeight - h - 8));
    else setTop(below);
  }, [below, anchor.y, cover]);
  return (
    <div className="popover-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={"popover " + className}
        style={{ left: cover ? Math.max(8, Math.min(anchor.x - 1, window.innerWidth - minWidth - 16)) : left, top, minWidth: Math.max(anchor.width, minWidth), maxWidth: "calc(100vw - 16px)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function ChoicePill({ field, id }: { field: Field; id: string }) {
  const c = field.options.choices?.find((x) => x.id === id);
  if (!c) return null;
  const col = CHOICE_COLORS[c.color] ?? CHOICE_COLORS.gray;
  return <span className="pill" style={{ background: col.bg, color: col.fg }}>{c.name}</span>;
}

/** Option list for single/multiple select cells. */
export function SelectPicker({ field, value, onChange }: { field: Field; value: CellValue; onChange: (v: CellValue) => void }) {
  const multi = field.type === "multipleSelect";
  const selected = new Set(Array.isArray(value) ? value : value ? [String(value)] : []);
  const choices = field.options.choices ?? [];
  return (
    <div className="menu">
      {choices.length === 0 && <div className="menu-label">No options yet — edit the field to add some.</div>}
      {choices.map((c) => {
        const on = selected.has(c.id);
        return (
          <button
            key={c.id}
            onClick={() => {
              if (!multi) return onChange(on ? null : c.id);
              const next = new Set(selected);
              if (on) next.delete(c.id);
              else next.add(c.id);
              onChange(next.size ? [...next] : null);
            }}
          >
            <span className="check">{on && <Check size={15} />}</span>
            <ChoicePill field={field} id={c.id} />
          </button>
        );
      })}
      {selected.size > 0 && <button className="muted" onClick={() => onChange(null)}>Clear</button>}
    </div>
  );
}
