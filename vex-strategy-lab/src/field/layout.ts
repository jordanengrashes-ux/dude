import type { Vec2 } from '../core/vec';
import { dist, obbCorners, distPointToPolygon } from '../core/vec';
import type { Alliance, HalfColor, MatchType } from '../rules/ruleset';
import { buildGoals, buildLoaders, buildToggles, HALF, sideOf, PIN, CUP } from './geometry';

/**
 * Starting layout of every Scoring Object and Robot.
 *
 * ASSUMPTION: exact Appendix A coordinates could not be retrieved, so this layout
 * is a rule-consistent approximation: correct object counts and color splits,
 * 180° rotational symmetry with red↔blue swapped, and clear of all Field Elements.
 * Every position is editable at runtime (Field Setup panel) and in saved scenarios.
 */

export type PinType = 'RB' | 'RY' | 'BY' | 'YY';

export const PIN_COLORS: Record<PinType, [HalfColor, HalfColor]> = {
  RB: ['red', 'blue'],
  RY: ['red', 'yellow'],
  BY: ['blue', 'yellow'],
  YY: ['yellow', 'yellow'],
};

export type PinStart =
  | { where: 'field'; pos: Vec2; upColor: HalfColor }
  | { where: 'goal'; goalId: string; bottom: HalfColor; top: HalfColor }
  | { where: 'preload'; robotSlot: string; upColor: HalfColor }
  | { where: 'matchload'; alliance: Alliance };

export type CupStart =
  | { where: 'field'; pos: Vec2; grayUp: boolean }
  | { where: 'matchload'; alliance: Alliance };

export interface PinSpec {
  id: string;
  kind: 'pin';
  type: PinType;
  start: PinStart;
}

export interface CupSpec {
  id: string;
  kind: 'cup';
  start: CupStart;
}

export interface RobotStart {
  slot: string;
  alliance: Alliance;
  pos: Vec2;
  heading: number;
}

export interface FieldLayout {
  matchType: MatchType;
  pins: PinSpec[];
  cups: CupSpec[];
  robots: RobotStart[];
  /** Human-readable provenance shown in the UI. */
  provenance: string;
}

const rot180 = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });
const swapType = (t: PinType): PinType => (t === 'RY' ? 'BY' : t === 'BY' ? 'RY' : t);

/** Red-side field pins (inches). Blue side is the 180° rotation with colors swapped. */
const RED_SIDE_PINS: { type: PinType; pos: Vec2 }[] = [
  { type: 'YY', pos: { x: -36, y: -8 } },
  { type: 'YY', pos: { x: -8, y: -36 } },
  { type: 'YY', pos: { x: -30, y: -30 } },
  { type: 'YY', pos: { x: -56, y: -48 } },
  { type: 'YY', pos: { x: -48, y: -56 } },
  { type: 'YY', pos: { x: -14, y: -14 } },
  { type: 'RY', pos: { x: -36, y: 14 } },
  { type: 'RY', pos: { x: 14, y: -36 } },
  { type: 'RY', pos: { x: -40, y: -40 } },
  { type: 'RY', pos: { x: -36, y: -62 } },
  { type: 'RY', pos: { x: -48, y: -34 } },
  { type: 'RY', pos: { x: -34, y: -48 } },
  { type: 'BY', pos: { x: -6, y: -56 } },
  { type: 'BY', pos: { x: -56, y: -6 } },
];

/** Red/blue Pins sit on the Autonomous Line diagonal (shared). Listed once per symmetric pair. */
const LINE_PINS: Vec2[] = [
  { x: -36, y: 36 },
  { x: -8, y: 8 },
];

export const DEFAULT_ROBOT_STARTS: RobotStart[] = [
  { slot: 'red-1', alliance: 'red', pos: { x: -61, y: -36 }, heading: 0 },
  { slot: 'red-2', alliance: 'red', pos: { x: -61, y: 36 }, heading: 0 },
  { slot: 'blue-1', alliance: 'blue', pos: { x: 61, y: 36 }, heading: Math.PI },
  { slot: 'blue-2', alliance: 'blue', pos: { x: 61, y: -36 }, heading: Math.PI },
];

const ROBOT_FOOT = 18; // clearance computed against the maximum legal starting footprint

