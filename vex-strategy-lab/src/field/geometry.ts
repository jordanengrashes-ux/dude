import type { Vec2 } from '../core/vec';
import { obbCorners, polyIntersectsAabb, convexPolysIntersect } from '../core/vec';
import type { QuadrantId } from '../rules/fieldState';
import type { Alliance } from '../rules/ruleset';

/**
 * Override field geometry (inches, field-centered game frame: x toward the blue
 * Alliance Station, y away from the audience). Dimensions are from the Game Manual
 * v1.1 Appendix A drawings (field, tape, Goal, Loader and object sheets).
 */

/** Tile seam spacing on the Appendix A field drawing (seams at ±23.545" and ±47.09"). */
export const TILE = 23.545;
/** Half the inside wall-to-wall dimension (140.41" on the field drawing; ~140.5" on the perimeter sheet). */
export const HALF = 140.41 / 2; // 70.205"
/** Field wall height (perimeter sheet: 11.50"). */
export const PERIMETER_HEIGHT = 11.5;
/** Wall thickness (perimeter sheet: 1.27"). */
export const PERIMETER_THICKNESS = 1.27;
/** One strip of white tape (measured on the tape sheet: the 2.50" Autonomous Line is two strips and a gap). */
export const TAPE_WIDTH = 0.75;
/** The Autonomous Line along x + y = 0: two tape strips, 2.50" outside to outside. */
export const AUTON_LINE_WIDTH = 2.5;

/**
 * Midfield: a diamond (a square turned 45°) of single tape whose centerline runs
 * through the four-tile corners (±TILE, 0) and (0, ±TILE). The volume is bounded by
 * the tape's inner edges: |x| + |y| ≤ MIDFIELD_REACH.
 */
export const MIDFIELD_REACH = TILE - (TAPE_WIDTH / 2) * Math.SQRT2; // 23.01"

/**
 * Pin: two tapered halves joined at a band — the band is Ø3.16" and 0.64" tall,
 * each half a cone from Ø2.35" at the band to a Ø1.40" tip; 6.50" long. Each half
 * nests in a Cup half (or a Goal socket) with the band on the rim. `profile`:
 * [radius, distance from the middle] (in), middle → tip.
 */
export const PIN = {
  diameter: 3.16,
  tipDiameter: 1.4,
  length: 6.5,
  half: 3.25,
  massKg: 0.072,
  profile: [
    [1.58, 0],
    [1.58, 0.32],
    [1.175, 0.36],
    [0.72, 3.1],
    [0.7, 3.25],
  ] as [number, number][],
} as const;

/**
 * Cup: an hourglass shell — Ø3.16" rims at both ends narrowing to a Ø2.32" waist
 * with a web at the middle; 6.48" long. Each half is a conical cup that takes one
 * Pin half. One half clear, the other gray.
 */
export const CUP = {
  diameter: 3.16,
  waistDiameter: 2.32,
  wall: 0.08,
  web: 0.15,
  length: 6.48,
  half: 3.24,
  massKg: 0.077,
} as const;

/**
 * How far a Pin standing in a loose Cup sits above the Pin–Cup stacking height: its
 * band's tapered underside rests on the Cup's rim, where the profile narrows to the
 * rim's inner radius (Goal stacks are drawn band-on-rim).
 */
export function pinSeatLift(): number {
  return pinProfileAt(CUP.diameter / 2 - CUP.wall);
}

/**
 * Goal top: a conical socket the first Pin's lower half drops into, band on the rim.
 * Its bore follows the Pin's cone with a little clearance (`clearance`, in) — a Ø2.37"
 * opening for the Ø2.35" cone — and the rim is `rimWidth` wide.
 */
export const GOAL_SOCKET = { topRadius: 2.37 / 2, depth: PIN.half, clearance: 0.03, rimWidth: 0.22, plate: 0.19 } as const;

