import { clamp, wrapAngle } from '../core/units';
import type { Vec2 } from '../core/vec';
import { dist } from '../core/vec';
import { BRAKE_FRACTION, type DrivePerf } from '../robot/kinematics';
import type { Sensing } from './match';

/**
 * Low-level drive controllers for a tank drivetrain. They output motor commands
 * in [-1, 1] from the (possibly noisy) sensed pose — the same commands a V5 program
 * would send.
 */

export interface DriveOut {
  left: number;
  right: number;
  done: boolean;
}

export interface DriveTuning {
  /** Breakaway turn command needed to overcome scrub. */
  minTurn: number;
  /** Planned yaw deceleration for the turn profile (rad/s²). */
  turnDecel: number;
  trackWidth: number;
  lookahead: number;
  cruiseFraction: number;
  decel: number;
  turnKp: number;
  turnKd: number;
  speedKp: number;
}

export const DEFAULT_TUNING: DriveTuning = { minTurn: 0.36, turnDecel: 14, trackWidth: 13.5, lookahead: 11, cruiseFraction: 0.85, decel: BRAKE_FRACTION, turnKp: 1.6, turnKd: 1.2, speedKp: 2.5 };

export function wheelCommand(perf: DrivePerf, vTarget: number, wTarget: number, trackWidth: number, sense: Sensing, tune: DriveTuning) {
  // feedforward (no-load speed ∝ command) + proportional speed correction per side
  const vl = vTarget - (wTarget * trackWidth) / 2;
  const vr = vTarget + (wTarget * trackWidth) / 2;
  const vMeasL = sense.speed - (sense.yawRate * trackWidth) / 2;
  const vMeasR = sense.speed + (sense.yawRate * trackWidth) / 2;
  const ff = (v: number) => v / perf.vFree;
  let left = ff(vl) + (tune.speedKp * (vl - vMeasL)) / perf.vFree;
  let right = ff(vr) + (tune.speedKp * (vr - vMeasR)) / perf.vFree;
  // desaturate together so the turning ratio (curvature) is preserved
  const m = Math.max(1, Math.abs(left), Math.abs(right));
  left /= m;
  right /= m;
  return { left, right };
}

/**
 * Turn in place toward a heading with a velocity profile: the demanded yaw rate is
 * min(ω_max, √(2·α·|error|)), converted to a wheel command by feedforward plus a
 * scrub-breakaway term (a skid-steer 4WD must overcome lateral wheel scrub before
 * it rotates at all) and yaw-rate feedback.
 */
export function turnTo(perf: DrivePerf, sense: Sensing, heading: number, tune = DEFAULT_TUNING, tol = 0.05): DriveOut {
  const err = wrapAngle(heading - sense.heading);
  const done = Math.abs(err) < tol && Math.abs(sense.yawRate) < 0.6;
  if (Math.abs(err) < tol * 0.6) return { left: 0, right: 0, done };
  const halfTrack = tune.trackWidth / 2;
  const wMax = Math.max(1, perf.yawRateMax);
  const wDemand = Math.sign(err) * Math.min(wMax, Math.sqrt(2 * tune.turnDecel * Math.abs(err)));
  const wFF = perf.vFree / halfTrack; // yaw rate per unit command without scrub
  const u = wDemand / wFF + Math.sign(wDemand) * tune.minTurn + tune.turnKd * (wDemand - sense.yawRate) / wFF;
  const c = clamp(u, -1, 1);
  return { left: -c, right: c, done };
}

export interface PursuitState {
  path: Vec2[];
  seg: number;
}

/**
 * Pure pursuit along a polyline with a trapezoidal speed profile that brings the
 * robot to rest at the final point. Turns in place first if the path starts behind.
 */