/** Deterministic farthest-point selection of cup spots on the red side. */
function redSideCupSpots(occupied: Vec2[], count: number): Vec2[] {
  const goals = buildGoals();
  const toggles = buildToggles();
  const loaders = buildLoaders();
  const robots = DEFAULT_ROBOT_STARTS.map((r) => obbCorners(r.pos, r.heading, ROBOT_FOOT, ROBOT_FOOT));
  const candidates: Vec2[] = [];
  for (let x = -66; x <= 66; x += 3) {
    for (let y = -66; y <= 66; y += 3) {
      const p = { x, y };
      if (sideOf(p) !== 'red') continue;
      if (Math.abs(x) > HALF - 5 || Math.abs(y) > HALF - 5) continue;
      if (goals.some((g) => dist(g.pos, p) < g.baseRadius + 5)) continue;
      if (toggles.some((t) => dist(t.pos, p) < 12)) continue;
      if (loaders.some((l) => dist(l.corner, p) < 22)) continue;
      if (robots.some((poly) => distPointToPolygon(p, poly) < 4)) continue;
      if (occupied.some((o) => dist(o, p) < 6.5)) continue;
      // keep the blue mirror clear of the red-side spot set too
      if (occupied.some((o) => dist(o, rot180(p)) < 6.5)) continue;
      candidates.push(p);
    }
  }
  const chosen: Vec2[] = [];
  // Seed: candidate nearest the red Alliance Goal in R1 (deterministic).
  const seed = buildGoals().find((g) => g.id === 'G-R1a')!.pos;
  let best = candidates.reduce((a, b) => (dist(a, seed) <= dist(b, seed) ? a : b));
  chosen.push(best);
  while (chosen.length < count) {
    let bestD = -1;
    for (const c of candidates) {
      const d = Math.min(...chosen.map((s) => dist(s, c)), ...occupied.map((o) => dist(o, c) + 4));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    chosen.push(best);
  }
  return chosen;
}

let cachedCupSpots: Vec2[] | null = null;

export function buildLayout(matchType: MatchType = 'headToHead'): FieldLayout {
  const pins: PinSpec[] = [];
  const cups: CupSpec[] = [];
  let pinN = 0;
  let cupN = 0;
  const pid = (t: PinType) => `P${String(++pinN).padStart(2, '0')}-${t}`;
  const cid = () => `C${String(++cupN).padStart(2, '0')}`;
  const isSkills = matchType !== 'headToHead';

  // Field pins
  for (const p of RED_SIDE_PINS) {
    pins.push({ id: pid(p.type), kind: 'pin', type: p.type, start: { where: 'field', pos: p.pos, upColor: PIN_COLORS[p.type][1] } });
    const bt = swapType(p.type);
    pins.push({ id: pid(bt), kind: 'pin', type: bt, start: { where: 'field', pos: rot180(p.pos), upColor: PIN_COLORS[bt][1] } });
  }
  for (const p of LINE_PINS) {
    pins.push({ id: pid('RB'), kind: 'pin', type: 'RB', start: { where: 'field', pos: p, upColor: 'blue' } });
    pins.push({ id: pid('RB'), kind: 'pin', type: 'RB', start: { where: 'field', pos: rot180(p), upColor: 'red' } });
  }
  // Neutral and Midfield Goals start with a yellow/yellow Pin Placed (Head-to-Head only).
  for (const g of buildGoals()) {
    if (g.type === 'alliance') continue;
    if (isSkills) continue; // RSC4: Goals begin empty in Skills
    pins.push({ id: pid('YY'), kind: 'pin', type: 'YY', start: { where: 'goal', goalId: g.id, bottom: 'yellow', top: 'yellow' } });
  }

  // Preloads and match loads
  const robots = isSkills ? [DEFAULT_ROBOT_STARTS[0]] : DEFAULT_ROBOT_STARTS;
  if (isSkills) {
    pins.push({ id: pid('RY'), kind: 'pin', type: 'RY', start: { where: 'preload', robotSlot: 'red-1', upColor: 'yellow' } });
    for (let i = 0; i < 3; i++) pins.push({ id: pid('RY'), kind: 'pin', type: 'RY', start: { where: 'matchload', alliance: 'red' } });
    for (let i = 0; i < 4; i++) pins.push({ id: pid('BY'), kind: 'pin', type: 'BY', start: { where: 'matchload', alliance: 'red' } });
  } else {
    for (const r of robots) {
      const t: PinType = r.alliance === 'red' ? 'RY' : 'BY';
      pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'preload', robotSlot: r.slot, upColor: 'yellow' } });
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const t: PinType = a === 'red' ? 'RY' : 'BY';
      for (let i = 0; i < 10; i++) pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'matchload', alliance: a } });
      pins.push({ id: pid('YY'), kind: 'pin', type: 'YY', start: { where: 'matchload', alliance: a } });
    }
  }

  // Cups: 18 per side (12 gray-up, 6 clear-up), mirrored.
  if (!cachedCupSpots) {
    const occupied = [...RED_SIDE_PINS.map((p) => p.pos), ...LINE_PINS, ...LINE_PINS.map(rot180), ...RED_SIDE_PINS.map((p) => rot180(p.pos))];
    cachedCupSpots = redSideCupSpots(occupied, 18);
  }
  cachedCupSpots.forEach((pos, i) => {
    const grayUp = i % 3 !== 2; // 12 gray-up, 6 clear-up per side
    cups.push({ id: cid(), kind: 'cup', start: { where: 'field', pos, grayUp } });
    cups.push({ id: cid(), kind: 'cup', start: { where: 'field', pos: rot180(pos), grayUp } });
  });
  if (isSkills) {
    for (let i = 0; i < 7; i++) cups.push({ id: cid(), kind: 'cup', start: { where: 'matchload', alliance: 'red' } });
  } else {
    for (const a of ['red', 'blue'] as Alliance[]) for (let i = 0; i < 10; i++) cups.push({ id: cid(), kind: 'cup', start: { where: 'matchload', alliance: a } });
  }

  return {
    matchType,
    pins,
    cups,
    robots: robots.map((r) => ({ ...r, pos: { ...r.pos } })),
    provenance:
      'Approximate layout: official counts/colors, 180° symmetric, positions not from Appendix A (unavailable). Edit in Field Setup.',
  };
}

export function cloneLayout(l: FieldLayout): FieldLayout {
  return JSON.parse(JSON.stringify(l));
}

export const OBJECT_DIMS = { PIN, CUP };