/** Where a Pin's profile narrows to radius `r` (distance from its middle, in), from the band out. */
function pinProfileAt(r: number): number {
  const p = PIN.profile;
  for (let i = 1; i < p.length; i++) {
    const [r0, d0] = p[i - 1];
    const [r1, d1] = p[i];
    if (r0 >= r && r1 <= r) return r0 === r1 ? d0 : d0 + ((r0 - r) / (r0 - r1)) * (d1 - d0);
  }
  return 0;
}

/** How far the first Pin's middle sits above a Goal's rim: its band rests on the socket rim. */
export function socketLift(): number {
  return pinProfileAt(PIN.profile[2][0] + GOAL_SOCKET.clearance);
}

/** Distance between the middles of two nested pieces (a Pin in a Cup, or a Cup over a Pin). */
export function nestOffset(): number {
  return CUP.half + pinSeatLift();
}

/** Kind of the i-th element of a Goal stack (0 = the Pin in the socket). */
export const stackKind = (i: number): 'pin' | 'cup' => (i % 2 === 0 ? 'pin' : 'cup');

const halfOf = (k: 'pin' | 'cup') => (k === 'pin' ? PIN.half : CUP.half);

/** Height of the middle of the i-th element of a Goal stack whose rim is at `goalHeight`. */
export function stackCenter(goalHeight: number, i: number): number {
  return goalHeight + socketLift() + i * nestOffset();
}

/** Top of a Goal stack of n elements (the rim when empty). */
export function stackTop(goalHeight: number, n: number): number {
  return n === 0 ? goalHeight : stackCenter(goalHeight, n - 1) + halfOf(stackKind(n - 1));
}

/** Bottom of the next element of a Goal stack of n elements, once it has dropped in. */
export function stackNextBottom(goalHeight: number, n: number): number {
  return stackCenter(goalHeight, n) - halfOf(stackKind(n));
}

export interface GoalGeom {
  id: string;
  type: 'alliance' | 'neutral' | 'midfield';
  allianceColor?: Alliance;
  quadrant: QuadrantId | 'midfield';
  pos: Vec2;
  /** Height of the Goal's socket rim above the tiles. */
  height: number;
  baseRadius: number;
  postRadius: number;
}

/**
 * Toggle: a long triangular bar mounted on top of the middle of a field wall,
 * rotating about its long axis (parallel to the wall). Each of its three long faces
 * is red, yellow or blue; it is set to a color when it rests on a face in that
 * detent and no Robot touches it (SC4). Toggles start yellow face up and into the
 * field. Length 25.8" and ~2.05" faces are from a community transcription of
 * Appendix A; the mount position is an assumption.
 */
export interface ToggleGeom {
  id: string;
  quadrant: QuadrantId;
  /** Point on the inner face of the perimeter at the wall center. */
  pos: Vec2;
  /** Unit normal pointing into the field. */
  normal: Vec2;
  /** Unit vector along the wall (the rotation axis direction). */
  tangent: Vec2;
  /** Height of the rotation axis above the tiles (a face resting on the wall top). */
  pivotHeight: number;
  /** Horizontal offset of the axis from the inner wall face, into the field (in; negative = over the wall). */
  axisOffset: number;
  /** Bar length along the wall (in). */
  length: number;
  /** Width of each long face = side of the triangular cross-section (in). */
  faceWidth: number;
}

export const TOGGLE_LENGTH = 25.8;
export const TOGGLE_FACE = 2.05;

/**
 * Loader: a hopper on an Alliance Station wall, 11.44" from each corner. Its body
 * sticks 3.74" into the field and is 4.02" wide; Match Loads drop down its Ø3.39"
 * tube and come out of the 3.25"-tall opening at the bottom, facing the field.
 */
export const LOADER = { depth: 3.74, width: 4.02, tubeDiameter: 3.39, openingHeight: 3.25, height: 14, fromCenter: 58.765 } as const;

export interface LoaderGeom {
  id: string;
  alliance: Alliance;
  /** Center of the Loader body's footprint on the tiles. */
  pos: Vec2;
  /** Footprint half extents (axis-aligned). */
  halfSize: Vec2;
  /** Point on the wall's inner face behind the Loader. */
  wall: Vec2;
  /** Where a Match Load rests after introduction (inside the field, at the opening). */
  dispense: Vec2;
  /** Direction from the Loader into the field (robot approaches against it). */
  outward: Vec2;
  height: number;
}