export function pursue(perf: DrivePerf, sense: Sensing, ps: PursuitState, trackWidth: number, tune = DEFAULT_TUNING, endTol = 1.0): DriveOut {
  const path = ps.path;
  const pos = sense.pos;
  const end = path[path.length - 1];
  // advance segment index while the robot has passed the segment end
  while (ps.seg < path.length - 2) {
    const a = path[ps.seg];
    const b = path[ps.seg + 1];
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const l2 = ab.x * ab.x + ab.y * ab.y;
    const tproj = l2 > 1e-9 ? ((pos.x - a.x) * ab.x + (pos.y - a.y) * ab.y) / l2 : 1;
    if (tproj >= 1 || dist(pos, b) < tune.lookahead * 0.5) ps.seg++;
    else break;
  }
  // remaining distance along the path
  let remaining = dist(pos, path[Math.min(ps.seg + 1, path.length - 1)]);
  for (let i = ps.seg + 1; i < path.length - 1; i++) remaining += dist(path[i], path[i + 1]);
  // Arrived (or slightly past the end along the final segment): brake, never turn back.
  const last = path[Math.max(0, path.length - 2)];
  const segDir = { x: end.x - last.x, y: end.y - last.y };
  const passed = (pos.x - end.x) * segDir.x + (pos.y - end.y) * segDir.y > 0;
  if (dist(pos, end) < endTol || (passed && dist(pos, end) < endTol * 2.5 && ps.seg >= path.length - 2)) {
    const brake = wheelCommand(perf, 0, 0, trackWidth, sense, tune);
    return { ...brake, done: Math.abs(sense.speed) < 6 };
  }
  // Short hop (inside the lookahead): turn to face the end point, then drive straight.
  if (remaining < tune.lookahead) {
    const ang = Math.atan2(end.y - pos.y, end.x - pos.x);
    const err = wrapAngle(ang - sense.heading);
    if (Math.abs(err) > 0.35) return { ...turnTo(perf, sense, ang, tune), done: false };
    const v = Math.max(5, Math.min(perf.vFree * tune.cruiseFraction, Math.sqrt(2 * perf.aBrake * tune.decel * Math.max(0, remaining - endTol * 0.5))));
    return { ...wheelCommand(perf, v, clamp(err * 4, -2, 2), trackWidth, sense, tune), done: false };
  }
  // lookahead point
  let look = end;
  let acc = 0;
  let prev = pos;
  for (let i = ps.seg + 1; i < path.length; i++) {
    const d = dist(prev, path[i]);
    if (acc + d >= tune.lookahead) {
      const t = (tune.lookahead - acc) / d;
      look = { x: prev.x + (path[i].x - prev.x) * t, y: prev.y + (path[i].y - prev.y) * t };
      break;
    }
    acc += d;
    prev = path[i];
  }
  const angTo = Math.atan2(look.y - pos.y, look.x - pos.x);
  const alpha = wrapAngle(angTo - sense.heading);
  if (Math.abs(alpha) > 0.6) {
    const t = turnTo(perf, sense, angTo, tune);
    return { ...t, done: false };
  }
  const L = Math.max(4, dist(pos, look));
  const kappa = (2 * Math.sin(alpha)) / L;
  const vCruise = perf.vFree * tune.cruiseFraction;
  const vStop = Math.sqrt(2 * perf.aBrake * tune.decel * Math.max(0, remaining - endTol * 0.5));
  const vCurve = Math.abs(kappa) > 1e-4 ? Math.sqrt(perf.aLat / Math.abs(kappa)) : vCruise;
  const v = Math.max(6, Math.min(vCruise, vStop, vCurve));
  return { ...wheelCommand(perf, v, v * kappa, trackWidth, sense, tune), done: false };
}

/**
 * Final approach: put the holder axis (offset ahead of the robot center) onto a
 * target point. The robot continuously aims at the target, so the holder — which
 * lies on the robot's centerline — converges onto it with zero lateral error.
 * `along` is the remaining forward distance for the holder.
 */
export function approach(perf: DrivePerf, sense: Sensing, target: Vec2, holderOffset: number, speed: number, trackWidth: number, tune = DEFAULT_TUNING): DriveOut & { along: number; lateral: number } {
  const dx = target.x - sense.pos.x;
  const dy = target.y - sense.pos.y;
  const d = Math.hypot(dx, dy);
  const aim = Math.atan2(dy, dx);
  const err = wrapAngle(aim - sense.heading);
  const along = d * Math.cos(err) - holderOffset;
  const lateral = d * Math.sin(err);
  // Small steering corrections cannot break 4WD scrub while creeping: re-aim in place.
  const reaimTol = Math.abs(sense.speed) > 6 ? 0.25 : 0.08;
  if (d > holderOffset * 0.6 && Math.abs(err) > reaimTol) return { ...turnTo(perf, sense, aim, tune, 0.03), done: false, along, lateral };
  const v = clamp(along * 5, -speed, speed);
  const w = d > holderOffset * 0.6 ? clamp(err * 5, -1.5, 1.5) : 0;
  return { ...wheelCommand(perf, v, w, trackWidth, sense, tune), done: Math.abs(along) < 0.3, along, lateral };
}

/** Drive straight backward by a distance (back off after scoring / toggling). */
export function backOff(perf: DrivePerf, sense: Sensing, from: Vec2, distance: number, heading: number, trackWidth: number, tune = DEFAULT_TUNING): DriveOut {
  return driveStraight(perf, sense, from, distance, heading, -1, trackWidth, tune);
}

/** Drive `distance` inches from `from` holding `heading`, forward (+1) or in reverse (−1). */
export function driveStraight(perf: DrivePerf, sense: Sensing, from: Vec2, distance: number, heading: number, direction: 1 | -1, trackWidth: number, tune = DEFAULT_TUNING): DriveOut {
  const d = dist(sense.pos, from);
  if (d >= distance) return { left: 0, right: 0, done: true };
  const hErr = wrapAngle(heading - sense.heading);
  return { ...wheelCommand(perf, direction * Math.min(30, 8 + (distance - d) * 4), hErr * 3, trackWidth, sense, tune), done: false };
}
