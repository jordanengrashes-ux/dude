import type { Collider, World } from '@dimforge/rapier3d-deterministic-compat';
import { Rng } from '../core/rng';
import { IN, wrapAngle } from '../core/units';
import type { Vec2 } from '../core/vec';
import {
  buildLoaders,
  footprintInLoadZone,
  footprintInMidfield,
  footprintOnOpposingSide,
  CUP,
  PIN,
  type LoaderGeom,
} from '../field/geometry';
import { PIN_COLORS, type FieldLayout } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import { robotTopHeight } from '../robot/kinematics';
import type { FieldState, GoalState, Period, StackElement, TogglePosition, Violation } from '../rules/fieldState';
import type { Alliance, OverrideParams } from '../rules/ruleset';
import { computeScore, evaluateMatch, type MatchResult, type ScoreReport } from '../rules/scoring';
import { buildClock, isEndgame, periodAt, type MatchClock } from '../rules/timing';
import { buildField, stepToggle, toggleAngle, togglePosition, toggleTargetAngle, type FieldBodies } from '../physics/field';
import { CG, headingOf, toWorld, upOf, yawQuat, quatMul, type Quat, type V3 } from '../physics/frames';
import { ObjectManager, type SimObject } from '../physics/objects';
import { loadRapier, type Rapier } from '../physics/rapier';
import { RobotBody } from '../physics/robot';

/**
 * Match simulation: fixed-timestep physics (independent of rendering), the match
 * clock, mechanisms, the Drive Team (Match Loads), rule-violation detection,
 * and rules-engine scoring of the extracted field state.
 *
 * The displayed score is ALWAYS computeScore(extractFieldState()).
 */

export const DT = 1 / 120;

export interface MechanismRequest {
  intake: boolean;
  /** Release the object in the primary pocket. */
  release: boolean;
  /** Swap primary and secondary pockets. */
  index: boolean;
  /** Flip the primary-pocket object end-for-end. */
  reorient: boolean;
  /** Rotate a Toggle toward a color. */
  toggle: { toggleId: string; target: TogglePosition } | null;
  /** Ask the Drive Team for a Match Load. */
  matchLoad: { loaderId: string; objectId: string } | null;
}

export interface Sensing {
  /** Estimated pose (with sensor noise), inches / radians. */
  pos: Vec2;
  heading: number;
  speed: number;
  yawRate: number;
  holderHeight: number;
  t: number;
  period: Period | 'ended' | 'pre';
  heldPrimary: SimObject | null;
  heldSecondary: SimObject | null;
}

export interface Controller {
  readonly kind: string;
  update(sim: MatchSim, robot: SimRobot, sense: Sensing, dt: number): void;
}

export interface SimRobot {
  id: string;
  alliance: Alliance;
  cfg: RobotConfig;
  body: RobotBody;
  controller: Controller;
  req: MechanismRequest;
  primary: SimObject | null;
  secondary: SimObject | null;
  /** Busy mechanism (intake/index/reorient) until this time. */
  busyUntil: number;
  /** Sensor noise state. */
  noise: { pos: number; heading: number; driftX: number; driftY: number };
  trail: { t: number; x: number; y: number }[];
}

export interface SimEvent {
  t: number;
  type: 'score' | 'unscore' | 'seat' | 'intake' | 'release' | 'collision' | 'violation' | 'action' | 'failure' | 'matchload' | 'period' | 'toggle' | 'replan';
  robotId?: string;
  text: string;
  points?: number;
  alliance?: Alliance;
  ruleId?: string;
}

export interface TelemetrySample {
  t: number;
  robotId: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  accel: number;
  yawRate: number;
  utilLeft: number;
  utilRight: number;
  utilLift: number;
  liftHeight: number;
  slipping: number;
  tilt: number;
}

export interface RobotSetup {
  id: string;
  alliance: Alliance;
  config: RobotConfig;
  controller: Controller;
  start?: { pos: Vec2; heading: number };
  /** Performance scale factors for uncertainty trials. */
  motorScale?: number;
  tractionScale?: number;
  /** Pose sensor noise SD (in, rad). */
  sensorSd?: { pos: number; heading: number };
}

export interface SimOptions {
  params: OverrideParams;
  layout: FieldLayout;
  robots: RobotSetup[];
  seed: number;
  /** Object start-position jitter SD (in) for uncertainty trials. */
  objectJitterSd?: number;
  /** Start time (s) for mid-match scenarios. */
  t0?: number;
}

