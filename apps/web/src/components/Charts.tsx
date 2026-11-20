import { useMemo, useState, type MouseEvent } from "react";
import { CHOICE_COLORS } from "../colors";

/**
 * Small hand-drawn charts for dashboards. Rules (from the data-viz guide): one series = one hue;
 * select options keep their own colour (colour follows the entity); other categories take the
 * validated categorical palette in fixed order, with "Other" in neutral grey; thin marks with
 * rounded data ends; recessive axes; a hover tooltip on every mark; a legend for the donut.
 */

/** Validated categorical palette (light), in fixed order. */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#a1a1aa";
const EMPTY = "#d4d4d8";

export interface ChartGroup { key: string; label: string; color: string | null; value: number; display: string }

/** Colour of a group: its select-option colour, else the palette slot, grey for Other / (Empty). */
export function groupColor(g: ChartGroup, index: number, single: boolean): string {
  if (g.key === "__other") return OTHER;
  if (g.key === "" ) return EMPTY;
  if (g.color && CHOICE_COLORS[g.color]) return CHOICE_FILL[g.color] ?? SERIES[0];
  return single ? SERIES[0] : SERIES[index % SERIES.length];
}
/** Mid-tone fills for select colours (the pill colours are too light or too dark for bars). */
const CHOICE_FILL: Record<string, string> = {
  blue: "#3b82f6", cyan: "#06b6d4", teal: "#14b8a6", green: "#22c55e", yellow: "#eab308",
  orange: "#f97316", red: "#ef4444", pink: "#ec4899", purple: "#8b5cf6", gray: "#a1a1aa",
};

type Tip = { x: number; y: number; title: string; value: string; note?: string } | null;
function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      <span className="chart-tip-title">{tip.title}</span>
      <b>{tip.value}</b>
      {tip.note && <span className="chart-tip-note">{tip.note}</span>}
    </div>
  );
}
const share = (v: number, total: number) => (total ? `${Math.round((v / total) * 100)}% of total` : "");
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const at = (e: MouseEvent, title: string, value: string, note?: string) => {
    const box = (e.currentTarget as Element).closest(".chart")!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left + 12, y: e.clientY - box.top + 12, title, value, note });
  };
  return { tip, at, clear: () => setTip(null) };
}

