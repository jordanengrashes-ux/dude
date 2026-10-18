import type { Vec2 } from '../core/vec';
import type { RobotConfig } from '../robot/config';
import { dr4bAngle } from '../robot/lift';

/**
 * Autonomous programs: what Plan mode draws, what PROS code (LemLib / EZ-Template)
 * imports into, and what the simulator runs.
 *
 * Coordinates are the program's own (odometry) frame, in inches, with LemLib's
 * heading convention: θ in degrees, 0 = +y, clockwise positive. Plan mode writes
 * field-centric programs (they start with setPose at the robot's starting tile:
 * origin at the field center, +x toward the blue Alliance Station, +y toward the
 * top of the overhead view). An imported program that never calls setPose runs
 * relative to where the robot starts (LemLib's default pose 0, 0, 0).
 */

export type AutonStep =
  | { kind: 'setPose'; x: number; y: number; theta: number }
  | { kind: 'moveToPoint'; x: number; y: number; forwards: boolean; maxSpeed: number; timeout: number; queue: boolean; async: boolean }
  | { kind: 'moveToPose'; x: number; y: number; theta: number; forwards: boolean; maxSpeed: number; timeout: number; lead: number; queue: boolean; async: boolean }
  | { kind: 'turnToHeading'; theta: number; maxSpeed: number; timeout: number; queue: boolean; async: boolean }
  | { kind: 'turnToPoint'; x: number; y: number; forwards: boolean; maxSpeed: number; timeout: number; queue: boolean; async: boolean }
  /** Drive straight by a distance along the heading (EZ-Template pid_drive_set; negative = reverse). */
  | { kind: 'drive'; inches: number; maxSpeed: number; timeout: number; queue: boolean; async: boolean }
  /** Swing turn on one side (EZ-Template pid_swing_set): 'left' moves the left side. */
  | { kind: 'swing'; side: 'left' | 'right'; theta: number; maxSpeed: number; timeout: number; queue: boolean; async: boolean }
  /** Block until the current motion ends (LemLib waitUntilDone / EZ pid_wait). */
  | { kind: 'waitUntilDone' }
  /** Block until the current motion has gone this far (LemLib waitUntil / EZ pid_wait_until). */
  | { kind: 'waitUntil'; inches: number }
  | { kind: 'wait'; ms: number }
  /** Lift to a holder height (in above the tiles). */
  | { kind: 'lift'; height: number }
  /** Lift motor power −127…127 (0 holds). */
  | { kind: 'liftPower'; power: number }
  | { kind: 'claw'; closed: boolean }
  | { kind: 'toggleArm'; on: boolean }
  /** Raw drive motor power, −127…127 per side (plain PROS move()). */
  | { kind: 'drivePower'; left: number | null; right: number | null };

export type AutonMode = 'match' | 'skills';

export interface AutonProgram {
  name: string;
  /** Robot slot it runs on (its starting tile). */
  slot: string;
  /** Match autonomous (15 s, Head-to-Head field) or Skills autonomous (60 s). */
  mode: AutonMode;
  steps: AutonStep[];
}

/** Motion steps (they drive the chassis). */
export const isMotion = (s: AutonStep) => s.kind === 'moveToPoint' || s.kind === 'moveToPose' || s.kind === 'turnToHeading' || s.kind === 'turnToPoint' || s.kind === 'drive' || s.kind === 'swing';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** LemLib heading (deg, 0 = +y, clockwise) → field heading (rad, 0 = +x, counter-clockwise). */
export const thetaToHeading = (theta: number) => (90 - theta) * D2R;
/** Field heading (rad) → LemLib heading (deg, in −180…180]. */
export const headingToTheta = (h: number) => {
  const t = wrap180(90 - h * R2D);
  return t === -180 ? 180 : t;
};

/** Rigid map from a program's odometry frame to the field. */
export interface OdomFrame {
  /** Field heading minus program heading (rad). */
  rot: number;
  /** Field position of the program origin. */
  t: Vec2;
}

/** The frame in which the robot, standing at `pos`/`heading` on the field, reads program pose (x, y, θ). */
export function frameFor(pos: Vec2, heading: number, x = 0, y = 0, theta = 0): OdomFrame {
  const rot = heading - thetaToHeading(theta);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { rot, t: { x: pos.x - (c * x - s * y), y: pos.y - (s * x + c * y) } };
}

export function toField(f: OdomFrame, p: Vec2): Vec2 {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: f.t.x + c * p.x - s * p.y, y: f.t.y + s * p.x + c * p.y };
}