const GOAL_HEIGHTS = { alliance: 3.25, neutral: 5.77, midfield: 8.77 } as const;

/** Quadrant: the four triangles between the field's diagonals. */
export function quadrantOf(p: Vec2): QuadrantId {
  if (Math.abs(p.x) >= Math.abs(p.y)) return p.x < 0 ? 'R1' : 'B1';
  return p.y < 0 ? 'R2' : 'B2';
}

/** Half width of the Autonomous Line band in x + y units. */
const LINE_S = (AUTON_LINE_WIDTH / 2) * Math.SQRT2;
/** The Midfield tape's outer edge in |x| + |y| units (the Autonomous Line runs around the Midfield). */
const DIAMOND_OUTER = TILE + (TAPE_WIDTH / 2) * Math.SQRT2;

/**
 * Alliance side of the Autonomous Line (red = the two red Quadrants, x + y < 0).
 * 'line' = on the Autonomous Line: the band between its two tape strips, or inside
 * the Midfield tape that it runs around.
 */
export function sideOf(p: Vec2): Alliance | 'line' {
  const s = p.x + p.y;
  if (Math.abs(s) <= LINE_S || Math.abs(p.x) + Math.abs(p.y) <= DIAMOND_OUTER) return 'line';
  return s < 0 ? 'red' : 'blue';
}

/** Distance from a point to the Autonomous Line (0 on it). */
export function distToAutonLine(p: Vec2): number {
  const band = Math.max(0, (Math.abs(p.x + p.y) - LINE_S) / Math.SQRT2);
  const diamond = Math.max(0, (Math.abs(p.x) + Math.abs(p.y) - DIAMOND_OUTER) / Math.SQRT2);
  return Math.min(band, diamond);
}

/** SG7b: a Scoring Object of radius `r` starting here is on the Autonomous Line (usable by both Alliances). */
export function onAutonLine(p: Vec2, r: number): boolean {
  return distToAutonLine(p) <= r;
}

export function inMidfieldPoint(p: Vec2): boolean {
  return Math.abs(p.x) + Math.abs(p.y) <= MIDFIELD_REACH;
}

/** The Midfield's boundary (inner tape edges), CCW. */
export function midfieldPolygon(): Vec2[] {
  const R = MIDFIELD_REACH;
  return [{ x: R, y: 0 }, { x: 0, y: R }, { x: -R, y: 0 }, { x: 0, y: -R }];
}

/** SC6: any part of the robot footprint within the Midfield volume. */
export function footprintInMidfield(center: Vec2, heading: number, length: number, width: number): boolean {
  return convexPolysIntersect(obbCorners(center, heading, length, width), midfieldPolygon());
}

/** Polygon (CCW) of an alliance's side of the Autonomous Line (outside the band), used for SG7 checks. */
export function sidePolygon(a: Alliance): Vec2[] {
  const o = LINE_S;
  if (a === 'red') return [{ x: -HALF, y: HALF - o }, { x: -HALF, y: -HALF }, { x: HALF - o, y: -HALF }];
  return [{ x: HALF, y: -HALF + o }, { x: HALF, y: HALF }, { x: -HALF + o, y: HALF }];
}

/** True if the footprint touches the opposing side of the Autonomous Line (SG7). */
export function footprintOnOpposingSide(center: Vec2, heading: number, length: number, width: number, alliance: Alliance): boolean {
  const opp: Alliance = alliance === 'red' ? 'blue' : 'red';
  const poly = obbCorners(center, heading, length, width);
  if (!convexPolysIntersect(poly, sidePolygon(opp))) return false;
  // the Autonomous Line and the Midfield it runs around are shared (SG8): check the
  // footprint's corners and edge midpoints against the opposing side itself
  const pts = [...poly, ...poly.map((p, i) => ({ x: (p.x + poly[(i + 1) % 4].x) / 2, y: (p.y + poly[(i + 1) % 4].y) / 2 }))];
  return pts.some((p) => sideOf(p) === opp);
}

