import { clamp, wrapAngle } from '../core/units';
import { dist, type Vec2 } from '../core/vec';
import type { RobotConfig } from '../robot/config';
import { derivePerf, type DrivePerf } from '../robot/kinematics';
import { DEFAULT_TUNING, turnTo, wheelCommand, type DriveTuning } from '../sim/drive';
import { DriverController, zeroInput } from '../sim/driver';
import type { Controller, MatchSim, Sensing, SimRobot } from '../sim/match';
import { fieldHeading, frameFor, isMotion, stepLabel, toField, type AutonProgram, type AutonStep, type OdomFrame } from './program';

/**
 * Runs an autonomous program on a simulated robot, the way PROS runs it:
 *
 * - LemLib motions are asynchronous and queue: a motion call starts once the one
 *   before it has finished, and the program carries on at once (async = true) or
 *   waits for it (async = false / waitUntilDone).
 * - EZ-Template motions replace the running one; pid_wait blocks.
 * - Mechanism commands (lift, claw, toggle arm, raw drive power) take effect at once;
 *   delay() blocks the program.
 *
 * Odometry is the simulator's sensed pose, mapped into the program's frame: the
 * robot's starting pose is (0, 0, 0) until setPose says otherwise. The program
 * runs during Autonomous (or the whole Skills run) and stops when that ends.
 *
 * The motions are this simulator's own controllers with LemLib-like behavior
 * (turn toward the target while driving, slow down into it, exit when there or
 * past it, give up at the timeout), not LemLib's PID gains.
 */

export interface StepRecord {
  index: number;
  label: string;
  tStart: number;
  tEnd: number | null;
  timedOut?: boolean;
}

interface Motion {
  step: AutonStep;
  index: number;
  t0: number;
  timeoutAt: number;
  from: Vec2;
  last: Vec2;
  travelled: number;
  target?: Vec2;
  heading?: number;
  /** Unit vector from the start toward the target (to tell when the robot has passed it). */
  dir?: Vec2;
  maxFrac: number;
}

export class AutonController implements Controller {
  readonly kind = 'auton';
  private pc = 0;
  private frame: OdomFrame | null = null;
  private motion: Motion | null = null;
  private blockedUntil = -1;
  private waitMotion = false;
  private waitDist: number | null = null;
  private readonly inp = zeroInput();
  private readonly mech = new DriverController(() => this.inp);
  private clawWant: boolean | null = null;
  private presetFlip = false;
  private raw: { left: number; right: number } | null = null;
  private readonly perf: DrivePerf;
  private readonly tune: DriveTuning;
  private started = false;
  private stopped = false;
  /** What ran when (the run log). */
  readonly records: StepRecord[] = [];
  /** Robot path, sampled every 50 ms. */
  readonly trace: { t: number; pos: Vec2; heading: number }[] = [];
  /** When the last step finished (s), or null if it did not. */
  finishedAt: number | null = null;

  constructor(
    readonly program: AutonProgram,
    robot: RobotConfig,
  ) {
    this.perf = derivePerf(robot);
    this.tune = { ...DEFAULT_TUNING, trackWidth: robot.drivetrain.trackWidthIn };
  }

  update(sim: MatchSim, r: SimRobot, sense: Sensing) {
    // the program runs in Autonomous (all of a Skills run) and is stopped after
    const running = sense.period === 'autonomous' || sense.period === 'skills';
    if (!running) {
      if (this.started && !this.stopped) this.stop(sense.t);
      r.body.cmd = { left: 0, right: 0 };
      return;
    }
    if (!this.started) {
      this.started = true;
      this.frame = frameFor(sense.pos, sense.heading);
      this.mech.update(sim, r, sense); // take the claw state from the preload
    }
    const last = this.trace[this.trace.length - 1];
    if (!last || sense.t - last.t >= 0.05) this.trace.push({ t: sense.t, pos: { ...sense.pos }, heading: sense.heading });
    this.advance(sense);
    // mechanisms, as a driver would work them
    if (this.clawWant !== null && r.clawClosed !== null) {
      if (r.clawClosed !== this.clawWant) this.inp.claw = !this.inp.claw;
      this.clawWant = null;
    }
    this.mech.update(sim, r, sense);
    // chassis
    if (this.motion) {
      const out = this.stepMotion(sense);
      r.body.cmd = { left: out.left, right: out.right };
      if (out.done || sense.t >= this.motion.timeoutAt) this.endMotion(sense.t, !out.done);
    } else if (this.raw) r.body.cmd = { ...this.raw };
    else r.body.cmd = this.brake(sense); // drive motors in brake mode, as teams set them
  }

  /** Hold the chassis still (motor brake mode): oppose the measured motion. */
  private brake(sense: Sensing) {
    const b = wheelCommand(this.perf, 0, 0, this.tune.trackWidth, sense, this.tune);
    return { left: b.left, right: b.right };
  }

