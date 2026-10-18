import type { Vec2 } from '../core/vec';
import type { Alliance, HalfColor, MatchType } from '../rules/ruleset';
import { obbCorners } from '../core/vec';
import { buildGoals, footprintInLoadZone, footprintTouchesPerimeter, HALF, TILE, PIN, CUP, quadrantOf, sideOf } from './geometry';

/**
 * Starting layout of every Scoring Object and Robot, from the Game Manual v1.1
 * (Appendix A object-placement sheet, Figure SG-1, <SG5>, <RSC2>, <RSC4>).
 *
 * Head-to-Head, per the manual's counts (36 Cups and 33 Pins on the tiles):
 *  - four "crosses" on the Autonomous Line at (−2T, 2T), (−T, T), (T, −T), (2T, −2T):
 *    a clear-up Cup with four Pins lying around it, yellow halves in — red/yellow
 *    Pins on its −x and −y sides, blue/yellow on +x and +y;
 *  - a red/blue Pin standing in a clear-up Cup at each Midfield corner, red up on
 *    the red side;
 *  - a yellow Pin in a clear-up Cup at (±T, ±T) and (±2T, ±2T) (same signs);
 *  - eight rows against the walls, centered on the tile seams at ±T: gray-up Cup,
 *    yellow Pin in a gray-up Cup, gray-up Cup;
 *  - a yellow Pin on each neutral Goal and the Midfield Goal.
 * Skills: the same tiles, empty Goals, one Robot in R1 and the red Loaders only.
 * Every position stays editable at runtime (Field Setup panel) and in saved scenarios.
 */

export type PinType = 'RB' | 'RY' | 'BY' | 'YY';

export const PIN_COLORS: Record<PinType, [HalfColor, HalfColor]> = {
  RB: ['red', 'blue'],
  RY: ['red', 'yellow'],
  BY: ['blue', 'yellow'],
  YY: ['yellow', 'yellow'],
};

export type PinStart =
  /**
   * Standing (`upColor` up) — in the Cup `inCup` when given — or lying down with
   * `upColor`'s end pointing along field heading `axis`.
   */
  | { where: 'field'; pos: Vec2; upColor: HalfColor; lying?: boolean; axis?: number; inCup?: string }
  | { where: 'goal'; goalId: string; bottom: HalfColor; top: HalfColor; index?: number }
  | { where: 'preload'; robotSlot: string; upColor: HalfColor }
  | { where: 'held'; robotSlot: string; upColor: HalfColor }
  | { where: 'matchload'; alliance: Alliance }
  | { where: 'unavailable' };

export type CupStart =
  | { where: 'field'; pos: Vec2; grayUp: boolean; lying?: boolean }
  | { where: 'goal'; goalId: string; grayDown: boolean; index: number }
  | { where: 'held'; robotSlot: string; grayUp: boolean }
  | { where: 'matchload'; alliance: Alliance }
  | { where: 'unavailable' };

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
  /** Placed by hand (Plan tab, Field Setup): used as is, not fitted to the robot's size. */
  exact?: boolean;
}

export interface FieldLayout {
  matchType: MatchType;
  pins: PinSpec[];
  cups: CupSpec[];
  robots: RobotStart[];
  /** Toggle positions by Toggle id (default yellow). */
  toggles?: Record<string, 'red' | 'yellow' | 'blue'>;
  /** Human-readable provenance shown in the UI. */
  provenance: string;
}

const T = TILE;

/** Crosses on the Autonomous Line. */
export const CROSS_CENTERS: Vec2[] = [
  { x: -2 * T, y: 2 * T },
  { x: -T, y: T },
  { x: T, y: -T },
  { x: 2 * T, y: -2 * T },
];
/** Lying Pins sit with their middles this far from the cross center. */
export const CROSS_ARM = 4.83;

/** Midfield corners: red/blue Pin in a clear-up Cup, red up on the red side. */
const MIDFIELD_CORNERS: { pos: Vec2; up: HalfColor }[] = [
  { pos: { x: -T, y: 0 }, up: 'red' },
  { pos: { x: 0, y: -T }, up: 'red' },
  { pos: { x: T, y: 0 }, up: 'blue' },
  { pos: { x: 0, y: T }, up: 'blue' },
];