export function buildGoals(): GoalGeom[] {
  const T = TILE;
  const g = (id: string, type: GoalGeom['type'], pos: Vec2, allianceColor?: Alliance): GoalGeom => ({
    id,
    type,
    allianceColor,
    quadrant: type === 'midfield' ? 'midfield' : quadrantOf(pos),
    pos,
    height: GOAL_HEIGHTS[type],
    baseRadius: type === 'midfield' ? 4 : 3,
    postRadius: 1.15,
  });
  return [
    g('G-R1a', 'alliance', { x: -2 * T, y: -T }, 'red'),
    g('G-R1n', 'neutral', { x: -2 * T, y: T }),
    g('G-R2a', 'alliance', { x: -T, y: -2 * T }, 'red'),
    g('G-R2n', 'neutral', { x: T, y: -2 * T }),
    g('G-B1a', 'alliance', { x: 2 * T, y: T }, 'blue'),
    g('G-B1n', 'neutral', { x: 2 * T, y: -T }),
    g('G-B2a', 'alliance', { x: T, y: 2 * T }, 'blue'),
    g('G-B2n', 'neutral', { x: -T, y: 2 * T }),
    g('G-MID', 'midfield', { x: 0, y: 0 }),
  ];
}

export function buildToggles(): ToggleGeom[] {
  // Axis centered over the wall top, a face resting on it (axis height = wall + inradius, side / 2√3).
  const mk = (id: string, quadrant: QuadrantId, pos: Vec2, normal: Vec2): ToggleGeom => ({
    id,
    quadrant,
    pos,
    normal,
    tangent: { x: -normal.y, y: normal.x },
    pivotHeight: PERIMETER_HEIGHT + TOGGLE_FACE / (2 * Math.sqrt(3)),
    axisOffset: -PERIMETER_THICKNESS / 2,
    length: TOGGLE_LENGTH,
    faceWidth: TOGGLE_FACE,
  });
  return [
    mk('T-R1', 'R1', { x: -HALF, y: 0 }, { x: 1, y: 0 }),
    mk('T-R2', 'R2', { x: 0, y: -HALF }, { x: 0, y: 1 }),
    mk('T-B1', 'B1', { x: HALF, y: 0 }, { x: -1, y: 0 }),
    mk('T-B2', 'B2', { x: 0, y: HALF }, { x: 0, y: -1 }),
  ];
}

export function buildLoaders(): LoaderGeom[] {
  const mk = (id: string, alliance: Alliance, sy: number): LoaderGeom => {
    const sx = alliance === 'red' ? -1 : 1;
    const y = sy * LOADER.fromCenter;
    const outward = { x: -sx, y: 0 };
    // a Match Load stands in front of the opening, just clear of the Loader body
    const d = LOADER.depth + PIN.diameter / 2 + 0.1;
    return {
      id,
      alliance,
      pos: { x: sx * (HALF - LOADER.depth / 2), y },
      halfSize: { x: LOADER.depth / 2, y: LOADER.width / 2 },
      wall: { x: sx * HALF, y },
      dispense: { x: sx * (HALF - d), y },
      outward,
      height: LOADER.height,
    };
  };
  return [mk('L-R-low', 'red', -1), mk('L-R-high', 'red', 1), mk('L-B-high', 'blue', 1), mk('L-B-low', 'blue', -1)];
}

/** Loader body footprint as an AABB: [minX, minY, maxX, maxY]. */
export function loaderAabb(l: LoaderGeom): [number, number, number, number] {
  return [l.pos.x - l.halfSize.x, l.pos.y - l.halfSize.y, l.pos.x + l.halfSize.x, l.pos.y + l.halfSize.y];
}

/**
 * Load Zones: the area around each Loader inside the outer edges of its colored
 * L of tape — 11.56" out from the Alliance Station wall and 24.47" along it from the
 * corner. As AABBs: [minX, minY, maxX, maxY].
 */