  private stop(t: number) {
    this.stopped = true;
    if (this.motion) this.endMotion(t, true);
    for (const rec of this.records) if (rec.tEnd === null) rec.tEnd = t;
  }

  private record(index: number, t: number, end: number | null) {
    this.records.push({ index, label: stepLabel(this.program.steps[index]), tStart: t, tEnd: end });
  }

  /** Run program steps until one blocks. */
  private advance(sense: Sensing) {
    const t = sense.t;
    const steps = this.program.steps;
    for (let guard = 0; guard < 500; guard++) {
      if (t < this.blockedUntil) return;
      if (this.waitMotion) {
        if (this.motion) return;
        this.waitMotion = false;
      }
      if (this.waitDist !== null) {
        if (this.motion && this.motion.travelled < this.waitDist) return;
        this.waitDist = null;
      }
      if (this.pc >= steps.length) {
        if (!this.motion && this.finishedAt === null) this.finishedAt = t;
        return;
      }
      const s = steps[this.pc];
      if (isMotion(s)) {
        const q = s as Extract<AutonStep, { queue: boolean }>;
        if (q.queue && this.motion) return; // LemLib: waits for the motion before it
        if (this.motion) this.endMotion(t, false); // EZ-Template: replaces it
        this.startMotion(s, this.pc, sense);
        this.pc++;
        if (!q.async) this.waitMotion = true;
        continue;
      }
      const i = this.pc++;
      switch (s.kind) {
        case 'setPose':
          this.frame = frameFor(sense.pos, sense.heading, s.x, s.y, s.theta);
          this.record(i, t, t);
          break;
        case 'waitUntilDone':
          this.waitMotion = true;
          this.record(i, t, t);
          break;
        case 'waitUntil':
          this.waitDist = s.inches;
          this.record(i, t, t);
          break;
        case 'wait':
          this.blockedUntil = t + Math.max(0, s.ms) / 1000;
          this.record(i, t, this.blockedUntil);
          break;
        case 'lift':
          this.inp.lift = 0;
          this.presetFlip = !this.presetFlip;
          this.inp.preset = s.height + (this.presetFlip ? 1e-6 : 0); // a new preset, even for the same height
          this.record(i, t, t);
          break;
        case 'liftPower':
          this.inp.lift = clamp(s.power / 127, -1, 1);
          this.record(i, t, t);
          break;
        case 'claw':
          this.clawWant = s.closed;
          this.record(i, t, t);
          break;
        case 'toggleArm':
          this.inp.toggle = s.on;
          this.record(i, t, t);
          break;
        case 'drivePower': {
          const cur = this.raw ?? { left: 0, right: 0 };
          this.raw = { left: s.left === null ? cur.left : clamp(s.left / 127, -1, 1), right: s.right === null ? cur.right : clamp(s.right / 127, -1, 1) };
          this.record(i, t, t);
          break;
        }
        default:
          break;
      }
    }
  }

  private startMotion(s: AutonStep, index: number, sense: Sensing) {
    const f = this.frame!;
    const m: Motion = { step: s, index, t0: sense.t, timeoutAt: Infinity, from: { ...sense.pos }, last: { ...sense.pos }, travelled: 0, maxFrac: 1 };
    this.raw = null;
    switch (s.kind) {
      case 'moveToPoint':
      case 'moveToPose':
      case 'turnToPoint':
        m.target = toField(f, s);
        if (s.kind === 'moveToPose') m.heading = fieldHeading(f, s.theta);
        break;
      case 'turnToHeading':
      case 'swing':
        m.heading = fieldHeading(f, s.theta);
        break;
      case 'drive':
        m.heading = sense.heading;
        m.target = { x: sense.pos.x + Math.cos(sense.heading) * s.inches, y: sense.pos.y + Math.sin(sense.heading) * s.inches };
        break;
      default:
        break;
    }
    if ('timeout' in s) m.timeoutAt = sense.t + Math.max(0.05, s.timeout / 1000);
    if ('maxSpeed' in s) m.maxFrac = clamp(s.maxSpeed / 127, 0.05, 1);
    if (m.target) {
      const d = dist(m.target, sense.pos);
      m.dir = d > 1e-6 ? { x: (m.target.x - sense.pos.x) / d, y: (m.target.y - sense.pos.y) / d } : { x: Math.cos(sense.heading), y: Math.sin(sense.heading) };
    }
    this.motion = m;
    this.records.push({ index, label: stepLabel(s), tStart: sense.t, tEnd: null });
  }

  private endMotion(t: number, timedOut: boolean) {
    const m = this.motion!;
    const rec = [...this.records].reverse().find((x) => x.index === m.index && x.tEnd === null);
    if (rec) {
      rec.tEnd = t;
      if (timedOut) rec.timedOut = true;
    }
    this.motion = null;
  }