/** Yellow Pins in clear-up Cups on the y = x diagonal. */
const DIAGONAL_SPOTS: Vec2[] = [
  { x: -2 * T, y: -2 * T },
  { x: -T, y: -T },
  { x: T, y: T },
  { x: 2 * T, y: 2 * T },
];

/** Rows against the walls: their pieces touch the wall, 3.16" apart along it. */
export const WALL_ROW_OFFSET = HALF - CUP.diameter / 2; // 68.625"
const ROW_SPACING = CUP.diameter;
function wallRows(): { center: Vec2; along: Vec2 }[] {
  const out: { center: Vec2; along: Vec2 }[] = [];
  for (const s of [-1, 1]) {
    for (const t of [-T, T]) {
      out.push({ center: { x: s * WALL_ROW_OFFSET, y: t }, along: { x: 0, y: 1 } });
      out.push({ center: { x: t, y: s * WALL_ROW_OFFSET }, along: { x: 1, y: 0 } });
    }
  }
  return out;
}

/** SG1: one Robot per Quadrant, touching its Alliance's wall (positions as in Figure SG-1, for a 16" robot). */
export const DEFAULT_ROBOT_STARTS: RobotStart[] = [
  { slot: 'red-1', alliance: 'red', pos: { x: -HALF + 8, y: 6 }, heading: 0 },
  { slot: 'red-2', alliance: 'red', pos: { x: -6, y: -HALF + 8 }, heading: Math.PI / 2 },
  { slot: 'blue-1', alliance: 'blue', pos: { x: HALF - 8, y: -6 }, heading: Math.PI },
  { slot: 'blue-2', alliance: 'blue', pos: { x: 6, y: HALF - 8 }, heading: -Math.PI / 2 },
];

/**
 * A start pose moved so a robot of this size touches the wall it backs onto, the
 * way the layout's 16" robot does (SG1f). Poses away from the walls are unchanged.
 */
export function fitStartToWall(start: { pos: Vec2; heading: number; exact?: boolean }, length: number, width: number): { pos: Vec2; heading: number } {
  if (start.exact) return { pos: { ...start.pos }, heading: start.heading };
  const pos = { ...start.pos };
  const c = Math.abs(Math.cos(start.heading));
  const s = Math.abs(Math.sin(start.heading));
  const hx = (c * length + s * width) / 2;
  const hy = (s * length + c * width) / 2;
  if (HALF - Math.abs(pos.x) < 12) pos.x = Math.sign(pos.x) * (HALF - hx);
  if (HALF - Math.abs(pos.y) < 12) pos.y = Math.sign(pos.y) * (HALF - hy);
  return { pos, heading: start.heading };
}

/**
 * What keeps a starting pose from being legal (SG1): the robot must touch the field
 * wall and the tiles on its own side of the Autonomous Line, and stay off the Load
 * Zones. Empty when it's fine. Pieces and other robots are not checked.
 */
export function startProblems(pos: Vec2, heading: number, length: number, width: number, alliance: Alliance, matchType: MatchType): string[] {
  const out: string[] = [];
  const poly = obbCorners(pos, heading, length, width);
  if (poly.some((p) => Math.abs(p.x) > HALF + 0.05 || Math.abs(p.y) > HALF + 0.05)) out.push('it sticks out of the field');
  else if (!footprintTouchesPerimeter(pos, heading, length, width, 0.3)) out.push("it doesn't touch the field wall");
  if (matchType === 'headToHead') {
    const pts = [...poly, ...poly.map((p, i) => ({ x: (p.x + poly[(i + 1) % 4].x) / 2, y: (p.y + poly[(i + 1) % 4].y) / 2 }))];
    if (pts.some((p) => sideOf(p) !== alliance)) out.push('it touches the Autonomous Line or the other side');
  } else if (quadrantOf(pos) !== 'R1') out.push('Skills robots start in the Quadrant by the red Alliance Station (R1)');
  if (footprintInLoadZone(pos, heading, length, width, 'red') || footprintInLoadZone(pos, heading, length, width, 'blue')) out.push('it is in a Load Zone');
  return out;
}