export const LOAD_ZONE = { depth: HALF - 58.65, length: HALF - 45.74 } as const;

export function loadZones(): { alliance: Alliance; aabb: [number, number, number, number] }[] {
  return buildLoaders().map((l) => {
    const sx = Math.sign(l.wall.x);
    const sy = Math.sign(l.wall.y);
    const x0 = sx * HALF;
    const y0 = sy * HALF;
    const x1 = x0 - sx * LOAD_ZONE.depth;
    const y1 = y0 - sy * LOAD_ZONE.length;
    return { alliance: l.alliance, aabb: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] as [number, number, number, number] };
  });
}

export function footprintInLoadZone(center: Vec2, heading: number, length: number, width: number, alliance: Alliance): boolean {
  const poly = obbCorners(center, heading, length, width);
  return loadZones()
    .filter((z) => z.alliance === alliance)
    .some((z) => polyIntersectsAabb(poly, ...z.aabb));
}

export interface TapeStrip {
  a: Vec2;
  b: Vec2;
  color: 'white' | Alliance;
}

/**
 * Tape on the tiles as strip centerlines, each TAPE_WIDTH wide (tape sheet): the
 * Autonomous Line's two strips from the corners to the Midfield, the Midfield
 * diamond, the single diagonal y = x between the Quadrants, and each Load Zone's
 * colored L (its outer edge on the zone boundary).
 */
export function tapeStrips(): TapeStrip[] {
  const T = TILE;
  const w = TAPE_WIDTH;
  const out: TapeStrip[] = [];
  // Autonomous Line strips: x + y = ±c, from the walls to the diamond's centerline (−x + y = T or x − y = T)
  const c = ((AUTON_LINE_WIDTH - w) / 2) * Math.SQRT2;
  for (const k of [-c, c]) {
    for (const s of [-1, 1]) {
      // s = −1: top-left half (x < 0); s = 1: bottom-right half
      const wall = s < 0 ? (k >= 0 ? { x: k - HALF, y: HALF } : { x: -HALF, y: k + HALF }) : k >= 0 ? { x: HALF, y: k - HALF } : { x: k + HALF, y: -HALF };
      const end = s < 0 ? { x: (k - T) / 2, y: (k + T) / 2 } : { x: (k + T) / 2, y: (k - T) / 2 };
      out.push({ a: wall, b: end, color: 'white' });
    }
  }
  // Midfield diamond
  const v = [{ x: T, y: 0 }, { x: 0, y: T }, { x: -T, y: 0 }, { x: 0, y: -T }];
  for (let i = 0; i < 4; i++) out.push({ a: v[i], b: v[(i + 1) % 4], color: 'white' });
  // y = x between the Quadrants, corners to the diamond
  out.push({ a: { x: -HALF, y: -HALF }, b: { x: -T / 2, y: -T / 2 }, color: 'white' });
  out.push({ a: { x: T / 2, y: T / 2 }, b: { x: HALF, y: HALF }, color: 'white' });
  // Load Zone L's
  for (const z of loadZones()) {
    const [x0, y0, x1, y1] = z.aabb;
    const sx = x0 <= -HALF + 1e-6 ? -1 : 1;
    const sy = y0 <= -HALF + 1e-6 ? -1 : 1;
    const xe = sx < 0 ? x1 - w / 2 : x0 + w / 2; // edge along the field side
    const ye = sy < 0 ? y1 - w / 2 : y0 + w / 2;
    out.push({ a: { x: xe, y: sy * HALF }, b: { x: xe, y: ye - (sy * w) / 2 }, color: z.alliance });
    out.push({ a: { x: sx * HALF, y: ye }, b: { x: xe + (sx * w) / 2, y: ye }, color: z.alliance });
  }
  return out;
}

/** True if any corner of the footprint is within `margin` of the perimeter. */
export function footprintTouchesPerimeter(center: Vec2, heading: number, length: number, width: number, margin = 0.15): boolean {
  return obbCorners(center, heading, length, width).some((p) => Math.abs(p.x) >= HALF - margin || Math.abs(p.y) >= HALF - margin);
}
