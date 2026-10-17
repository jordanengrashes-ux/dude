import { G, IN, LB, wrapAngle } from '../core/units';
import type { Vec2 } from '../core/vec';
import { dist } from '../core/vec';
import type { RobotConfig } from './config';
import { groupFreeSpeed, groupTorque } from './motor';
import { liftMovingMassLb, liftRadius, liftTravel } from './lift';

/**
 * Analytical performance model used by the planner to estimate action times.
 * It uses the same motor/traction equations as the physics engine's drive model,
 * so estimates and simulated execution agree closely (see tests/calibration.test.ts).
 * All outputs are in inches / seconds / radians.
 */

/**
 * Fraction of the traction-limited deceleration the path controller plans with
 * (sim/drive.ts uses the same value), so model and execution brake identically.
 */
export const BRAKE_FRACTION = 0.6;

export interface DrivePerf {
  massKg: number;
  /** Free (no-load) linear speed at full command, in/s. */
  vFree: number;
  /** Cruise speed the controller targets, in/s. */
  vCruise: number;
  /** Zero-speed acceleration limit (min of motor force and traction), in/s². */
  aMax: number;
  /** Motor-only acceleration at zero speed (before traction limit), in/s². */
  aMotor0: number;
  /** Traction-limited acceleration, in/s². */
  aTraction: number;
  /** Rolling-resistance deceleration, in/s². */
  aRoll: number;
  aBrake: number;
  /** Maximum lateral acceleration before lateral slip, in/s². */
  aLat: number;
  yawRateMax: number;
  yawAccel: number;
  canTurnInPlace: boolean;
  /** Typical (harmonic-mean) lift speeds over the travel, in/s. */
  liftUpSpeed: number;
  liftDownSpeed: number;
  liftAccel: number;
  /** Lift speed vs holder height: samples every `step` inches from the lowest holder height. */
  liftTable: { h0: number; step: number; up: number[]; down: number[] };
  /** Fractional performance scale applied (uncertainty sampling). */
  perfScale: number;
}

export interface PerfOptions {
  /** Controller cruise fraction of free speed. */
  cruiseFraction?: number;
  /** Multiplier on motor torque (uncertainty). */
  motorScale?: number;
  /** Multiplier on traction coefficients (uncertainty). */
  tractionScale?: number;
  /** Payload mass on the lift (kg). */
  payloadKg?: number;
}

export function derivePerf(cfg: RobotConfig, opt: PerfOptions = {}): DrivePerf {
  const cruiseFraction = opt.cruiseFraction ?? 0.85;
  const motorScale = opt.motorScale ?? 1;
  const tractionScale = opt.tractionScale ?? 1;
  const m = cfg.mass.totalLb * LB;
  const dt = cfg.drivetrain;
  const rw = (dt.wheelDiameterIn / 2) * IN;
  const vb = cfg.battery.voltage;
  const vFreeM = Math.min(groupFreeSpeed(dt.left, vb), groupFreeSpeed(dt.right, vb)) * rw;
  const f0 = (groupTorque(dt.left, 1, 0, vb, motorScale) + groupTorque(dt.right, 1, 0, vb, motorScale)) / rw;
  const muX = dt.muLongitudinal * tractionScale;
  const muY = dt.muLateral * tractionScale;
  const traction = muX * m * G;
  const aMax = (Math.min(f0, traction) / m - dt.rollingResistance * G) / IN;
  const aBrake = (Math.min(f0 * 1.5, traction) / m + dt.rollingResistance * G) / IN;
  const aLat = (muY * G) / IN;

  // Yaw dynamics (skid steer). Drive moment vs lateral-scrub resisting moment.
  const tw = dt.trackWidthIn * IN;
  const wb = dt.wheelBaseIn * IN;
  const L = cfg.chassis.lengthIn * IN;
  const W = cfg.chassis.widthIn * IN;
  const Izz = (m * (L * L + W * W)) / 12;
  const scrub = muY * m * G * (wb / 2);
  const driveMoment0 = Math.min(f0, traction) * (tw / 2);
  const canTurnInPlace = driveMoment0 > scrub * 1.05;
  // ω at which motor back-EMF reduces drive moment to the scrub moment.
  const fracAtEq = canTurnInPlace ? 1 - scrub / (f0 * (tw / 2)) : 0;
  const yawRateMax = Math.max(0, (fracAtEq * vFreeM) / (tw / 2)) * cruiseFraction;
  const yawAccel = canTurnInPlace ? (driveMoment0 - scrub) / Izz : 0;

  // Lift: steady-state speed at each height from the motor line and gravity, through
  // the (possibly height-dependent) transmission radius — see robot/lift.ts.
  const liftMass = liftMovingMassLb(cfg) * LB + (opt.payloadKg ?? 0.14);
  const gravity = liftMass * G;
  const step = 0.5;
  const travel = liftTravel(cfg);
  const up: number[] = [];
  const down: number[] = [];
  let accSum = 0;
  for (let d = 0; d <= travel + 1e-9; d += step) {
    const r = liftRadius(cfg, d) * IN;
    const free = groupFreeSpeed(cfg.lift.motor, vb) * r;
    const F0 = groupTorque(cfg.lift.motor, 1, 0, vb, motorScale) / r;
    up.push(((F0 > gravity ? free * (1 - gravity / F0) : 0) / IN) * 0.9);
    down.push((Math.min(free, free * (1 + gravity / F0)) / IN) * 0.9);
    accSum += Math.max(0.1, (F0 - gravity) / liftMass);
  }
  const harmonic = (v: number[]) => (v.some((x) => x <= 0) ? 0 : v.length / v.reduce((a, x) => a + 1 / x, 0));
  const liftAccel = accSum / up.length;

  return {
    massKg: m,
    vFree: vFreeM / IN,
    vCruise: (vFreeM / IN) * cruiseFraction,
    aMax: Math.max(1, aMax),
    aMotor0: f0 / m / IN,
    aTraction: traction / m / IN,
    aRoll: (dt.rollingResistance * G) / IN,
    aBrake: Math.max(1, aBrake),
    aLat,
    yawRateMax,
    yawAccel,
    canTurnInPlace,
    liftUpSpeed: harmonic(up),
    liftDownSpeed: harmonic(down),
    liftAccel: liftAccel / IN,
    liftTable: { h0: cfg.lift.holderMinHeightIn, step, up, down },
    perfScale: motorScale,
  };
}