  /** Motor command for the running motion; done when it has arrived. */
  private stepMotion(sense: Sensing): { left: number; right: number; done: boolean } {
    const m = this.motion!;
    m.travelled += dist(sense.pos, m.last);
    m.last = { ...sense.pos };
    const s = m.step;
    const P = this.perf;
    const tw = this.tune.trackWidth;
    const vMax = P.vFree * m.maxFrac;
    // slow down early enough to stop on the point (braking well short of the traction limit)
    const vStop = (d: number) => Math.sqrt(2 * P.aBrake * this.tune.decel * 0.25 * Math.max(0, d - 0.5));
    // arrived: brake to a stop, then the motion is done
    const settle = () => ({ ...this.brake(sense), done: Math.abs(sense.speed) < 4 });
    const turnCap = (out: { left: number; right: number; done: boolean }) => {
      const cap = Math.max(0.45, m.maxFrac);
      return { left: clamp(out.left, -cap, cap), right: clamp(out.right, -cap, cap), done: out.done };
    };
    // drive to a point (or a boomerang carrot), forwards or backwards: a skid-steer 4WD
    // barely turns at speed, so it points at the target first (stopping if needed),
    // then drives in with small corrections; close in it stops steering
    const driveTo = (aim: Vec2, end: Vec2, forwards: boolean) => {
      const sign = forwards ? 1 : -1;
      const d = dist(sense.pos, end);
      const ang = Math.atan2(aim.y - sense.pos.y, aim.x - sense.pos.x);
      const err = wrapAngle((forwards ? ang : ang + Math.PI) - sense.heading);
      const far = dist(sense.pos, aim) > 3;
      if (Math.abs(err) > 0.25 && far) {
        if (Math.abs(sense.speed) > 8) return { ...this.brake(sense), done: false };
        return turnCap(turnTo(P, sense, forwards ? ang : ang + Math.PI, this.tune, 0.08));
      }
      const v = sign * Math.max(4, Math.min(vMax, vStop(far ? d : d * Math.max(0, Math.cos(err)))));
      const w = far ? clamp(err * 4, -2, 2) : 0;
      return { ...wheelCommand(P, v, w, tw, sense, this.tune), done: false };
    };
    switch (s.kind) {
      case 'moveToPoint': {
        const to = m.target!;
        const d = dist(sense.pos, to);
        // arrived, or as close as it gets on this line (the rest of the gap is sideways)
        const fwd = s.forwards ? 1 : -1;
        const ahead = ((to.x - sense.pos.x) * Math.cos(sense.heading) + (to.y - sense.pos.y) * Math.sin(sense.heading)) * fwd;
        if (d < 0.75 || (d < 3 && ahead < 0.3)) return settle();
        return driveTo(to, to, s.forwards);
      }
      case 'moveToPose': {
        const to = m.target!;
        const h = m.heading!;
        const d = dist(sense.pos, to);
        if (d < 1.5) {
          const out = turnCap(turnTo(P, sense, h, this.tune, 0.04));
          return out;
        }
        const k = (s.forwards ? 1 : -1) * d * s.lead;
        const carrot = { x: to.x - Math.cos(h) * k, y: to.y - Math.sin(h) * k };
        return driveTo(carrot, to, s.forwards);
      }
      case 'turnToHeading':
      case 'swing': {
        const h = m.heading!;
        if (s.kind === 'swing') {
          const err = wrapAngle(h - sense.heading);
          if (Math.abs(err) < 0.03 && Math.abs(sense.yawRate) < 0.6) return { left: 0, right: 0, done: true };
          const c = clamp(err * 1.6 + Math.sign(err) * 0.25, -Math.max(0.45, m.maxFrac), Math.max(0.45, m.maxFrac));
          // turning counter-clockwise on one side: the left side backs up, or the right side drives forward
          return s.side === 'left' ? { left: -c, right: 0, done: false } : { left: 0, right: c, done: false };
        }
        return turnCap(turnTo(P, sense, h, this.tune, 0.02));
      }
      case 'turnToPoint': {
        const to = m.target!;
        const ang = Math.atan2(to.y - sense.pos.y, to.x - sense.pos.x) + (s.forwards ? 0 : Math.PI);
        return turnCap(turnTo(P, sense, ang, this.tune, 0.02));
      }
      case 'drive': {
        const total = Math.abs(s.inches);
        const along = (sense.pos.x - m.from.x) * Math.cos(m.heading!) + (sense.pos.y - m.from.y) * Math.sin(m.heading!);
        const remaining = total - Math.sign(s.inches) * along;
        if (remaining < 0.5) return settle();
        const v = Math.sign(s.inches) * Math.max(4, Math.min(vMax, vStop(remaining + 0.25)));
        return { ...wheelCommand(P, v, clamp(wrapAngle(m.heading! - sense.heading) * 3, -2, 2), tw, sense, this.tune), done: false };
      }
      default:
        return { left: 0, right: 0, done: true };
    }
  }
}