export class MatchSim {
  R!: Rapier;
  world!: World;
  field!: FieldBodies;
  objects!: ObjectManager;
  robots: SimRobot[] = [];
  clock: MatchClock;
  t = 0;
  steps = 0;
  events: SimEvent[] = [];
  telemetry: TelemetrySample[] = [];
  scoreTimeline: { t: number; red: number; blue: number }[] = [];
  violations: Violation[] = [];
  autoState: FieldState | null = null;
  finalState: FieldState | null = null;
  result: MatchResult | null = null;
  readonly loaders: LoaderGeom[] = buildLoaders();
  private loaderQueue: { loaderId: string; objectId: string; robotId: string; requestedAt: number }[] = [];
  private loaderFreeAt = new Map<string, number>();
  private lastReport: ScoreReport | null = null;
  private robotColliderOwner = new Map<number, string>();
  private wallHandles = new Set<number>();
  private contactState = new Map<string, boolean>();
  private violationKeys = new Set<string>();
  private rng: Rng;
  readonly opts: SimOptions;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.clock = buildClock(opts.layout.matchType, opts.params);
    this.rng = new Rng(opts.seed);
    this.t = opts.t0 ?? 0;
  }

  static async create(opts: SimOptions): Promise<MatchSim> {
    const sim = new MatchSim(opts);
    sim.R = await loadRapier();
    sim.build();
    return sim;
  }

  private build() {
    const R = this.R;
    this.world = new R.World({ x: 0, y: -9.80665, z: 0 });
    this.world.timestep = DT;
    this.world.integrationParameters.numSolverIterations = 6;
    this.field = buildField(R, this.world);
    for (const w of this.field.walls) this.wallHandles.add(w.handle);
    this.objects = new ObjectManager(R, this.world, this.field.goals);
    const L = this.opts.layout;
    // robots
    for (const rs of this.opts.robots) {
      const start = rs.start ?? L.robots.find((r) => r.slot === rs.id) ?? { pos: { x: 0, y: 0 }, heading: 0 };
      const body = new RobotBody(R, this.world, rs.id, rs.alliance, rs.config, start, this.field.floor);
      body.motorScale = rs.motorScale ?? 1;
      body.tractionScale = rs.tractionScale ?? 1;
      for (const c of [...body.colliders, body.carriageCollider]) this.robotColliderOwner.set(c.handle, rs.id);
      this.robots.push({
        id: rs.id,
        alliance: rs.alliance,
        cfg: rs.config,
        body,
        controller: rs.controller,
        req: emptyReq(),
        primary: null,
        secondary: null,
        busyUntil: 0,
        noise: { pos: rs.sensorSd?.pos ?? 0, heading: rs.sensorSd?.heading ?? 0, driftX: 0, driftY: 0 },
        trail: [],
      });
    }
    // objects
    const jitter = this.opts.objectJitterSd ?? 0;
    const sortedGoal = <T extends { start: { where: string } }>(arr: T[]) => arr;
    const goalPlacements: { obj: SimObject; goalId: string; index: number; flipped: boolean }[] = [];
    for (const p of sortedGoal(L.pins)) {
      const colors = PIN_COLORS[p.type];
      const obj = this.objects.add({ id: p.id, kind: 'pin', colors, matchloadAlliance: p.start.where === 'matchload' ? p.start.alliance : undefined });
      const s = p.start;
      if (s.where === 'field') {
        const jx = jitter ? this.rng.normal(0, jitter) : 0;
        const jy = jitter ? this.rng.normal(0, jitter) : 0;
        this.objects.spawn(obj, { x: s.pos.x + jx, y: s.pos.y + jy, z: 0, flipped: colors[1] !== s.upColor && colors[0] === s.upColor });
      } else if (s.where === 'goal') {
        goalPlacements.push({ obj, goalId: s.goalId, index: s.index ?? 0, flipped: colors[0] !== s.bottom });
      } else if (s.where === 'preload' || s.where === 'held') {
        const r = this.robots.find((x) => x.id === s.robotSlot);
        if (r) this.attachAtStart(r, obj, colors[1] !== s.upColor && colors[0] === s.upColor);
      }
    }
    for (const c of L.cups) {
      const obj = this.objects.add({ id: c.id, kind: 'cup', matchloadAlliance: c.start.where === 'matchload' ? c.start.alliance : undefined });
      const s = c.start;
      if (s.where === 'field') {
        const jx = jitter ? this.rng.normal(0, jitter) : 0;
        const jy = jitter ? this.rng.normal(0, jitter) : 0;
        this.objects.spawn(obj, { x: s.pos.x + jx, y: s.pos.y + jy, z: 0, flipped: !s.grayUp });
      } else if (s.where === 'goal') {
        goalPlacements.push({ obj, goalId: s.goalId, index: s.index, flipped: s.grayDown });
      } else if (s.where === 'held') {
        const r = this.robots.find((x) => x.id === s.robotSlot);
        if (r) this.attachAtStart(r, obj, !s.grayUp);
      }
    }
    goalPlacements.sort((a, b) => (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : a.index - b.index));
    for (const gp of goalPlacements) this.objects.preplace(gp.obj, gp.goalId, gp.flipped);
    // toggles from layout
    for (const tb of this.field.toggles) {
      const pos = L.toggles?.[tb.geom.id];
      if (pos && pos !== 'yellow') {
        const a = toggleTargetAngle(pos);
        const q = quatMul(tb.q0, { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });
        tb.body.setRotation(q, true);
      }
    }
    for (const l of this.loaders) this.loaderFreeAt.set(l.id, 0);
    this.recordScore(true);
  }

  private pocketPose(r: SimRobot, obj: SimObject, pocket: 'primary' | 'secondary', flipped: boolean): { p: V3; q: Quat } {
    const L = ((obj.kind === 'pin' ? PIN.length : CUP.length) / 2) * IN;
    const p = pocket === 'primary' ? { x: 0, y: L + 0.05 * IN, z: 0 } : { x: -0.4 * IN, y: L + 0.05 * IN, z: 3.4 * IN };
    void r;
    const q: Quat = flipped ? { x: 1, y: 0, z: 0, w: 0 } : { x: 0, y: 0, z: 0, w: 1 };
    return { p, q };
  }

  private attachAtStart(r: SimRobot, obj: SimObject, flipped: boolean) {
    const f = r.body.carriageFrame();
    const pocket = r.primary ? 'secondary' : 'primary';
    const lp = this.pocketPose(r, obj, pocket, flipped);
    const w = ObjectManager.toWorldPose(f, lp.p, lp.q);
    this.objects.spawn(obj, { x: 0, y: 0, z: 0, flipped: false });
    obj.body!.setTranslation(w.p, true);
    obj.body!.setRotation(w.q, true);
    obj.robotId = r.id;
    this.attach(r, obj, pocket, lp);
  }

  private attach(r: SimRobot, obj: SimObject, pocket: 'primary' | 'secondary', lp: { p: V3; q: Quat }) {
    const R = this.R;
    obj.body!.setBodyType(R.RigidBodyType.Dynamic, true);
    obj.collider!.setCollisionGroups(CG.held);
    const jd = R.JointData.fixed(lp.p, lp.q, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    obj.joint = this.world.createImpulseJoint(jd, r.body.carriage, obj.body!, true);
    obj.joint.setContactsEnabled(false);
    obj.mode = 'held';
    obj.pocket = pocket;
    obj.robotId = r.id;
    if (pocket === 'primary') r.primary = obj;
    else r.secondary = obj;
    r.body.setPayload((r.primary ? massOf(r.primary) : 0) + (r.secondary ? massOf(r.secondary) : 0));
  }

  robot(id: string): SimRobot | undefined {
    return this.robots.find((r) => r.id === id);
  }

  period(): Period | 'ended' {
    return periodAt(this.clock, this.t);
  }

  log(e: SimEvent) {
    this.events.push(e);
    if (this.events.length > 5000) this.events.splice(0, 1000);
  }

  // ------------------------------------------------------------------ step

  sense(r: SimRobot): Sensing {
    const pose = r.body.pose();
    let { pos, heading } = pose;
    if (r.noise.pos > 0 || r.noise.heading > 0) {
      r.noise.driftX += this.rng.normal(0, r.noise.pos * 0.02);
      r.noise.driftY += this.rng.normal(0, r.noise.pos * 0.02);
      pos = { x: pos.x + r.noise.driftX + this.rng.normal(0, r.noise.pos), y: pos.y + r.noise.driftY + this.rng.normal(0, r.noise.pos) };
      heading = wrapAngle(heading + this.rng.normal(0, r.noise.heading));
    }
    const per = this.period();
    return {
      pos,
      heading,
      speed: r.body.telemetry.speed,
      yawRate: r.body.telemetry.yawRate,
      holderHeight: r.body.holderHeight(),
      t: this.t,
      period: per,
      heldPrimary: r.primary,
      heldSecondary: r.secondary,
    };
  }

  step() {
    const per = this.period();
    const enabled = per !== 'ended';
    // Autonomous → Driver transition: snapshot at the end of Autonomous.
    if (this.clock.autonomousEnd !== null && !this.autoState && this.t >= this.clock.autonomousEnd - 1e-9) {
      this.autoState = this.extractFieldState();
      this.log({ t: this.t, type: 'period', text: 'Autonomous Period ends — snapshot taken' });
    }
    for (const r of this.robots) {
      r.req = emptyReq();
      if (enabled) r.controller.update(this, r, this.sense(r), DT);
      else {
        r.body.cmd = { left: 0, right: 0 };
        r.body.liftManual = 0;
      }
      this.processMechanisms(r);
      r.body.applyForces(DT);
    }
    for (const tb of this.field.toggles) stepToggle(tb, DT);
    this.processMatchLoads();
    this.objects.stepAnimations(
      this.t,
      (id) => this.robot(id)?.body.carriageFrame() ?? null,
      (obj) => {
        const r = this.robot(obj.robotId!);
        if (!r) return;
        const pocket = obj.pocket ?? (r.primary ? 'secondary' : 'primary');
        const flipped = upOf(obj.body!.rotation()).y < 0;
        const lp = this.pocketPose(r, obj, pocket, flipped);
        this.attach(r, obj, pocket, lp);
      },
    );
    this.world.step();
    this.t += DT;
    this.steps++;
    for (const ev of this.objects.detectSeating(this.t)) this.onSeat(ev.obj, ev.goalId, ev.robotId);
    this.checkViolations();
    this.detectCollisions();
    if (this.steps % 6 === 0) this.sampleTelemetry();
    if (this.steps % 12 === 0) this.recordScore(false);
    if (!this.finalState && this.t >= this.clock.total - 1e-9) {
      this.finalState = this.extractFieldState();
      this.recordScore(true);
      if (this.clock.matchType === 'headToHead') this.result = evaluateMatch(this.autoState ?? this.finalState, this.finalState, this.violations, this.opts.params);
      this.log({ t: this.t, type: 'period', text: 'Match ends' });
    }
  }

  /** Run headless until time t (or the end of the match). */
  runUntil(t: number, onStep?: () => boolean | void) {
    const end = Math.min(t, this.clock.total + DT / 2);
    while (this.t < end - 1e-9) {
      this.step();
      if (onStep && onStep() === false) break;
    }
  }

  // ------------------------------------------------------------- mechanisms

  private processMechanisms(r: SimRobot) {
    const req = r.req;
    const cfg = r.cfg;
    const t = this.t;
    const busy = t < r.busyUntil;
    // release
    if (req.release && r.primary && !busy) {
      const obj = r.primary;
      this.objects.release(obj, t);
      r.primary = null;
      r.body.setPayload(r.secondary ? massOf(r.secondary) : 0);
      this.log({ t, type: 'release', robotId: r.id, text: `${r.id} releases ${obj.id} at holder height ${r.body.holderHeight().toFixed(1)}"` });
    }
    // index (swap pockets)
    if (req.index && !busy && cfg.intake.capacity === 'pinAndCup' && (r.primary || r.secondary)) {
      const dur = cfg.intake.indexTimeSec;
      const f = r.body.carriageFrame();
      for (const obj of [r.primary, r.secondary]) {
        if (!obj) continue;
        const to = obj.pocket === 'primary' ? 'secondary' : 'primary';
        if (obj.joint) {
          this.world.removeImpulseJoint(obj.joint, true);
          obj.joint = null;
        }
        const from = ObjectManager.toLocal(f, obj.body!.translation(), obj.body!.rotation());
        const flipped = upOf(obj.body!.rotation()).y < 0;
        const toPose = this.pocketPose(r, obj, to, flipped);
        obj.pocket = to;
        obj.mode = 'held';
        this.objects.animate(obj, 'carriage', from, toPose, t, dur, 'held');
      }
      const a = r.primary;
      r.primary = r.secondary;
      r.secondary = a;
      r.busyUntil = t + dur;
    }
    // reorient (flip primary end-for-end)
    if (req.reorient && !busy && cfg.intake.canReorient && r.primary) {
      const obj = r.primary;
      const f = r.body.carriageFrame();
      if (obj.joint) {
        this.world.removeImpulseJoint(obj.joint, true);
        obj.joint = null;
      }
      const from = ObjectManager.toLocal(f, obj.body!.translation(), obj.body!.rotation());
      const flipped = upOf(obj.body!.rotation()).y < 0;
      const toPose = this.pocketPose(r, obj, 'primary', !flipped);
      obj.mode = 'held';
      this.objects.animate(obj, 'carriage', from, toPose, t, cfg.intake.reorientTimeSec, 'held');
      r.primary = obj;
      r.busyUntil = t + cfg.intake.reorientTimeSec;
    }
    // intake
    if (req.intake && !busy) this.tryIntake(r);
    // toggle actuation
    if (req.toggle) {
      const tb = this.field.toggles.find((x) => x.geom.id === req.toggle!.toggleId);
      if (tb) {
        const front = r.body.frontPoint(4);
        const piv = tb.body.translation();
        const d = Math.hypot(front.x - piv.x, front.z - piv.z) / IN;
        const facing = Math.abs(wrapAngle(r.body.pose().heading - Math.atan2(-tb.geom.normal.y, -tb.geom.normal.x)));
        if (d < r.cfg.toggleArm.reachIn + 4.5 && facing < (40 * Math.PI) / 180) {
          const target = toggleTargetAngle(req.toggle.target);
          const delta = wrapAngle(target - toggleAngle(tb));
          if (Math.abs(delta) > (40 * Math.PI) / 180) tb.actuate = Math.sign(delta) * 0.3;
        }
      }
    }
    // match load request
    if (req.matchLoad && !this.loaderQueue.some((q) => q.objectId === req.matchLoad!.objectId)) {
      this.loaderQueue.push({ ...req.matchLoad, robotId: r.id, requestedAt: t });
    }
  }

  private tryIntake(r: SimRobot) {
    const cfg = r.cfg;
    const single = cfg.intake.capacity === 'single';
    const fr = r.body.carriageFrame();
    const hh = r.body.holderHeight();
    const pose = r.body.pose();
    const fwd = { x: Math.cos(pose.heading), y: Math.sin(pose.heading) };
    const holder = { x: pose.pos.x + fwd.x * cfg.intake.holderOffsetIn, y: pose.pos.y + fwd.y * cfg.intake.holderOffsetIn };
    const pinHeld = [r.primary, r.secondary].some((o) => o?.kind === 'pin');
    const cupHeld = [r.primary, r.secondary].some((o) => o?.kind === 'cup');
    const anyHeld = !!(r.primary || r.secondary);
    const canTake = (k: 'pin' | 'cup') => (single ? !anyHeld : k === 'pin' ? !pinHeld && this.opts.params.possession.maxPins > 0 : !cupHeld && this.opts.params.possession.maxCups > 0);
    // floor pickups need the lift down
    if (hh <= cfg.rack.holderMinHeightIn + 1.0) {
      let best: SimObject | null = null;
      let bestD = Infinity;
      for (const obj of this.objects.objects.values()) {
        if (obj.mode !== 'free' || !obj.body || !canTake(obj.kind)) continue;
        const p = obj.body.translation();
        if (p.y / IN > 5) continue;
        const gx = p.x / IN;
        const gy = -p.z / IN;
        const dx = gx - pose.pos.x;
        const dy = gy - pose.pos.y;
        const fwdD = dx * fwd.x + dy * fwd.y;
        const lat = -dx * fwd.y + dy * fwd.x;
        if (fwdD < cfg.intake.holderOffsetIn - 2.5 || fwdD > cfg.intake.holderOffsetIn + cfg.intake.captureDepthIn) continue;
        if (Math.abs(lat) > cfg.intake.captureHalfWidthIn) continue;
        const d = Math.hypot(gx - holder.x, gy - holder.y);
        if (d < bestD) {
          bestD = d;
          best = obj;
        }
      }
      if (best) {
        this.beginIntake(r, best, fr);
        return;
      }
    }
    // descore: top element of a stack aligned with the holder at its height
    for (const st of this.objects.stacks.values()) {
      const top = st.elements[st.elements.length - 1];
      if (!top || st.pending || !canTake(top.kind)) continue;
      const off = Math.hypot(holder.x - st.goal.pos.x, holder.y - st.goal.pos.y);
      if (off > 0.8) continue;
      const bottom = top.body!.translation().y / IN - ((top.kind === 'pin' ? PIN.length : CUP.length) / 2);
      if (Math.abs(hh - bottom) > 1.0) continue;
      const g = st.goal;
      const own = g.type === 'alliance' && g.allianceColor === r.alliance;
      if (!own && this.clock.matchType === 'headToHead') this.addViolation(r, g.type === 'alliance' ? 'SG9' : 'SG10', 'major', `${r.id} removed ${top.id} from ${g.id}`);
      const obj = this.objects.unstackTop(g.id);
      if (obj) {
        this.log({ t: this.t, type: 'intake', robotId: r.id, text: `${r.id} removes ${obj.id} from ${g.id}` });
        this.beginIntake(r, obj, fr);
      }
      return;
    }
  }

  private beginIntake(r: SimRobot, obj: SimObject, fr: { p: V3; q: Quat }) {
    const pocket: 'primary' | 'secondary' = r.primary ? 'secondary' : 'primary';
    if (pocket === 'secondary' && r.cfg.intake.capacity === 'single') return;
    obj.robotId = r.id;
    obj.pocket = pocket;
    const from = ObjectManager.toLocal(fr, obj.body!.translation(), obj.body!.rotation());
    // stand it upright, keeping whichever end is currently higher on top
    const flipped = upOf(obj.body!.rotation()).y < 0;
    const to = this.pocketPose(r, obj, pocket, flipped);
    const dur = r.cfg.intake.intakeTimeSec + (pocket === 'secondary' ? r.cfg.intake.indexTimeSec : 0);
    this.objects.animate(obj, 'carriage', from, to, this.t, dur, 'held');
    if (pocket === 'primary') r.primary = obj;
    else r.secondary = obj;
    r.busyUntil = this.t + dur;
    this.log({ t: this.t, type: 'intake', robotId: r.id, text: `${r.id} intakes ${obj.id}` });
  }

  private processMatchLoads() {
    const P = this.opts.params.matchLoads;
    const per = this.period();
    const allowed = per === 'driver' || per === 'skills' || (per === 'autonomous' && P.allowedInAutonomous);
    if (!allowed) return;
    for (let i = 0; i < this.loaderQueue.length; i++) {
      const q = this.loaderQueue[i];
      const l = this.loaders.find((x) => x.id === q.loaderId);
      const obj = this.objects.objects.get(q.objectId);
      if (!l || !obj || obj.mode !== 'offfield') {
        this.loaderQueue.splice(i--, 1);
        continue;
      }
      const ready = Math.max(this.loaderFreeAt.get(l.id) ?? 0, q.requestedAt, per === 'driver' ? this.clock.autonomousEnd ?? 0 : 0) + P.humanLoadSec;
      if (this.t < ready) continue;
      // the Loader mouth must be clear
      const blocked = [...this.objects.objects.values()].some((o) => {
        if (o.mode !== 'free' || !o.body) return false;
        const p = o.body.translation();
        return Math.hypot(p.x / IN - l.dispense.x, -p.z / IN - l.dispense.y) < 3;
      });
      if (blocked) continue;
      const yaw = Math.atan2(-l.outward.y, -l.outward.x);
      this.objects.spawn(obj, { x: l.dispense.x, y: l.dispense.y, z: 0, flipped: false, yaw }, this.t);
      this.loaderFreeAt.set(l.id, this.t);
      this.loaderQueue.splice(i--, 1);
      this.log({ t: this.t, type: 'matchload', robotId: q.robotId, text: `Drive Team introduces ${obj.id} at ${l.id}` });
    }
  }

  // --------------------------------------------------------------- rules

  private onSeat(obj: SimObject, goalId: string, robotId?: string) {
    const g = this.field.goals.find((x) => x.id === goalId)!;
    this.log({ t: this.t, type: 'seat', robotId, text: `${obj.id} nests on ${goalId}` });
    const r = robotId ? this.robot(robotId) : undefined;
    if (!r || this.clock.matchType !== 'headToHead') return;
    if (g.type === 'alliance' && g.allianceColor !== r.alliance) this.addViolation(r, 'SG9', 'major', `${r.id} placed ${obj.id} in the opposing Alliance Goal ${goalId}`);
    if (g.type === 'midfield' && isEndgame(this.clock, this.t)) this.addViolation(r, 'SG12', 'minor', `${r.id} placed ${obj.id} on the Midfield Goal during the Endgame`);
  }

  addViolation(r: SimRobot, ruleId: string, severity: 'minor' | 'major', description: string, onceKey?: string) {
    const per = this.period();
    if (per === 'ended') return;
    const key = onceKey ?? `${r.id}|${ruleId}|${description}`;
    if (this.violationKeys.has(key)) return;
    this.violationKeys.add(key);
    const v: Violation = { robotId: r.id, alliance: r.alliance, ruleId, severity, period: per, time: this.t, description };
    this.violations.push(v);
    this.log({ t: this.t, type: 'violation', robotId: r.id, ruleId, text: `${ruleId}: ${description}` });
  }

  private checkViolations() {
    if (this.clock.matchType !== 'headToHead') return;
    const per = this.period();
    for (const r of this.robots) {
      const p = r.body.pose();
      const L = r.cfg.chassis.lengthIn;
      const W = r.cfg.chassis.widthIn;
      if (per === 'autonomous' && footprintOnOpposingSide(p.pos, p.heading, L, W, r.alliance)) {
        this.addViolation(r, 'SG7', 'minor', `${r.id} crossed the Autonomous Line`, `${r.id}|SG7|auto`);
      }
      if (per === 'driver') {
        const opp: Alliance = r.alliance === 'red' ? 'blue' : 'red';
        if (footprintInLoadZone(p.pos, p.heading, L, W, opp)) this.addViolation(r, 'Load Zones', 'minor', `${r.id} entered the ${opp} Load Zone`, `${r.id}|LZ|${Math.floor(this.t / 5)}`);
      }
      const P = this.opts.params.robot;
      const endgame = isEndgame(this.clock, this.t);
      const top = robotTopHeight(r.cfg, r.body.holderHeight());
      if (top > P.verticalMaxIn + 0.1 && (!endgame || P.verticalLimitAppliesInEndgame)) this.addViolation(r, 'SG (vertical)', 'minor', `${r.id} exceeded ${P.verticalMaxIn}" height`, `${r.id}|V`);
    }
  }

  private detectCollisions() {
    for (let i = 0; i < this.robots.length; i++) {
      for (let j = i + 1; j < this.robots.length; j++) {
        const a = this.robots[i];
        const b = this.robots[j];
        let touching = false;
        for (const ca of a.body.colliders) {
          this.world.contactPairsWith(ca, (c2) => {
            if (this.robotColliderOwner.get(c2.handle) === b.id) touching = true;
          });
          if (touching) break;
        }
        const key = `${a.id}|${b.id}`;
        if (touching && !this.contactState.get(key)) this.log({ t: this.t, type: 'collision', robotId: a.id, text: `${a.id} ↔ ${b.id} contact` });
        this.contactState.set(key, touching);
      }
    }
  }

  // ------------------------------------------------------------- extraction

  /** Build the rules-engine FieldState from the physical state. */
  extractFieldState(): FieldState {
    const goals: GoalState[] = this.field.goals.map((g) => {
      const st = this.objects.stacks.get(g.id)!;
      const stack: StackElement[] = st.elements.map((obj) => {
        const up = upOf(obj.body!.rotation()).y >= 0;
        if (obj.kind === 'pin') {
          const [c0, c1] = obj.colors!;
          // local −Y half = colors[0]; if upright, it points down
          return { kind: 'pin', id: obj.id, bottom: up ? c0 : c1, top: up ? c1 : c0, robotContact: this.objectTouchesRobot(obj) };
        }
        return { kind: 'cup', id: obj.id, grayDown: !up };
      });
      return { id: g.id, type: g.type, allianceColor: g.allianceColor, quadrant: g.quadrant, stack };
    });
    const toggles = this.field.toggles.map((tb) => {
      let contact = false;
      this.world.contactPairsWith(tb.collider, (c2) => {
        if (this.robotColliderOwner.has(c2.handle)) contact = true;
      });
      return { quadrant: tb.geom.quadrant, position: togglePosition(tb), robotContact: contact };
    });
    const robots = this.robots.map((r) => {
      const p = r.body.pose();
      let perim = false;
      for (const c of r.body.colliders) {
        this.world.contactPairsWith(c, (c2) => {
          if (this.wallHandles.has(c2.handle)) perim = true;
        });
      }
      return { id: r.id, alliance: r.alliance, inMidfield: footprintInMidfield(p.pos, p.heading, r.cfg.chassis.lengthIn, r.cfg.chassis.widthIn), contactingPerimeter: perim };
    });
    return { goals, toggles, robots };
  }

  private objectTouchesRobot(obj: SimObject): boolean {
    if (!obj.collider) return false;
    let touch = false;
    this.world.contactPairsWith(obj.collider, (c2: Collider) => {
      if (this.robotColliderOwner.has(c2.handle)) touch = true;
    });
    return touch;
  }

  /** Live score from the rules engine (what the UI displays). */
  liveScore(): ScoreReport {
    const per = this.period();
    const ctxPeriod: Period = this.clock.matchType === 'headToHead' ? (per === 'autonomous' ? 'autonomous' : 'driver') : 'skills';
    return computeScore(this.extractFieldState(), this.opts.params, { matchType: this.clock.matchType, period: ctxPeriod });
  }

  /** Totals including the Autonomous Bonus once decided. */
  displayTotals(): { red: number; blue: number; bonus: { red: number; blue: number } | null } {
    const rep = this.liveScore();
    if (this.clock.matchType !== 'headToHead' || !this.autoState) return { red: rep.totals.red, blue: rep.totals.blue, bonus: null };
    const m = evaluateMatch(this.autoState, this.extractFieldState(), this.violations, this.opts.params);
    return { red: m.totals.red, blue: m.totals.blue, bonus: { red: m.bonus.red, blue: m.bonus.blue } };
  }

  private recordScore(force: boolean) {
    const rep = this.liveScore();
    const d = this.displayTotalsFrom(rep);
    const last = this.scoreTimeline[this.scoreTimeline.length - 1];
    if (force || !last || last.red !== d.red || last.blue !== d.blue || this.t - last.t > 1) this.scoreTimeline.push({ t: this.t, red: d.red, blue: d.blue });
    if (this.lastReport) {
      const key = (l: (typeof rep.lines)[number]) => `${l.alliance}|${l.ruleId}|${l.goalId}|${l.objectId}|${l.half}|${l.robotId}`;
      const before = new Set(this.lastReport.lines.map(key));
      const after = new Set(rep.lines.map(key));
      for (const l of rep.lines) if (!before.has(key(l))) this.log({ t: this.t, type: 'score', alliance: l.alliance, points: l.points, ruleId: l.ruleId, text: `+${l.points} ${l.alliance}: ${l.explanation} [${l.ruleId}]` });
      for (const l of this.lastReport.lines) if (!after.has(key(l))) this.log({ t: this.t, type: 'unscore', alliance: l.alliance, points: -l.points, ruleId: l.ruleId, text: `−${l.points} ${l.alliance}: ${l.explanation} no longer scores` });
    }
    this.lastReport = rep;
  }

  private displayTotalsFrom(rep: ScoreReport) {
    if (this.clock.matchType !== 'headToHead' || !this.autoState) return rep.totals;
    const m = evaluateMatch(this.autoState, this.extractFieldState(), this.violations, this.opts.params);
    return m.totals;
  }

  private sampleTelemetry() {
    for (const r of this.robots) {
      const p = r.body.pose();
      const tl = r.body.telemetry;
      this.telemetry.push({
        t: this.t,
        robotId: r.id,
        x: p.pos.x,
        y: p.pos.y,
        heading: p.heading,
        speed: tl.speed,
        accel: tl.accel,
        yawRate: tl.yawRate,
        utilLeft: tl.utilLeft,
        utilRight: tl.utilRight,
        utilLift: tl.utilLift,
        liftHeight: tl.liftHeight,
        slipping: tl.slipping,
        tilt: tl.tilt,
      });
      const last = r.trail[r.trail.length - 1];
      if (!last || Math.hypot(last.x - p.pos.x, last.y - p.pos.y) > 1) r.trail.push({ t: this.t, x: p.pos.x, y: p.pos.y });
    }
  }

  /** Deterministic fingerprint of all body poses (determinism tests / replay check). */
  fingerprint(): string {
    const parts: string[] = [];
    this.world.forEachRigidBody((b) => {
      const t = b.translation();
      const r = b.rotation();
      parts.push(`${t.x.toFixed(6)},${t.y.toFixed(6)},${t.z.toFixed(6)},${r.w.toFixed(6)},${r.x.toFixed(6)},${r.y.toFixed(6)},${r.z.toFixed(6)}`);
    });
    return parts.join(';');
  }

  /** Render snapshot of everything movable. */
  snapshot() {
    return {
      t: this.t,
      robots: this.robots.map((r) => {
        const ct = r.body.chassis.translation();
        const cq = r.body.chassis.rotation();
        const kt = r.body.carriage.translation();
        const kq = r.body.carriage.rotation();
        return { id: r.id, alliance: r.alliance, chassis: { p: { ...ct }, q: { x: cq.x, y: cq.y, z: cq.z, w: cq.w } }, carriage: { p: { ...kt }, q: { x: kq.x, y: kq.y, z: kq.z, w: kq.w } }, wheels: r.body.wheels.map((w) => ({ ...w })) };
      }),
      objects: [...this.objects.objects.values()].map((o) => {
        if (!o.body) return { id: o.id, kind: o.kind, mode: o.mode, p: null, q: null };
        const t = o.body.translation();
        const q = o.body.rotation();
        return { id: o.id, kind: o.kind, mode: o.mode, p: { x: t.x, y: t.y, z: t.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
      }),
      toggles: this.field.toggles.map((tb) => {
        const q = tb.body.rotation();
        return { id: tb.geom.id, q: { x: q.x, y: q.y, z: q.z, w: q.w }, position: togglePosition(tb) };
      }),
    };
  }

  /** Current physical state as a FieldLayout (for MPC replanning). */
  layoutNow(): FieldLayout {
    const L = this.opts.layout;
    const pins: FieldLayout['pins'] = [];
    const cups: FieldLayout['cups'] = [];
    for (const spec of L.pins) {
      const o = this.objects.objects.get(spec.id)!;
      pins.push({ ...spec, start: this.objStart(o) as FieldLayout['pins'][number]['start'] });
    }
    for (const spec of L.cups) {
      const o = this.objects.objects.get(spec.id)!;
      cups.push({ ...spec, start: this.objStart(o) as FieldLayout['cups'][number]['start'] });
    }
    const toggles: Record<string, 'red' | 'yellow' | 'blue'> = {};
    for (const tb of this.field.toggles) {
      const pos = togglePosition(tb);
      toggles[tb.geom.id] = pos === 'unseated' ? 'yellow' : pos;
    }
    return {
      matchType: L.matchType,
      pins,
      cups,
      robots: this.robots.map((r) => ({ slot: r.id, alliance: r.alliance, pos: r.body.pose().pos, heading: r.body.pose().heading })),
      toggles,
      provenance: `Physical state at t=${this.t.toFixed(2)} s`,
    };
  }

  private objStart(o: SimObject): unknown {
    if (o.mode === 'offfield') return o.matchloadAlliance ? { where: 'matchload', alliance: o.matchloadAlliance } : { where: 'unavailable' };
    const b = o.body!;
    const t = b.translation();
    const up = upOf(b.rotation()).y >= 0;
    if (o.mode === 'stacked') {
      const st = o.stack!;
      if (o.kind === 'pin') {
        const [c0, c1] = o.colors!;
        return { where: 'goal', goalId: st.goalId, bottom: up ? c0 : c1, top: up ? c1 : c0, index: st.index };
      }
      return { where: 'goal', goalId: st.goalId, grayDown: !up, index: st.index };
    }
    if (o.mode === 'held' || o.mode === 'intaking' || o.mode === 'indexing') {
      if (o.kind === 'pin') return { where: 'held', robotSlot: o.robotId, upColor: up ? o.colors![1] : o.colors![0] };
      return { where: 'held', robotSlot: o.robotId, grayUp: up };
    }
    if (o.mode === 'seating') return { where: 'unavailable' };
    const pos = { x: t.x / IN, y: -t.z / IN };
    const lying = Math.abs(upOf(b.rotation()).y) < 0.7;
    if (o.kind === 'pin') return { where: 'field', pos, upColor: up ? o.colors![1] : o.colors![0], lying };
    return { where: 'field', pos, grayUp: up, lying };
  }

  dispose() {
    this.world.free();
  }
}

function emptyReq(): MechanismRequest {
  return { intake: false, release: false, index: false, reorient: false, toggle: null, matchLoad: null };
}

function massOf(o: SimObject) {
  return o.kind === 'pin' ? PIN.massKg : CUP.massKg;
}

export { headingOf, toWorld, yawQuat };