export function toProgram(f: OdomFrame, p: Vec2): Vec2 {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const dx = p.x - f.t.x;
  const dy = p.y - f.t.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/** Program heading θ (deg) → field heading (rad). */
export const fieldHeading = (f: OdomFrame, theta: number) => thetaToHeading(theta) + f.rot;
/** Field heading (rad) → program heading θ (deg). */
export const programTheta = (f: OdomFrame, h: number) => headingToTheta(h - f.rot);

// ------------------------------------------------------------------ lift motor

/**
 * Lift motor position (degrees, 0 at the bottom) for a holder height, through the
 * robot's lift transmission (DR4B bar angle or rack pinion) and gearing. PROS
 * move_absolute() takes these degrees with the motors tared at the bottom.
 */
export function liftMotorDegrees(cfg: RobotConfig, height: number): number {
  const l = cfg.lift;
  const d = Math.max(0, height - l.holderMinHeightIn);
  const ratio = l.motor.gearRatio || 1;
  if (l.type === 'dr4b') return ((dr4bAngle(cfg, d) - l.minAngleDeg * D2R) * R2D) / ratio;
  return ((d / (l.pinionPitchDiameterIn / 2)) * R2D) / ratio;
}

/** Holder height (in) for a lift motor position (degrees from the bottom). */
export function liftHeightFromDegrees(cfg: RobotConfig, deg: number): number {
  const l = cfg.lift;
  const ratio = l.motor.gearRatio || 1;
  const out = deg * ratio * D2R; // output (bar / pinion) rotation, rad
  if (l.type === 'dr4b') {
    const th = Math.min(l.maxAngleDeg * D2R, l.minAngleDeg * D2R + Math.max(0, out));
    return l.holderMinHeightIn + 2 * l.barLengthIn * (Math.sin(th) - Math.sin(l.minAngleDeg * D2R));
  }
  return l.holderMinHeightIn + Math.max(0, out) * (l.pinionPitchDiameterIn / 2);
}

// ------------------------------------------------------------------ preview

export interface PreviewPoint {
  pos: Vec2;
  heading: number;
  /** Index of the step that brought the robot here. */
  step: number;
  /** The program's frame at that point (to turn field clicks into program coordinates). */
  frame: OdomFrame;
}

/**
 * Where the program would take the robot if every motion ended exactly on target
 * (no physics): the planned path Plan mode draws, in field coordinates.
 */
export function previewPath(steps: AutonStep[], start: { pos: Vec2; heading: number }): PreviewPoint[] {
  let frame = frameFor(start.pos, start.heading);
  let pos = { ...start.pos };
  let heading = start.heading;
  const out: PreviewPoint[] = [{ pos, heading, step: -1, frame }];
  steps.forEach((s, i) => {
    switch (s.kind) {
      case 'setPose':
        frame = frameFor(pos, heading, s.x, s.y, s.theta);
        out.push({ pos, heading, step: i, frame });
        break;
      case 'moveToPoint': {
        const p = toField(frame, s);
        const a = Math.atan2(p.y - pos.y, p.x - pos.x);
        heading = s.forwards ? a : a + Math.PI;
        pos = p;
        out.push({ pos, heading, step: i, frame });
        break;
      }
      case 'moveToPose':
        pos = toField(frame, s);
        heading = fieldHeading(frame, s.theta);
        out.push({ pos, heading, step: i, frame });
        break;
      case 'turnToHeading':
        heading = fieldHeading(frame, s.theta);
        out.push({ pos, heading, step: i, frame });
        break;
      case 'turnToPoint': {
        const p = toField(frame, s);
        heading = Math.atan2(p.y - pos.y, p.x - pos.x) + (s.forwards ? 0 : Math.PI);
        out.push({ pos, heading, step: i, frame });
        break;
      }
      case 'drive':
        pos = { x: pos.x + Math.cos(heading) * s.inches, y: pos.y + Math.sin(heading) * s.inches };
        out.push({ pos, heading, step: i, frame });
        break;
      case 'swing':
        heading = fieldHeading(frame, s.theta);
        out.push({ pos, heading, step: i, frame });
        break;
      default:
        break;
    }
  });
  return out;
}

/** A short human-readable label for a step (the step list, the run log). */
export function stepLabel(s: AutonStep): string {
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  switch (s.kind) {
    case 'setPose':
      return `Set pose (${f(s.x)}, ${f(s.y)}) ${f(s.theta)}°`;
    case 'moveToPoint':
      return `${s.forwards ? 'Drive' : 'Back up'} to (${f(s.x)}, ${f(s.y)})`;
    case 'moveToPose':
      return `${s.forwards ? 'Drive' : 'Back up'} to (${f(s.x)}, ${f(s.y)}) facing ${f(s.theta)}°`;
    case 'turnToHeading':
      return `Turn to ${f(s.theta)}°`;
    case 'turnToPoint':
      return `Turn to face (${f(s.x)}, ${f(s.y)})`;
    case 'drive':
      return `Drive ${f(s.inches)}"`;
    case 'swing':
      return `Swing (${s.side} side) to ${f(s.theta)}°`;
    case 'waitUntilDone':
      return 'Wait until the motion ends';
    case 'waitUntil':
      return `Wait until ${f(s.inches)}" into the motion`;
    case 'wait':
      return `Wait ${s.ms} ms`;
    case 'lift':
      return `Lift to ${f(s.height)}"`;
    case 'liftPower':
      return s.power === 0 ? 'Lift: hold' : `Lift power ${s.power}`;
    case 'claw':
      return s.closed ? 'Close the claw' : 'Open the claw';
    case 'toggleArm':
      return s.on ? 'Toggle arm out' : 'Toggle arm in';
    case 'drivePower':
      return `Drive power L ${s.left ?? '—'} / R ${s.right ?? '—'}`;
  }
}