/** Horizontal bars: best for categories (names stay readable). */
export function BarChart({ groups, total }: { groups: ChartGroup[]; total: number }) {
  const { tip, at, clear } = useTip();
  const max = Math.max(...groups.map((g) => g.value), 0) || 1;
  const single = !groups.some((g) => g.color);
  return (
    <div className="chart bar-chart" onMouseLeave={clear}>
      {groups.map((g, i) => (
        <div key={g.key} className="bar-row" onMouseMove={(e) => at(e, g.label, g.display, share(g.value, total))}>
          <span className="bar-label" title={g.label}>{g.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max((g.value / max) * 100, g.value ? 1.5 : 0)}%`, background: groupColor(g, i, single) }} />
          </span>
          <span className="bar-value">{g.display}</span>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Nice round axis ticks. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const step0 = max / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.01; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Vertical bars or a line over ordered groups (usually time). One axis, from zero. */
export function ColumnLineChart({ groups, total, line }: { groups: ChartGroup[]; total: number; line?: boolean }) {
  const { tip, at, clear } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 220;
  const pad = { l: 44, r: 10, t: 10, b: 28 };
  const max = Math.max(...groups.map((g) => g.value), 0);
  const ts = useMemo(() => ticks(max), [max]);
  const top = ts[ts.length - 1] || 1;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = Math.max(groups.length, 1);
  const slot = iw / n;
  const barW = Math.max(2, Math.min(28, slot - 2)); // 2px surface gap between bars
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const every = Math.ceil(n / 8); // thin the x labels so they never collide
  const single = !groups.some((g) => g.color);
  return (
    <div className="chart" onMouseLeave={() => { clear(); setHover(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Chart">
        {ts.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t)} className="chart-axis" textAnchor="end" dominantBaseline="middle">{compact(t)}</text>
          </g>
        ))}
        {groups.map((g, i) => (i % every === 0 ? (
          <text key={g.key} x={x(i)} y={H - 8} className="chart-axis" textAnchor="middle">{g.label.length > 12 ? g.label.slice(0, 11) + "…" : g.label}</text>
        ) : null))}
        {line ? (
          <>
            <polyline
              fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={groups.map((g, i) => `${x(i)},${y(g.value)}`).join(" ")}
            />
            {hover !== null && groups[hover] && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="chart-cross" />
                <circle cx={x(hover)} cy={y(groups[hover].value)} r={5} fill={SERIES[0]} stroke="#fff" strokeWidth={2} />
              </>
            )}
          </>
        ) : groups.map((g, i) => {
          const h = Math.max(0, pad.t + ih - y(g.value));
          const r = Math.min(4, barW / 2, h);
          const bx = x(i) - barW / 2;
          const by = y(g.value);
          // Rounded data end (top), square at the baseline.
          const d = `M${bx},${by + h} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${by + h} Z`;
          return <path key={g.key} d={d} fill={groupColor(g, i, single)} opacity={hover === null || hover === i ? 1 : 0.55} />;
        })}
        {/* Hit areas wider than the marks */}
        {groups.map((g, i) => (
          <rect
            key={g.key} x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent"
            onMouseMove={(e) => { setHover(i); at(e, g.label, g.display, share(g.value, total)); }}
          />
        ))}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Donut: parts of a whole, a few groups at most, with a legend (identity never by colour alone). */
export function DonutChart({ groups, total, totalDisplay }: { groups: ChartGroup[]; total: number; totalDisplay: string }) {
  const { tip, at, clear } = useTip();
  const R = 80;
  const r = 52;
  const sum = groups.reduce((a, g) => a + Math.max(0, g.value), 0) || 1;
  let angle = -Math.PI / 2;
  const gap = groups.length > 1 ? 0.025 : 0; // 2px-ish surface gap between slices
  const arcs = groups.map((g, i) => {
    const sweep = (Math.max(0, g.value) / sum) * Math.PI * 2;
    const a0 = angle + gap / 2;
    const a1 = angle + sweep - gap / 2;
    angle += sweep;
    if (a1 <= a0) return null;
    const p = (rad: number, a: number) => `${100 + rad * Math.cos(a)},${100 + rad * Math.sin(a)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = sweep >= Math.PI * 2 - 0.001
      ? `M${p(R, 0)} A${R},${R} 0 1 1 ${p(R, Math.PI)} A${R},${R} 0 1 1 ${p(R, 0)} M${p(r, 0)} A${r},${r} 0 1 0 ${p(r, Math.PI)} A${r},${r} 0 1 0 ${p(r, 0)} Z`
      : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
    return { g, i, d };
  });
  return (
    <div className="chart donut" onMouseLeave={clear}>
      <svg viewBox="0 0 200 200" className="donut-svg" role="img" aria-label="Donut chart">
        {arcs.map((a) => a && (
          <path key={a.g.key} d={a.d} fill={groupColor(a.g, a.i, false)} fillRule="evenodd"
            onMouseMove={(e) => at(e, a.g.label, a.g.display, share(a.g.value, total))} />
        ))}
        <text x="100" y="96" textAnchor="middle" className="donut-total">{totalDisplay}</text>
        <text x="100" y="116" textAnchor="middle" className="donut-sub">total</text>
      </svg>
      <ul className="legend">
        {groups.map((g, i) => (
          <li key={g.key}>
            <span className="legend-swatch" style={{ background: groupColor(g, i, false) }} />
            <span className="legend-label">{g.label}</span>
            <span className="legend-value">{g.display}</span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}
