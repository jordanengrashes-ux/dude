import { useRef, type ReactNode } from 'react';
import type { Vec2 } from '../../core/vec';
import { buildGoals, buildLoaders, buildToggles, HALF, loadZones, TAPE_WIDTH, TILE } from '../../field/geometry';
import { PIN_COLORS, type FieldLayout } from '../../field/layout';

/**
 * Overhead field drawn in SVG, in field inches: x to the right (toward the blue
 * Alliance Station), y up. Children are drawn in the same coordinates (inside a
 * y-flip), so overlays and pointer handlers work in inches.
 */

export const FIELD_COLORS = { red: '#e05252', blue: '#3b82f6', yellow: '#f2c94c', white: '#f0efec', green: '#3fb950', tile: '#3a3b3e', seam: '#2e2f32', ink: '#f0efec', muted: '#9a9894' };
export const halfColor = (c: string) => (c === 'red' ? FIELD_COLORS.red : c === 'blue' ? FIELD_COLORS.blue : FIELD_COLORS.yellow);

export interface FieldPointer {
  down?: (p: Vec2, e: React.PointerEvent<SVGSVGElement>) => void;
  move?: (p: Vec2, e: React.PointerEvent<SVGSVGElement>) => void;
  up?: (p: Vec2, e: React.PointerEvent<SVGSVGElement>) => void;
}

/** Text that reads upright inside the y-flipped field group. */
export function FieldText({ x, y, children, size = 3, fill = FIELD_COLORS.ink, anchor = 'middle', weight = 600 }: { x: number; y: number; children: ReactNode; size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number }) {
  return (
    <text x={x} y={-y} transform="scale(1,-1)" fontSize={size} fill={fill} textAnchor={anchor} dominantBaseline="central" fontWeight={weight} style={{ pointerEvents: 'none', userSelect: 'none' }}>
      {children}
    </text>
  );
}

