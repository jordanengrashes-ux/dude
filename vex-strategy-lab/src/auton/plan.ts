import { dist, type Vec2 } from '../core/vec';
import type { GoalGeom } from '../field/geometry';
import type { Alliance } from '../rules/ruleset';
import { astar } from '../planner/astar';
import { Grid } from '../planner/grid';
import type { RobotStart } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import { headingToTheta, programTheta, toProgram, type AutonMode, type AutonProgram, type AutonStep, type OdomFrame } from './program';

/**
 * Plan mode's building blocks: a new program, and the step sequences a click on
 * the field adds — drive to a point, pick up a Pin / Cup, place on a Goal. They
 * are written in the program's frame at the point they are added (field
 * coordinates for programs that start with setPose at their tile, as Plan mode's do).
 */

export const DEFAULT_SPEED = 127;

export function newProgram(name: string, slot: string, mode: AutonMode, start: RobotStart | undefined): AutonProgram {
  const steps: AutonStep[] = start ? [{ kind: 'setPose', x: round(start.pos.x), y: round(start.pos.y), theta: round(headingToTheta(start.heading)) }] : [];
  return { name, slot, mode, steps };
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function moveStep(frame: OdomFrame, to: Vec2, forwards = true, maxSpeed = DEFAULT_SPEED): AutonStep {
  const p = toProgram(frame, to);
  return { kind: 'moveToPoint', x: round(p.x), y: round(p.y), forwards, maxSpeed, timeout: 3000, queue: true, async: true };
}

function turnToPointStep(frame: OdomFrame, to: Vec2): AutonStep {
  const p = toProgram(frame, to);
  return { kind: 'turnToPoint', x: round(p.x), y: round(p.y), forwards: true, maxSpeed: DEFAULT_SPEED, timeout: 1500, queue: true, async: true };
}

/** What a route has to keep clear of. */
export interface RouteOptions {
  alliance: Alliance;
  /** Match autonomous: stay on this alliance's side of the Autonomous Line (SG7). */
  ownSideOnly: boolean;
}

const grids = new Map<string, Grid>();
function gridFor(robot: RobotConfig, o: RouteOptions): Grid {
  const c = Math.max(robot.chassis.lengthIn, robot.chassis.widthIn) / 2 + 1;
  const cc = Math.hypot(robot.chassis.lengthIn / 2, robot.chassis.widthIn / 2) + 0.5;
  const key = `${c}|${cc}|${o.alliance}|${o.ownSideOnly}`;
  let g = grids.get(key);
  if (!g) {
    g = new Grid({ clearance: c, cornerClearance: cc, alliance: o.alliance, forbidOpposingSide: o.ownSideOnly });
    grids.set(key, g);
  }
  return g;
}

/** Waypoints between `from` and `to` around Goal posts and Loaders (empty when the straight line is clear). */
export function routeVia(from: Vec2, to: Vec2, robot: RobotConfig, o: RouteOptions): Vec2[] {
  const grid = gridFor(robot, o);
  if (grid.segmentClear(from, to)) return [];
  const res = astar(grid, from, to);
  if (!res) return [];
  return res.points.slice(1, -1).filter((p) => dist(p, from) > 2 && dist(p, to) > 2);
}

/** Where the robot center goes so its claw is over `target`, coming from `from`. */
function clawOver(from: Vec2, target: Vec2, robot: RobotConfig): Vec2 {
  const d = Math.max(1e-6, dist(from, target));
  const k = robot.intake.holderOffsetIn / d;
  return { x: target.x - (target.x - from.x) * k, y: target.y - (target.y - from.y) * k };
}

/** A point `back` inches short of `target` on the line from `from`. */
function shortOf(from: Vec2, target: Vec2, back: number): Vec2 {
  const d = Math.max(1e-6, dist(from, target));
  return { x: target.x - ((target.x - from.x) / d) * back, y: target.y - ((target.y - from.y) / d) * back };
}

/**
 * Get to a spot `standoff` inches from `target` with a clear straight line in: the
 * spot on the line from `from` if it is free and reachable directly, otherwise the
 * free spot around the target with the shortest route (around Goal posts and
 * Loaders, on this side of the Autonomous Line in a match). Returns the moves and
 * where the robot ends up.
 */
function approach(frame: OdomFrame, from: Vec2, target: Vec2, standoff: number, robot: RobotConfig, o?: RouteOptions): { steps: AutonStep[]; at: Vec2 } {
  if (!o) return { steps: [], at: from };
  const grid = gridFor(robot, o);
  const straight = shortOf(from, target, standoff);
  if (dist(from, target) <= standoff || (!grid.isBlockedAt(straight) && grid.segmentClear(from, straight))) return { steps: [], at: from };
  const base = Math.atan2(from.y - target.y, from.x - target.x);
  let best: { pre: Vec2; path: Vec2[]; len: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
    const pre = { x: target.x + Math.cos(a) * standoff, y: target.y + Math.sin(a) * standoff };
    if (grid.isBlockedAt(pre)) continue;
    const path = grid.segmentClear(from, pre) ? [from, pre] : (astar(grid, from, pre)?.points ?? null);
    if (!path || dist(path[path.length - 1], pre) > 1) continue;
    let len = 0;
    for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
    if (!best || len < best.len) best = { pre, path, len };
  }
  if (!best) return { steps: [], at: from };
  const way = best.path.slice(1).filter((p, i, all) => i === all.length - 1 || dist(p, from) > 2);
  return { steps: way.map((p) => moveStep(frame, p, true, DEFAULT_SPEED)), at: best.pre };
}

/** Pick up a piece standing at `at`: arm down, route there, claw open, face it, drive the claw onto it, close. */
export function pickSteps(frame: OdomFrame, from: Vec2, at: Vec2, robot: RobotConfig, o?: RouteOptions): AutonStep[] {
  const r = approach(frame, from, at, robot.intake.holderOffsetIn + 10, robot, o);
  return [
    { kind: 'lift', height: robot.lift.holderMinHeightIn },
    ...r.steps,
    turnToPointStep(frame, at),
    { kind: 'claw', closed: false },
    { ...(moveStep(frame, clawOver(r.at, at, robot), true, 70) as Extract<AutonStep, { kind: 'moveToPoint' }>) },
    { kind: 'waitUntilDone' },
    { kind: 'claw', closed: true },
    { kind: 'wait', ms: 250 },
  ];
}

/** Place the held piece on a Goal: raise the arm above it, route there, drive the claw over it, open, back away. */
export function placeSteps(frame: OdomFrame, from0: Vec2, goal: GoalGeom, robot: RobotConfig, o?: RouteOptions): AutonStep[] {
  const r = approach(frame, from0, goal.pos, robot.intake.holderOffsetIn + 12, robot, o);
  const from = r.at;
  const over = clawOver(from, goal.pos, robot);
  const d = Math.max(1e-6, dist(from, goal.pos));
  const back = { x: over.x - ((goal.pos.x - from.x) / d) * 8, y: over.y - ((goal.pos.y - from.y) / d) * 8 };
  return [
    { kind: 'lift', height: round(goal.height + 1.5, 2) },
    ...r.steps,
    turnToPointStep(frame, goal.pos),
    moveStep(frame, over, true, 60),
    { kind: 'waitUntilDone' },
    { kind: 'wait', ms: 250 },
    { kind: 'claw', closed: false },
    { kind: 'wait', ms: 400 },
    moveStep(frame, back, false, 80),
    { kind: 'lift', height: robot.lift.holderMinHeightIn },
  ];
}

/** Heading step for a field heading, in the program's frame. */
export function turnStep(frame: OdomFrame, fieldHeading: number): AutonStep {
  return { kind: 'turnToHeading', theta: round(programTheta(frame, fieldHeading)), maxSpeed: DEFAULT_SPEED, timeout: 1500, queue: true, async: true };
}
