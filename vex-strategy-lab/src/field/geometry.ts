import type { Vec2 } from '../core/vec';
import { obbCorners, polyIntersectsAabb, convexPolysIntersect } from '../core/vec';
import type { QuadrantId } from '../rules/fieldState';
import type { Alliance } from '../rules/ruleset';

/**
 * Override field geometry (inches, field-centered game frame).
 * See rules/ruleset.ts OVERRIDE_RULES for provenance of each constant.
 */

/** 600 mm foam tile (VEX field system). */
export const TILE = 600 / 25.4; // 23.622"
/** Half the inside dimension of the perimeter (3 tiles). */
export const HALF = 3 * TILE; // 70.866"
/** Field wall height: 11.5" nominal (GDC Q&A allows 11.5"–12.5"; older VEX field drawings list 11.50"). */
export const PERIMETER_HEIGHT = 11.5;
export const PERIMETER_THICKNESS = 1.5; // assumption (extrusion + panel depth)
export const TAPE_WIDTH = 2.5; // Autonomous Line tape width (official extract: 2.50 in)

/** Midfield: square of tape centered on the tile seams at ±1 tile; volume = inner edges. */
export const MIDFIELD_INNER_HALF = TILE - TAPE_WIDTH / 2; // 22.372"

/** Load Zone: square in each Loader corner (approximate footprint). */
export const LOAD_ZONE_SIZE = TILE; // assumption

export const PIN = {
  diameter: 1.6,
  length: 6.5,
  half: 3.25,
  massKg: 0.08,
} as const;

export const CUP = {
  diameter: 3.15,
  length: 6.5,
  half: 3.25,
  massKg: 0.06,
} as const;

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
 * detent and no Robot touches it (SC4). Length 25.8" and ~2.05" faces are from a
 * community transcription of Appendix A; the mount position is an assumption.
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

export interface LoaderGeom {
  id: string;
  alliance: Alliance;
  corner: Vec2;
  /** Where a Match Load rests after introduction (inside the field, at the chute mouth). */
  dispense: Vec2;
  /** Direction from the dispense point into the field (robot approaches against it). */
  outward: Vec2;
  footprint: number;
}

const GOAL_HEIGHTS = { alliance: 3.25, neutral: 5.8, midfield: 8.7 } as const;

export function quadrantOf(p: Vec2): QuadrantId {
  if (Math.abs(p.x) >= Math.abs(p.y)) return p.x < 0 ? 'R1' : 'B1';
  return p.y < 0 ? 'R2' : 'B2';
}

/** Alliance side of the Autonomous Line (red = the two red Quadrants, x + y < 0). */
export function sideOf(p: Vec2): Alliance | 'line' {
  const s = p.x + p.y;
  const halfTapeDiag = (TAPE_WIDTH / 2) * Math.SQRT2;
  if (s < -halfTapeDiag) return 'red';
  if (s > halfTapeDiag) return 'blue';
  return 'line';
}

export function inMidfieldPoint(p: Vec2): boolean {
  return Math.abs(p.x) <= MIDFIELD_INNER_HALF && Math.abs(p.y) <= MIDFIELD_INNER_HALF;
}

/** SC6: any part of the robot footprint within the Midfield volume. */
export function footprintInMidfield(center: Vec2, heading: number, length: number, width: number): boolean {
  const poly = obbCorners(center, heading, length, width);
  return polyIntersectsAabb(poly, -MIDFIELD_INNER_HALF, -MIDFIELD_INNER_HALF, MIDFIELD_INNER_HALF, MIDFIELD_INNER_HALF);
}

/** Polygon (CCW) of an alliance's side of the Autonomous Line, used for SG7 checks. */
export function sidePolygon(a: Alliance): Vec2[] {
  const o = (TAPE_WIDTH / 2) * Math.SQRT2 * 0.5;
  if (a === 'red') return [{ x: -HALF, y: HALF - o }, { x: -HALF, y: -HALF }, { x: HALF - o, y: -HALF }];
  return [{ x: HALF, y: -HALF + o }, { x: HALF, y: HALF }, { x: -HALF + o, y: HALF }];
}

/** True if the footprint touches the opposing side of the Autonomous Line (SG7). */
export function footprintOnOpposingSide(center: Vec2, heading: number, length: number, width: number, alliance: Alliance): boolean {
  const opp: Alliance = alliance === 'red' ? 'blue' : 'red';
  const poly = obbCorners(center, heading, length, width);
  if (!convexPolysIntersect(poly, sidePolygon(opp))) return false;
  // Midfield is shared territory (SG8); only count contact outside the Midfield square.
  const outsideMid = poly.some((p) => !inMidfieldPoint(p) && sideOf(p) === opp);
  return outsideMid;
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
  const F = 6; // loader footprint (assumption)
  const mk = (id: string, alliance: Alliance, sx: number, sy: number): LoaderGeom => {
    const corner = { x: sx * HALF, y: sy * HALF };
    const outward = { x: -sx * Math.SQRT1_2, y: -sy * Math.SQRT1_2 };
    // Loader box occupies the corner square of side F; its inner corner is F·√2 from the field corner.
    // Match Loads rest just outside it, on the diagonal.
    // 3.7" offset keeps a 16" robot facing the corner at 45° inside the perimeter (assumption).
    const d = F * Math.SQRT2 + 3.7;
    return { id, alliance, corner, dispense: { x: corner.x + outward.x * d, y: corner.y + outward.y * d }, outward, footprint: F };
  };
  return [mk('L-R-low', 'red', -1, -1), mk('L-R-high', 'red', -1, 1), mk('L-B-high', 'blue', 1, 1), mk('L-B-low', 'blue', 1, -1)];
}

/** Load Zone squares (corner-anchored) as AABBs: [minX, minY, maxX, maxY]. */
export function loadZones(): { alliance: Alliance; aabb: [number, number, number, number] }[] {
  return buildLoaders().map((l) => {
    const sx = Math.sign(l.corner.x);
    const sy = Math.sign(l.corner.y);
    const x0 = sx * HALF;
    const y0 = sy * HALF;
    const x1 = x0 - sx * LOAD_ZONE_SIZE;
    const y1 = y0 - sy * LOAD_ZONE_SIZE;
    return { alliance: l.alliance, aabb: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] as [number, number, number, number] };
  });
}

export function footprintInLoadZone(center: Vec2, heading: number, length: number, width: number, alliance: Alliance): boolean {
  const poly = obbCorners(center, heading, length, width);
  return loadZones()
    .filter((z) => z.alliance === alliance)
    .some((z) => polyIntersectsAabb(poly, ...z.aabb));
}

/** True if any corner of the footprint is within `margin` of the perimeter. */
export function footprintTouchesPerimeter(center: Vec2, heading: number, length: number, width: number, margin = 0.15): boolean {
  return obbCorners(center, heading, length, width).some((p) => Math.abs(p.x) >= HALF - margin || Math.abs(p.y) >= HALF - margin);
}
