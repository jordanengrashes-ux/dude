import { useMemo, useRef, useState } from 'react';

/**
 * Minimal SVG charts for the analysis dashboard.
 * Palette (dark surface #1a1a19, validated with the dataviz validator):
 *   alliances red #e66767 / blue #3987e5; generic series blue #3987e5, orange #d95926, aqua #199e70.
 * One y-axis per chart, 2px lines, recessive grid, crosshair + tooltip listing
 * every series, legend for ≥ 2 series, and a table view.
 */

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number }[];
}

export const SERIES = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', red: '#e66767' };

const W = 520;
const H = 200;
const M = { l: 44, r: 12, t: 10, b: 26 };

function niceTicks(min: number, max: number, n = 4): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min) return [min || 0];
  const raw = (max - min) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function LineChart({ title, series, xLabel, yLabel, step = false, yMin }: { title: string; series: Series[]; xLabel: string; yLabel: string; step?: boolean; yMin?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const { x0, x1, y0, y1 } = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) for (const p of s.points) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    if (yMin !== undefined) y0 = Math.min(yMin, y0);
    if (!isFinite(x0)) return { x0: 0, x1: 1, y0: 0, y1: 1 };
    if (y1 - y0 < 1e-9) y1 = y0 + 1;
    return { x0, x1: Math.max(x1, x0 + 1e-6), y0, y1: y1 + (y1 - y0) * 0.05 };
  }, [series, yMin]);
  const X = (x: number) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
  const Y = (y: number) => H - M.b - ((y - y0) / (y1 - y0)) * (H - M.t - M.b);
  const path = (pts: { x: number; y: number }[]) => {
    let d = '';
    pts.forEach((p, i) => {
      if (i === 0) d += `M${X(p.x)},${Y(p.y)}`;
      else if (step) d += `H${X(p.x)}V${Y(p.y)}`;
      else d += `L${X(p.x)},${Y(p.y)}`;
    });
    return d;
  };
  const valueAt = (s: Series, x: number) => {
    let best: { x: number; y: number } | null = null;
    for (const p of s.points) {
      if (step ? p.x <= x : true) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x) || (step && p.x <= x && p.x > best.x)) best = p;
    }
    return best;
  };
  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const x = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
    setHover(Math.max(x0, Math.min(x1, x)));
  };
  const empty = series.every((s) => s.points.length === 0);
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <button className="link" onClick={() => setTable((t) => !t)}>{table ? 'Chart' : 'Table'}</button>
      </figcaption>
      {series.length >= 2 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {empty ? (
        <div className="chart-empty">No data yet — run the simulation.</div>
      ) : table ? (
        <div className="chart-table">
          <table>
            <thead>
              <tr>
                <th>{xLabel}</th>
                {series.map((s) => (
                  <th key={s.name}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series[0].points
                .filter((_, i) => i % Math.max(1, Math.floor(series[0].points.length / 40)) === 0)
                .map((p) => (
                  <tr key={p.x}>
                    <td>{fmt(p.x)}</td>
                    {series.map((s) => (
                      <td key={s.name}>{fmt(valueAt(s, p.x)?.y ?? NaN)}</td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-svg-wrap">
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
            {niceTicks(y0, y1).map((t) => (
              <g key={t}>
                <line x1={M.l} x2={W - M.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" strokeWidth={1} />
                <text x={M.l - 6} y={Y(t) + 3} textAnchor="end" className="tick">
                  {fmt(t)}
                </text>
              </g>
            ))}
            {niceTicks(x0, x1, 6).map((t) => (
              <text key={t} x={X(t)} y={H - M.b + 14} textAnchor="middle" className="tick">
                {fmt(t)}
              </text>
            ))}
            <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--axis)" />
            <text x={W - M.r} y={H - 2} textAnchor="end" className="axis-label">
              {xLabel}
            </text>
            <text x={4} y={M.t + 2} className="axis-label">
              {yLabel}
            </text>
            {series.map((s) => (
              <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            ))}
            {hover !== null && (
              <g>
                <line x1={X(hover)} x2={X(hover)} y1={M.t} y2={H - M.b} stroke="var(--text-secondary)" strokeWidth={1} />
                {series.map((s) => {
                  const v = valueAt(s, hover);
                  return v ? <circle key={s.name} cx={X(v.x)} cy={Y(v.y)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} /> : null;
                })}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: `${(X(hover) / W) * 100}%` }}>
              <div className="tt-x">
                {xLabel} {fmt(hover)}
              </div>
              {series.map((s) => {
                const v = valueAt(s, hover);
                return (
                  <div key={s.name} className="tt-row">
                    <i style={{ background: s.color }} />
                    <strong>{v ? fmt(v.y) : '—'}</strong> <span>{s.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export interface Bar {
  label: string;
  value: number;
  color?: string;
  note?: string;
}

export function BarChart({ title, bars, unit, format = fmt }: { title: string; bars: Bar[]; unit: string; format?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1e-9, ...bars.map((b) => Math.abs(b.value)));
  const rowH = 20;
  const h = bars.length * (rowH + 2) + 8;
  const labelW = 190;
  const w = 520;
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
      </figcaption>
      {bars.length === 0 ? (
        <div className="chart-empty">No data yet.</div>
      ) : (
        <div className="chart-svg-wrap">
          <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
            {bars.map((b, i) => {
              const y = 4 + i * (rowH + 2);
              const bw = (Math.abs(b.value) / max) * (w - labelW - 60);
              return (
                <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                  <rect x={0} y={y} width={w} height={rowH} fill="transparent" />
                  <text x={labelW - 6} y={y + rowH / 2 + 4} textAnchor="end" className="tick">
                    {b.label.length > 30 ? b.label.slice(0, 29) + '…' : b.label}
                  </text>
                  <rect x={labelW} y={y + 3} width={Math.max(2, bw)} height={rowH - 6} rx={3} fill={b.color ?? SERIES.blue} opacity={hover === null || hover === i ? 1 : 0.55} />
                  <text x={labelW + Math.max(2, bw) + 6} y={y + rowH / 2 + 4} className="tick">
                    {format(b.value)} {unit}
                  </text>
                </g>
              );
            })}
          </svg>
          {hover !== null && bars[hover] && (
            <div className="tooltip" style={{ left: '60%', top: `${(hover / Math.max(1, bars.length)) * 100}%` }}>
              <div className="tt-row">
                <strong>
                  {format(bars[hover].value)} {unit}
                </strong>{' '}
                <span>{bars[hover].label}</span>
              </div>
              {bars[hover].note && <div className="tt-x">{bars[hover].note}</div>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Histogram of Monte Carlo outcomes. */
export function Histogram({ title, values, target }: { title: string; values: number[]; target: number | null }) {
  if (!values.length) return <BarChart title={title} bars={[]} unit="" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const nb = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(values.length))));
  const bw = (hi - lo) / nb || 1;
  const bins = Array.from({ length: nb }, (_, i) => ({ a: lo + i * bw, b: lo + (i + 1) * bw, n: 0 }));
  for (const v of values) bins[Math.min(nb - 1, Math.floor((v - lo) / bw))].n++;
  return (
    <BarChart
      title={title}
      unit="trials"
      format={(v) => String(Math.round(v))}
      bars={bins.map((b) => ({
        label: `${b.a.toFixed(0)}–${b.b.toFixed(0)} pts`,
        value: b.n,
        color: target !== null && b.a >= target ? SERIES.aqua : SERIES.blue,
        note: target !== null ? (b.a >= target ? 'at or above target' : 'below target') : undefined,
      }))}
    />
  );
}