export function PlanField({ layout, children, pointer, cursor = 'crosshair', highlightSlot, svgRef }: { layout: FieldLayout; children?: ReactNode; pointer?: FieldPointer; cursor?: string; highlightSlot?: string; svgRef?: React.RefObject<SVGSVGElement> }) {
  const own = useRef<SVGSVGElement>(null);
  const ref = svgRef ?? own;
  const P = HALF + 3;
  const toField = (e: React.PointerEvent<SVGSVGElement>): Vec2 => {
    const svg = ref.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg.getScreenCTM();
    const q = m ? pt.matrixTransform(m.inverse()) : pt;
    return { x: q.x, y: -q.y };
  };
  const goals = buildGoals();
  const toggles = buildToggles();
  const loaders = buildLoaders();
  return (
    <svg
      ref={ref}
      className="plan-field"
      viewBox={`${-P} ${-P} ${2 * P} ${2 * P}`}
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={(e) => pointer?.down?.(toField(e), e)}
      onPointerMove={(e) => pointer?.move?.(toField(e), e)}
      onPointerUp={(e) => pointer?.up?.(toField(e), e)}
      role="img"
      aria-label="Overhead view of the field"
    >
      <g transform="scale(1,-1)">
        <rect x={-HALF - 1.5} y={-HALF - 1.5} width={2 * HALF + 3} height={2 * HALF + 3} fill="#5c5e62" />
        <rect x={-HALF} y={-HALF} width={2 * HALF} height={2 * HALF} fill={FIELD_COLORS.tile} />
        {[-2, -1, 0, 1, 2].map((k) => (
          <g key={k} stroke={FIELD_COLORS.seam} strokeWidth={0.4}>
            <line x1={k * TILE} y1={-HALF} x2={k * TILE} y2={HALF} />
            <line x1={-HALF} y1={k * TILE} x2={HALF} y2={k * TILE} />
          </g>
        ))}
        {loadZones().map((z, i) => (
          <rect key={i} x={z.aabb[0]} y={z.aabb[1]} width={z.aabb[2] - z.aabb[0]} height={z.aabb[3] - z.aabb[1]} fill={z.alliance === 'red' ? FIELD_COLORS.red : FIELD_COLORS.blue} opacity={0.22} />
        ))}
        {/* Autonomous Line and Midfield tape */}
        <line x1={-HALF} y1={HALF} x2={HALF} y2={-HALF} stroke={FIELD_COLORS.white} strokeWidth={TAPE_WIDTH} opacity={0.85} />
        <rect x={-TILE} y={-TILE} width={2 * TILE} height={2 * TILE} fill="none" stroke={FIELD_COLORS.white} strokeWidth={TAPE_WIDTH} opacity={0.85} />
        {loaders.map((l) => (
          <g key={l.id}>
            <rect x={Math.min(l.corner.x, l.corner.x - Math.sign(l.corner.x) * l.footprint)} y={Math.min(l.corner.y, l.corner.y - Math.sign(l.corner.y) * l.footprint)} width={l.footprint} height={l.footprint} fill={l.alliance === 'red' ? FIELD_COLORS.red : FIELD_COLORS.blue} opacity={0.75} />
            <circle cx={l.dispense.x} cy={l.dispense.y} r={1} fill="none" stroke={FIELD_COLORS.white} strokeWidth={0.4} strokeDasharray="0.8 0.6" />
          </g>
        ))}
        {toggles.map((t) => {
          const c = layout.toggles?.[t.id] ?? 'yellow';
          const a = { x: t.pos.x - (t.tangent.x * t.length) / 2, y: t.pos.y - (t.tangent.y * t.length) / 2 };
          const b = { x: t.pos.x + (t.tangent.x * t.length) / 2, y: t.pos.y + (t.tangent.y * t.length) / 2 };
          return <line key={t.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={halfColor(c)} strokeWidth={2.2} strokeLinecap="round" />;
        })}
        {goals.map((g) => (
          <g key={g.id}>
            <circle cx={g.pos.x} cy={g.pos.y} r={g.baseRadius} fill={g.type === 'alliance' ? (g.allianceColor === 'red' ? '#7a2b2b' : '#22406e') : g.type === 'midfield' ? '#4b4b4b' : '#555'} stroke={g.type === 'alliance' ? (g.allianceColor === 'red' ? FIELD_COLORS.red : FIELD_COLORS.blue) : '#9a9a9a'} strokeWidth={0.6} />
            <circle cx={g.pos.x} cy={g.pos.y} r={g.postRadius} fill="#2a2a2a" />
          </g>
        ))}
        {layout.cups.map((c) =>
          c.start.where === 'field' ? <circle key={c.id} cx={c.start.pos.x} cy={c.start.pos.y} r={1.6} fill={c.start.grayUp ? '#8c8f94' : '#d9dde3'} fillOpacity={c.start.grayUp ? 1 : 0.55} stroke="#2a2a2a" strokeWidth={0.3} /> : null,
        )}
        {layout.pins.map((p) => {
          if (p.start.where !== 'field') return null;
          const [c0, c1] = PIN_COLORS[p.type];
          const top = p.start.upColor;
          const bottom = top === c1 ? c0 : c1;
          return <circle key={p.id} cx={p.start.pos.x} cy={p.start.pos.y} r={1.5} fill={halfColor(top)} stroke={halfColor(bottom)} strokeWidth={0.7} />;
        })}
        {layout.robots.map((r) => (
          <rect
            key={r.slot}
            x={r.pos.x - 8}
            y={r.pos.y - 8}
            width={16}
            height={16}
            transform={`rotate(${(r.heading * 180) / Math.PI} ${r.pos.x} ${r.pos.y})`}
            fill="none"
            stroke={r.alliance === 'red' ? FIELD_COLORS.red : FIELD_COLORS.blue}
            strokeWidth={r.slot === highlightSlot ? 0.9 : 0.5}
            strokeDasharray={r.slot === highlightSlot ? undefined : '1.5 1'}
            opacity={r.slot === highlightSlot ? 1 : 0.6}
          />
        ))}
        {goals.map((g) => (
          <FieldText key={g.id} x={g.pos.x} y={g.pos.y - g.baseRadius - 2.2} size={2.6} fill={FIELD_COLORS.muted}>
            {g.id.replace('G-', '')}
          </FieldText>
        ))}
        {children}
      </g>
    </svg>
  );
}

/** A 16" robot outline with a heading notch. */
export function RobotGhost({ pos, heading, color, opacity = 1, dashed = false }: { pos: Vec2; heading: number; color: string; opacity?: number; dashed?: boolean }) {
  const deg = (heading * 180) / Math.PI;
  return (
    <g transform={`rotate(${deg} ${pos.x} ${pos.y})`} opacity={opacity} style={{ pointerEvents: 'none' }}>
      <rect x={pos.x - 8} y={pos.y - 8} width={16} height={16} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={0.7} strokeDasharray={dashed ? '1.5 1' : undefined} />
      <polygon points={`${pos.x + 8},${pos.y} ${pos.x + 4},${pos.y + 3} ${pos.x + 4},${pos.y - 3}`} fill={color} />
    </g>
  );
}