export function buildLayout(matchType: MatchType = 'headToHead'): FieldLayout {
  const pins: PinSpec[] = [];
  const cups: CupSpec[] = [];
  let pinN = 0;
  let cupN = 0;
  const pid = (t: PinType) => `P${String(++pinN).padStart(2, '0')}-${t}`;
  const cid = () => `C${String(++cupN).padStart(2, '0')}`;
  const isSkills = matchType !== 'headToHead';
  const cup = (pos: Vec2, grayUp: boolean) => {
    const id = cid();
    cups.push({ id, kind: 'cup', start: { where: 'field', pos, grayUp } });
    return id;
  };
  const pinInCup = (t: PinType, pos: Vec2, upColor: HalfColor, grayUp: boolean) => {
    const inCup = cup(pos, grayUp);
    pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'field', pos, upColor, inCup } });
  };

  for (const c of CROSS_CENTERS) {
    cup(c, false);
    // the colored end points out, yellow in
    for (const [dx, dy, t] of [
      [1, 0, 'BY'],
      [0, 1, 'BY'],
      [-1, 0, 'RY'],
      [0, -1, 'RY'],
    ] as [number, number, PinType][]) {
      const pos = { x: c.x + dx * CROSS_ARM, y: c.y + dy * CROSS_ARM };
      pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'field', pos, upColor: PIN_COLORS[t][0], lying: true, axis: Math.atan2(dy, dx) } });
    }
  }
  for (const m of MIDFIELD_CORNERS) pinInCup('RB', m.pos, m.up, false);
  for (const d of DIAGONAL_SPOTS) pinInCup('YY', d, 'yellow', false);
  for (const r of wallRows()) {
    cup({ x: r.center.x - r.along.x * ROW_SPACING, y: r.center.y - r.along.y * ROW_SPACING }, true);
    pinInCup('YY', r.center, 'yellow', true);
    cup({ x: r.center.x + r.along.x * ROW_SPACING, y: r.center.y + r.along.y * ROW_SPACING }, true);
  }
  // Neutral and Midfield Goals start with a yellow/yellow Pin Placed (Head-to-Head only; RSC4c).
  if (!isSkills) {
    for (const g of buildGoals()) {
      if (g.type === 'alliance') continue;
      pins.push({ id: pid('YY'), kind: 'pin', type: 'YY', start: { where: 'goal', goalId: g.id, bottom: 'yellow', top: 'yellow' } });
    }
  }

  // Preloads (SG5) and Match Loads
  const robots = isSkills ? [DEFAULT_ROBOT_STARTS[0]] : DEFAULT_ROBOT_STARTS;
  if (isSkills) {
    pins.push({ id: pid('RY'), kind: 'pin', type: 'RY', start: { where: 'preload', robotSlot: 'red-1', upColor: 'yellow' } });
    for (let i = 0; i < 3; i++) pins.push({ id: pid('RY'), kind: 'pin', type: 'RY', start: { where: 'matchload', alliance: 'red' } });
    for (let i = 0; i < 4; i++) pins.push({ id: pid('BY'), kind: 'pin', type: 'BY', start: { where: 'matchload', alliance: 'red' } });
    for (let i = 0; i < 7; i++) cups.push({ id: cid(), kind: 'cup', start: { where: 'matchload', alliance: 'red' } });
  } else {
    for (const r of robots) {
      const t: PinType = r.alliance === 'red' ? 'RY' : 'BY';
      pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'preload', robotSlot: r.slot, upColor: 'yellow' } });
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const t: PinType = a === 'red' ? 'RY' : 'BY';
      for (let i = 0; i < 10; i++) pins.push({ id: pid(t), kind: 'pin', type: t, start: { where: 'matchload', alliance: a } });
      pins.push({ id: pid('YY'), kind: 'pin', type: 'YY', start: { where: 'matchload', alliance: a } });
      for (let i = 0; i < 10; i++) cups.push({ id: cid(), kind: 'cup', start: { where: 'matchload', alliance: a } });
    }
  }

  return {
    matchType,
    pins,
    cups,
    robots: robots.map((r) => ({ ...r, pos: { ...r.pos } })),
    provenance: 'Official layout: Game Manual v1.1 Appendix A object placement and Figure SG-1 robot starts. Edit in Field Setup.',
  };
}

export function cloneLayout(l: FieldLayout): FieldLayout {
  return JSON.parse(JSON.stringify(l));
}

export const OBJECT_DIMS = { PIN, CUP };
