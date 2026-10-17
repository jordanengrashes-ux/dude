import { useEffect, useRef, useState } from 'react';
import { buildGoals, buildLoaders, buildToggles, CUP, HALF, LOAD_ZONE_SIZE, PIN, TILE } from '../../field/geometry';
import { PIN_COLORS, type FieldLayout } from '../../field/layout';
import { obbCorners, type Vec2 } from '../../core/vec';
import type { StepInfo } from '../../planner/model';
import { headingOf, upOf } from '../../physics/frames';
import { IN } from '../../core/units';
import { runner } from '../simRunner';
import { team } from '../../net/session';
import { setLayout, store, useApp } from '../store';

/**
 * Overhead 2D view. Live: robots, objects, stacks, Toggles, planned route,
 * trajectories. Setup mode: drag objects/robot starts to edit the starting layout;
 * measure tool: click two points to read distance.
 */

const C = { red: '#d9534f', blue: '#3b82f6', yellow: '#e8c21b', ink: '#f0efec', muted: '#898781', line: '#2c2c2a' };
const hc = (c: string) => (c === 'red' ? C.red : c === 'blue' ? C.blue : C.yellow);

export function TopDown({ steps, editable, height = 420 }: { steps?: StepInfo[] | null; editable?: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const show = useApp((s) => s.show);
  const layout = useApp((s) => s.layout);
  const tool = useApp((s) => s.setupTool);
  const [measure, setMeasure] = useState<Vec2[]>([]);
  const [drag, setDrag] = useState<{ kind: 'pin' | 'cup' | 'robot'; id: string } | null>(null);
  const [, force] = useState(0);
  useEffect(() => runner.subscribe(() => force((x) => x + 1)), []);

  const sizeRef = useRef({ w: 400, h: height });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // A hidden tab reports width 0; keep the last real size instead of drawing into nothing.
      if (el.clientWidth < 32) return;
      sizeRef.current = { w: el.clientWidth, h: height };
      force((x) => x + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  const scale = () => {
    const { w, h } = sizeRef.current;
    const S = Math.min(w, h) - 16;
    return { S, ox: (w - S) / 2, oy: (h - S) / 2, k: S / (2 * HALF) };
  };
  const toPx = (p: Vec2) => {
    const { ox, oy, k } = scale();
    return { x: ox + (p.x + HALF) * k, y: oy + (HALF - p.y) * k };
  };
  const toField = (px: number, py: number): Vec2 => {
    const { ox, oy, k } = scale();
    return { x: (px - ox) / k - HALF, y: HALF - (py - oy) / k };
  };

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const { w, h } = sizeRef.current;
    if (Math.min(w, h) <= 16) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0d0d0d';
    g.fillRect(0, 0, w, h);
    const { k } = scale();
    const P = toPx;
    // field
    const a = P({ x: -HALF, y: HALF });
    g.fillStyle = '#2a2b2d';
    g.fillRect(a.x, a.y, 2 * HALF * k, 2 * HALF * k);
    g.strokeStyle = '#3a3b3e';
    g.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const x = P({ x: -HALF + i * TILE, y: 0 }).x;
      const y = P({ x: 0, y: -HALF + i * TILE }).y;
      g.beginPath();
      g.moveTo(x, a.y);
      g.lineTo(x, a.y + 2 * HALF * k);
      g.moveTo(a.x, y);
      g.lineTo(a.x + 2 * HALF * k, y);
      g.stroke();
    }
    if (show.zones)
      for (const l of buildLoaders()) {
        const sx = Math.sign(l.corner.x);
        const sy = Math.sign(l.corner.y);
        const p1 = P({ x: sx * HALF, y: sy * HALF });
        const p2 = P({ x: sx * (HALF - LOAD_ZONE_SIZE), y: sy * (HALF - LOAD_ZONE_SIZE) });
        g.fillStyle = l.alliance === 'red' ? 'rgba(217,83,79,0.22)' : 'rgba(59,130,246,0.22)';
        g.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        const c = P(l.corner);
        g.fillStyle = l.alliance === 'red' ? '#7a2e2c' : '#24477e';
        const F = l.footprint * k;
        g.fillRect(c.x - (sx > 0 ? F : 0), c.y - (sy > 0 ? 0 : F), F, F);
      }
    // tape
    g.strokeStyle = 'rgba(242,242,242,0.85)';
    g.lineWidth = 2.5 * k;
    g.beginPath();
    for (const [x, y] of [
      [-1, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
    ]) {
      const s1 = P({ x: x * HALF, y: y * HALF });
      const s2 = P({ x: x * TILE, y: y * TILE });
      g.moveTo(s1.x, s1.y);
      g.lineTo(s2.x, s2.y);
    }
    const m1 = P({ x: -TILE, y: TILE });
    g.rect(m1.x, m1.y, 2 * TILE * k, 2 * TILE * k);
    g.stroke();
    g.strokeStyle = '#9aa0a6';
    g.lineWidth = 3;
    g.strokeRect(a.x, a.y, 2 * HALF * k, 2 * HALF * k);
    // alliance stations
    g.fillStyle = C.red;
    g.fillRect(a.x - 7, P({ x: 0, y: 30 }).y, 4, 60 * k);
    g.fillStyle = C.blue;
    g.fillRect(a.x + 2 * HALF * k + 3, P({ x: 0, y: 30 }).y, 4, 60 * k);

    // live state: the local physics, or the host's snapshots when this tab is a team-mode guest
    const frame = team.role === 'guest' ? (team.session?.frameAt() ?? null) : (runner.sim?.sceneFrame() ?? null);
    const fs = team.role === 'guest' ? null : runner.sim?.extractFieldState();
    // goals with stack count
    for (const gg of buildGoals()) {
      const c = P(gg.pos);
      g.beginPath();
      g.arc(c.x, c.y, gg.baseRadius * k, 0, Math.PI * 2);
      g.fillStyle = gg.type === 'alliance' ? (gg.allianceColor === 'red' ? '#7a2e2c' : '#24477e') : '#55585c';
      g.fill();
      g.beginPath();
      g.arc(c.x, c.y, gg.postRadius * k, 0, Math.PI * 2);
      g.fillStyle = '#c3c2b7';
      g.fill();
      const st = fs?.goals.find((x) => x.id === gg.id)?.stack;
      if (st && st.length) {
        // show stack as a column of colored ticks
        st.forEach((e, i) => {
          const y = c.y - gg.baseRadius * k - 4 - i * 5;
          if (e.kind === 'pin') {
            g.fillStyle = hc(e.bottom);
            g.fillRect(c.x - 6, y - 4, 6, 4);
            g.fillStyle = hc(e.top);
            g.fillRect(c.x, y - 4, 6, 4);
          } else {
            g.fillStyle = e.grayDown ? '#55585c' : '#c8d2dc';
            g.fillRect(c.x - 6, y - 4, 12, 4);
          }
        });
      }
      if (show.labels) {
        g.fillStyle = C.muted;
        g.font = '10px system-ui';
        g.fillText(gg.id.replace('G-', ''), c.x + gg.baseRadius * k + 2, c.y + 3);
      }
    }
    // toggles
    for (const tg of buildToggles()) {
      const c = P({ x: tg.pos.x + tg.normal.x * 1.5, y: tg.pos.y + tg.normal.y * 1.5 });
      const pos = fs?.toggles.find((x) => x.quadrant === tg.quadrant)?.position ?? 'yellow';
      g.fillStyle = pos === 'red' ? C.red : pos === 'blue' ? C.blue : pos === 'yellow' ? C.yellow : '#777';
      g.beginPath();
      g.moveTo(c.x, c.y - 7);
      g.lineTo(c.x + 7, c.y + 6);
      g.lineTo(c.x - 7, c.y + 6);
      g.closePath();
      g.fill();
    }
    // objects
    const drawPin = (p: Vec2, colors: [string, string], up: boolean, lying: boolean) => {
      const c = P(p);
      const r = Math.max(2.5, (PIN.diameter / 2) * k * (lying ? 1.2 : 1.6));
      g.beginPath();
      g.arc(c.x, c.y, r, 0, Math.PI * 2);
      g.fillStyle = hc(up ? colors[1] : colors[0]);
      g.fill();
      g.beginPath();
      g.arc(c.x, c.y, r * 0.5, 0, Math.PI * 2);
      g.fillStyle = hc(up ? colors[0] : colors[1]);
      g.fill();
    };
    const drawCup = (p: Vec2, grayUp: boolean) => {
      const c = P(p);
      g.beginPath();
      g.arc(c.x, c.y, (CUP.diameter / 2) * k, 0, Math.PI * 2);
      g.strokeStyle = grayUp ? '#8c9096' : '#dfe7ef';
      g.lineWidth = 2;
      g.stroke();
    };
    if (frame && !editable) {
      for (const o of frame.objects) {
        if (!o.p || !o.q || o.stacked) continue;
        const p = { x: o.p.x / IN, y: -o.p.z / IN };
        const up = upOf(o.q);
        if (o.kind === 'pin') drawPin(p, o.colors!, up.y >= 0, Math.abs(up.y) < 0.7);
        else drawCup(p, up.y >= 0);
      }
    } else {
      drawLayout(layout);
    }
    function drawLayout(L: FieldLayout) {
      for (const pn of L.pins) if (pn.start.where === 'field') drawPin(pn.start.pos, PIN_COLORS[pn.type], pn.start.upColor === PIN_COLORS[pn.type][1], false);
      for (const c of L.cups) if (c.start.where === 'field') drawCup(c.start.pos, c.start.grayUp);
    }
    // planned route
    if (show.route && steps) {
      g.strokeStyle = 'rgba(255,138,128,0.85)';
      g.lineWidth = 2;
      for (const s of steps) {
        if (s.path.length < 2) continue;
        g.beginPath();
        s.path.forEach((p, i) => {
          const q = P(p);
          if (i) g.lineTo(q.x, q.y);
          else g.moveTo(q.x, q.y);
        });
        g.stroke();
      }
      steps.forEach((s, i) => {
        const q = P(s.endPos);
        const kind = s.action.type;
        g.fillStyle = kind === 'place' ? '#ffd54f' : kind === 'pick' || kind === 'load' ? '#80cbc4' : kind === 'toggle' ? '#ce93d8' : '#ffffff';
        g.beginPath();
        g.arc(q.x, q.y, 7, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#0d0d0d';
        g.font = 'bold 9px system-ui';
        g.textAlign = 'center';
        g.fillText(String(i + 1), q.x, q.y + 3);
        g.textAlign = 'left';
      });
    }
    // robots + trails
    const robots = frame && !editable ? frame.robots.map((r) => ({ id: r.id, alliance: r.alliance, pos: { x: r.chassis.p.x / IN, y: -r.chassis.p.z / IN }, heading: headingOf(r.chassis.q), L: r.cfg.chassis.lengthIn, W: r.cfg.chassis.widthIn, trail: r.trail })) : layout.robots.map((r) => ({ id: r.slot, alliance: r.alliance, pos: r.pos, heading: r.heading, L: 16, W: 16, trail: [] as { x: number; y: number }[] }));
    for (const r of robots) {
      if (show.trails && r.trail.length > 1) {
        g.strokeStyle = r.alliance === 'red' ? 'rgba(217,83,79,0.5)' : 'rgba(59,130,246,0.5)';
        g.lineWidth = 1.5;
        g.beginPath();
        r.trail.forEach((p, i) => {
          const q = P(p);
          if (i) g.lineTo(q.x, q.y);
          else g.moveTo(q.x, q.y);
        });
        g.stroke();
      }
      const poly = obbCorners(r.pos, r.heading, r.L, r.W).map(P);
      g.beginPath();
      poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.fillStyle = r.alliance === 'red' ? 'rgba(217,83,79,0.35)' : 'rgba(59,130,246,0.35)';
      g.fill();
      g.strokeStyle = r.alliance === 'red' ? C.red : C.blue;
      g.lineWidth = 2;
      g.stroke();
      const c = P(r.pos);
      const f = P({ x: r.pos.x + Math.cos(r.heading) * r.L * 0.5, y: r.pos.y + Math.sin(r.heading) * r.L * 0.5 });
      g.strokeStyle = C.ink;
      g.beginPath();
      g.moveTo(c.x, c.y);
      g.lineTo(f.x, f.y);
      g.stroke();
      if (show.labels) {
        g.fillStyle = C.ink;
        g.font = '10px system-ui';
        g.fillText(r.id, c.x + 10, c.y - 10);
      }
    }
    // measurement
    if (measure.length) {
      g.strokeStyle = '#ffffff';
      g.setLineDash([4, 3]);
      const p0 = P(measure[0]);
      g.beginPath();
      g.arc(p0.x, p0.y, 3, 0, Math.PI * 2);
      g.stroke();
      if (measure.length === 2) {
        const p1 = P(measure[1]);
        g.beginPath();
        g.moveTo(p0.x, p0.y);
        g.lineTo(p1.x, p1.y);
        g.stroke();
        const d = Math.hypot(measure[1].x - measure[0].x, measure[1].y - measure[0].y);
        g.setLineDash([]);
        g.fillStyle = '#ffffff';
        g.font = '12px system-ui';
        g.fillText(`${d.toFixed(1)}" (${(d * 2.54).toFixed(1)} cm)`, (p0.x + p1.x) / 2 + 6, (p0.y + p1.y) / 2 - 6);
      }
      g.setLineDash([]);
    }
  });

  const onDown = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const f = toField(e.clientX - rect.left, e.clientY - rect.top);
    if (tool === 'measure') {
      setMeasure((m) => (m.length >= 2 ? [f] : [...m, f]));
      return;
    }
    if (!editable) return;
    const L = store.get().layout;
    let best: { kind: 'pin' | 'cup' | 'robot'; id: string; d: number } | null = null;
    for (const p of L.pins) if (p.start.where === 'field') {
      const d = Math.hypot(p.start.pos.x - f.x, p.start.pos.y - f.y);
      if (d < 3 && (!best || d < best.d)) best = { kind: 'pin', id: p.id, d };
    }
    for (const c of L.cups) if (c.start.where === 'field') {
      const d = Math.hypot(c.start.pos.x - f.x, c.start.pos.y - f.y);
      if (d < 3 && (!best || d < best.d)) best = { kind: 'cup', id: c.id, d };
    }
    for (const r of L.robots) {
      const d = Math.hypot(r.pos.x - f.x, r.pos.y - f.y);
      if (d < 8 && (!best || d < best.d)) best = { kind: 'robot', id: r.slot, d };
    }
    if (best) {
      setDrag(best);
      store.set({ selection: { kind: best.kind === 'robot' ? 'robot' : 'object', id: best.id } });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag || tool !== 'move') return;
    const rect = ref.current!.getBoundingClientRect();
    const f = toField(e.clientX - rect.left, e.clientY - rect.top);
    const clampP = (p: Vec2) => ({ x: Math.max(-HALF + 2, Math.min(HALF - 2, Math.round(p.x * 2) / 2)), y: Math.max(-HALF + 2, Math.min(HALF - 2, Math.round(p.y * 2) / 2)) });
    const L = { ...store.get().layout };
    if (drag.kind === 'pin') L.pins = L.pins.map((p) => (p.id === drag.id && p.start.where === 'field' ? { ...p, start: { ...p.start, pos: clampP(f) } } : p));
    else if (drag.kind === 'cup') L.cups = L.cups.map((c) => (c.id === drag.id && c.start.where === 'field' ? { ...c, start: { ...c.start, pos: clampP(f) } } : c));
    else L.robots = L.robots.map((r) => (r.slot === drag.id ? { ...r, pos: clampP(f) } : r));
    store.set({ layout: L });
  };
  const onUp = () => {
    if (drag) {
      setDrag(null);
      setLayout(store.get().layout);
    }
  };

  return (
    <div ref={wrap} style={{ width: '100%', height }}>
      <canvas ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ display: 'block', cursor: tool === 'measure' ? 'crosshair' : editable && tool === 'move' ? 'grab' : 'default' }} aria-label="Overhead field view" role="img" />
    </div>
  );
}
