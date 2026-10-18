import { buildGoals } from '../field/geometry';
import type { FieldLayout } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import type { MatchType, OverrideParams, Alliance, HalfColor } from '../rules/ruleset';
import type { DriverInput } from '../sim/driver';
import type { HudData, SceneFrame } from '../sim/frame';

/** Goals by index (the aligner's Goal travels as a number). */
const GOAL_IDS = buildGoals().map((g) => g.id);

/**
 * Team-mode wire protocol. The host runs the only physics simulation; guests
 * render the host's snapshots and send their driver inputs.
 *
 *   guest → host   hello {name}             ask for the setup and a robot
 *                  claim {slot} / release   take a bot's robot / hand it back
 *                  input {slot, inp}        driver input (on change + heartbeat)
 *   host  → all    setup                    match type, field layout, robots, object list
 *                  roster                   who drives each slot (bot or player)
 *                  snap                     compact state snapshot (~8 Hz)
 *
 * Snapshots are integers: positions in millimeters, quaternions × 10⁴. Objects
 * that did not move are left out except in periodic keyframes.
 */

export const PROTOCOL_VERSION = 1;

export interface PeerInfo {
  peerId: string;
  name: string;
  role: 'host' | 'guest';
  at: number;
}

export interface RosterEntry {
  /** null = the slot's bot drives. */
  peerId: string | null;
  name: string;
}
export type Roster = Record<string, RosterEntry>;

export interface SetupMsg {
  v: number;
  hostId: string;
  matchType: MatchType;
  params: OverrideParams;
  layout: FieldLayout;
  robots: { id: string; alliance: Alliance; cfg: RobotConfig }[];
  objects: { id: string; kind: 'pin' | 'cup'; colors?: [HalfColor, HalfColor] }[];
  toggles: string[];
}

export interface WireSnap {
  /** Snapshot sequence number. */
  k: number;
  /** Keyframe (every object included). */
  f: 0 | 1;
  /** Robots in setup order: chassis p(3) q(4), carriage p(3) q(4), holder height (0.01"). */
  r: number[][];
  /** Objects: [index, x, y, z, qx, qy, qz, qw, stacked] or [index] when off the field. */
  o: number[][];
  /** Toggles in setup order: q(4). */
  g: number[][];
  h: HudData;
  playing: 0 | 1;
}

export type Msg =
  | { type: 'hello'; from: string; name: string }
  | { type: 'claim'; from: string; slot: string }
  | { type: 'release'; from: string }
  | { type: 'input'; from: string; slot: string; inp: DriverInput }
  | { type: 'setup'; from: string; to?: string; setup: SetupMsg }
  | { type: 'roster'; from: string; roster: Roster }
  | { type: 'snap'; from: string; snap: WireSnap }
  | { type: 'bye'; from: string }
  /** The host has no robot for this player (every one has a driver): they may watch or start their own game. */
  | { type: 'full'; from: string; to: string; players: number };

const MM = 1000;
const QS = 10000;
const p3 = (p: { x: number; y: number; z: number }) => [Math.round(p.x * MM), Math.round(p.y * MM), Math.round(p.z * MM)];
const q4 = (q: { x: number; y: number; z: number; w: number }) => [Math.round(q.x * QS), Math.round(q.y * QS), Math.round(q.z * QS), Math.round(q.w * QS)];

export function setupFrom(frame: SceneFrame, hostId: string, matchType: MatchType, params: OverrideParams, layout: FieldLayout): SetupMsg {
  return {
    v: PROTOCOL_VERSION,
    hostId,
    matchType,
    params,
    layout,
    robots: frame.robots.map((r) => ({ id: r.id, alliance: r.alliance, cfg: r.cfg })),
    objects: frame.objects.map((o) => ({ id: o.id, kind: o.kind, colors: o.colors })),
    toggles: frame.toggles.map((t) => t.id),
  };
}

/**
 * Encode a frame. `prev` holds the last sent integer object rows by index; objects
 * whose row is unchanged are skipped unless `keyframe`.
 */
export function encodeSnap(frame: SceneFrame, hud: HudData, k: number, keyframe: boolean, prev: Map<number, string>, playing: boolean): WireSnap {
  const o: number[][] = [];
  frame.objects.forEach((ob, i) => {
    const row = ob.p && ob.q ? [i, ...p3(ob.p), ...q4(ob.q), ob.stacked ? 1 : 0] : [i];
    // resend only visible changes (2 mm / 1e-3), so resting objects' solver jitter costs nothing
    const key = row.length > 1 ? row.map((v, j) => (j >= 1 && j <= 3 ? Math.round(v / 2) : j >= 4 && j <= 7 ? Math.round(v / 10) : v)).join(',') : '-';
    if (keyframe || prev.get(i) !== key) {
      o.push(row);
      prev.set(i, key);
    }
  });
  return {
    k,
    f: keyframe ? 1 : 0,
    r: frame.robots.map((r) => {
      // the aligner's target: a Goal by index, or −2 and its position for a loose piece
      const goal = r.align ? (r.align.at ? -2 : GOAL_IDS.indexOf(r.align.goal)) : -1;
      const a = r.align;
      const aim = a ? [Math.round((a.tol ?? 0) * 100), Math.round((a.from?.x ?? 0) * 100), Math.round((a.from?.y ?? 0) * 100)] : [0, 0, 0];
      const at = a?.at ? [Math.round(a.at.x * 100), Math.round(a.at.y * 100)] : [];
      // flags: claw closed, held kinds (2 bits), rollers (0 stopped, 1 in, 2 out)
      const rollers = (r.rollers ?? 0) > 0 ? 1 : (r.rollers ?? 0) < 0 ? 2 : 0;
      return [...p3(r.chassis.p), ...q4(r.chassis.q), ...p3(r.carriage.p), ...q4(r.carriage.q), Math.round(r.holderH * 100), (r.claw ? 1 : 0) | (r.holding << 1) | (rollers << 3), goal, a?.state ?? 0, Math.round((a?.top ?? 0) * 100), ...aim, ...at];
    }),
    o,
    g: frame.toggles.map((t) => q4(t.q)),
    h: hud,
    playing: playing ? 1 : 0,
  };
}