/** Acceleration available at speed v (in/s) under the linear motor curve. */
function accelAt(p: DrivePerf, v: number): number {
  const frac = Math.max(0, 1 - v / p.vFree);
  return Math.max(0.5, Math.min(p.aTraction, p.aMotor0 * frac) - p.aRoll);
}

/**
 * Time to traverse a polyline from rest to rest, using a forward/backward pass
 * velocity profile with curvature caps at vertices.
 */
export function polylineTime(p: DrivePerf, pts: Vec2[], lookahead = 12): number {
  if (pts.length < 2) return 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) segs.push(dist(pts[i - 1], pts[i]));
  const total = segs.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return 0;
  // vertex caps
  const caps: number[] = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    const phi = Math.abs(wrapAngle(a2 - a1));
    if (phi < 1e-3) {
      caps.push(p.vCruise);
      continue;
    }
    const R = lookahead / (2 * Math.sin(Math.min(phi, Math.PI - 1e-3) / 2));
    const vLat = Math.sqrt(p.aLat * R);
    const vYaw = p.yawRateMax * R;
    caps.push(Math.min(p.vCruise, vLat, Math.max(vYaw, 2)));
  }
  caps.push(0);
  // discretize
  const ds = 0.5;
  const n = Math.max(2, Math.ceil(total / ds));
  const step = total / n;
  const vmax = new Array(n + 1).fill(p.vCruise);
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const idx = Math.round(acc / step);
    vmax[Math.min(n, idx)] = Math.min(vmax[Math.min(n, idx)], caps[i]);
    acc += segs[i];
  }
  vmax[n] = 0;
  vmax[0] = 0;
  const v = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const a = accelAt(p, v[i - 1]);
    v[i] = Math.min(vmax[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * a * step));
  }
  for (let i = n - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * p.aBrake * BRAKE_FRACTION * step));
  let t = 0;
  for (let i = 1; i <= n; i++) {
    const vm = (v[i] + v[i - 1]) / 2;
    t += step / Math.max(vm, 0.5);
  }
  return t;
}

export function straightTime(p: DrivePerf, d: number): number {
  return polylineTime(p, [{ x: 0, y: 0 }, { x: d, y: 0 }]);
}

/** Turn-in-place time for |angle| radians (rest to rest). */
export function turnTime(p: DrivePerf, angle: number): number {
  const a = Math.abs(angle);
  if (a < 1e-3) return 0;
  if (!p.canTurnInPlace || p.yawRateMax <= 0) return Infinity;
  const alpha = Math.max(0.5, p.yawAccel);
  const w = p.yawRateMax;
  const tAcc = w / alpha;
  const dAcc = 0.5 * alpha * tAcc * tAcc;
  if (2 * dAcc >= a) return 2 * Math.sqrt(a / alpha) + 0.08;
  return 2 * tAcc + (a - 2 * dAcc) / w + 0.08;
}

/**
 * Lift move time between holder heights: the travel time through the height-
 * dependent speed table, plus acceleration and settling.
 */
export function liftTime(p: DrivePerf, fromH: number, toH: number): number {
  const dh = toH - fromH;
  if (Math.abs(dh) < 0.05) return 0;
  const tab = p.liftTable;
  const speeds = dh > 0 ? tab.up : tab.down;
  const lo = Math.min(fromH, toH);
  const hi = Math.max(fromH, toH);
  let t = 0;
  let vMean = 0;
  for (let h = lo; h < hi - 1e-9; ) {
    const k = Math.max(0, Math.min(speeds.length - 1, Math.floor((h - tab.h0) / tab.step)));
    const next = Math.min(hi, tab.h0 + (k + 1) * tab.step);
    const seg = Math.max(next - h, 1e-6);
    const v = speeds[k];
    if (v <= 0) return Infinity;
    t += seg / v;
    vMean += seg * v;
    h = next > h ? next : h + seg;
  }
  vMean /= hi - lo;
  const a = Math.max(5, p.liftAccel);
  const d = hi - lo;
  // trapezoidal profile at the mean speed: the accel + decel phases cost v/a extra
  if (vMean * vMean / a >= d) return 2 * Math.sqrt(d / a) + 0.05;
  return t + vMean / a + 0.05;
}

/** Maximum holder-bottom height the lift can reach. */
export function maxHolderHeight(cfg: RobotConfig): number {
  return cfg.lift.holderMinHeightIn + liftTravel(cfg);
}

/** Highest point of the robot (excluding held Scoring Objects) for a holder height. */
export function robotTopHeight(cfg: RobotConfig, holderHeight: number): number {
  return Math.max(cfg.chassis.towerHeightIn, holderHeight + cfg.lift.carriageHeightIn, cfg.toggleArm.heightIn + 0.25);
}