/** Rebuild a full frame from a snapshot on top of the previous one (objects not listed keep their pose). */
export function decodeSnap(snap: WireSnap, setup: SetupMsg, prev: SceneFrame | null, togglePos: Map<string, { x: number; y: number; z: number }>): SceneFrame {
  const P = (a: number[], i: number) => ({ x: a[i] / MM, y: a[i + 1] / MM, z: a[i + 2] / MM });
  const Q = (a: number[], i: number) => {
    const q = { x: a[i] / QS, y: a[i + 1] / QS, z: a[i + 2] / QS, w: a[i + 3] / QS };
    const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  };
  const objects: SceneFrame['objects'] = setup.objects.map((o, i) => {
    const old = prev?.objects[i];
    return { id: o.id, kind: o.kind, colors: o.colors, p: old?.p ?? null, q: old?.q ?? null, stacked: old?.stacked };
  });
  for (const row of snap.o) {
    const ob = objects[row[0]];
    if (!ob) continue;
    if (row.length < 8) {
      ob.p = null;
      ob.q = null;
    } else {
      ob.p = P(row, 1);
      ob.q = Q(row, 4);
      ob.stacked = row[8] === 1;
    }
  }
  return {
    t: snap.h.t,
    robots: setup.robots.map((r, i) => {
      const a = snap.r[i];
      const old = prev?.robots[i];
      const chassis = { p: P(a, 0), q: Q(a, 3) };
      const trail = old ? old.trail.slice(-400) : [];
      const last = trail[trail.length - 1];
      const g = { x: chassis.p.x / 0.0254, y: -chassis.p.z / 0.0254 };
      if (!last || Math.hypot(last.x - g.x, last.y - g.y) > 1) trail.push(g);
      const flags = a[15] ?? 0;
      const goal = a[16] ?? -1;
      const state = (a[17] ?? 0) as 0 | 1 | 2;
      const aim = { top: (a[18] ?? 0) / 100, tol: (a[19] ?? 0) / 100, from: { x: (a[20] ?? 0) / 100, y: (a[21] ?? 0) / 100 } };
      const align = goal >= 0 && GOAL_IDS[goal] ? { goal: GOAL_IDS[goal], state, ...aim } : goal === -2 ? { goal: 'piece', state, ...aim, at: { x: (a[22] ?? 0) / 100, y: (a[23] ?? 0) / 100 } } : null;
      const rollers = (flags >> 3) & 3;
      return { id: r.id, alliance: r.alliance, cfg: r.cfg, chassis, carriage: { p: P(a, 7), q: Q(a, 10) }, holderH: a[14] / 100, trail, claw: (flags & 1) === 1, holding: (flags >> 1) & 3, rollers: rollers === 1 ? 1 : rollers === 2 ? -1 : 0, align };
    }),
    objects,
    toggles: setup.toggles.map((id, i) => ({ id, p: togglePos.get(id) ?? { x: 0, y: 0, z: 0 }, q: Q(snap.g[i], 0) })),
  };
}

/** Interpolate two frames (same structure) at fraction a ∈ [0, 1]. */
export function lerpFrame(a: SceneFrame, b: SceneFrame, f: number): SceneFrame {
  const lp = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => ({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f });
  const lq = (p: { x: number; y: number; z: number; w: number }, q: { x: number; y: number; z: number; w: number }) => {
    const d = p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w;
    const s = d < 0 ? -1 : 1;
    const r = { x: p.x + (s * q.x - p.x) * f, y: p.y + (s * q.y - p.y) * f, z: p.z + (s * q.z - p.z) * f, w: p.w + (s * q.w - p.w) * f };
    const n = Math.hypot(r.x, r.y, r.z, r.w) || 1;
    return { x: r.x / n, y: r.y / n, z: r.z / n, w: r.w / n };
  };
  return {
    t: a.t + (b.t - a.t) * f,
    robots: b.robots.map((rb, i) => {
      const ra = a.robots[i];
      if (!ra) return rb;
      return { ...rb, chassis: { p: lp(ra.chassis.p, rb.chassis.p), q: lq(ra.chassis.q, rb.chassis.q) }, carriage: { p: lp(ra.carriage.p, rb.carriage.p), q: lq(ra.carriage.q, rb.carriage.q) }, holderH: ra.holderH + (rb.holderH - ra.holderH) * f };
    }),
    objects: b.objects.map((ob, i) => {
      const oa = a.objects[i];
      if (!oa?.p || !oa.q || !ob.p || !ob.q) return ob;
      return { ...ob, p: lp(oa.p, ob.p), q: lq(oa.q, ob.q) };
    }),
    toggles: b.toggles.map((tb, i) => (a.toggles[i] ? { ...tb, q: lq(a.toggles[i].q, tb.q) } : tb)),
  };
}
