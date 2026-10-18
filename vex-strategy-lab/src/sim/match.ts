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
  nestOffset,
  PIN,
  pinSeatLift,
  stackTop,
  type LoaderGeom,
} from '../field/geometry';
import { fitStartToWall, PIN_COLORS, type FieldLayout } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import { CLAW } from '../robot/claw';
import { robotTopHeight } from '../robot/kinematics';
import type { FieldState, GoalState, Period, StackElement, TogglePosition, Violation } from '../rules/fieldState';
import type { Alliance, OverrideParams } from '../rules/ruleset';
import { computeScore, evaluateMatch, type MatchResult, type ScoreReport } from '../rules/scoring';
import { buildClock, isEndgame, periodAt, type MatchClock } from '../rules/timing';
import { buildField, stepToggle, toggleAngle, togglePosition, toggleTargetAngle, type FieldBodies } from '../physics/field';
import { headingOf, rotateV, toWorld, upOf, yawQuat, quatMul, type Quat, type V3 } from '../physics/frames';
import { bottomIn, halfLenIn, ObjectManager, objectColliders, tiltDeg, type SimObject } from '../physics/objects';
import { loadRapier, type Rapier } from '../physics/rapier';
import { RobotBody } from '../physics/robot';
import type { AlignHint, SceneFrame } from './frame';

/**
 * Match simulation: fixed-timestep physics (independent of rendering), the match
 * clock, mechanisms, the Drive Team (Match Loads), rule-violation detection,
 * and rules-engine scoring of the extracted field state.
 *
 * The displayed score is ALWAYS computeScore(extractFieldState()).
 */

export const DT = 1 / 120;

export interface MechanismRequest {
  /** Run the claw's rollers inward: a piece between the jaws is pulled in and gripped. */
  intake: boolean;
  /** Run the rollers outward: what the claw holds is pushed out the front. */
  outtake: boolean;
  /** Run only the pocket for this kind (a controlled intake); null = whatever fits. */
  intakeKind?: 'pin' | 'cup' | null;
  /** Only pick up loose objects, never the top of a Goal stack. */
  noDescore?: boolean;
  /** A driver's claw: only a piece right at the jaws (not a bot's wider capture zone). */
  precise?: boolean;
  /** Open the claw: everything it holds drops. */
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
  /** The gripped piece (a claw) / first pocket, and the next one (nested on it / second pocket). */
  primary: SimObject | null;
  secondary: SimObject | null;
  /** Everything held: a claw's stack bottom first (the gripped piece, then each one nested on it). */
  held: SimObject[];
  /** Claw rollers this step: 1 in, −1 out, 0 stopped. */
  rollers: -1 | 0 | 1;
  /** Busy mechanism (intake/index/reorient) until this time. */
  busyUntil: number;
  /** Sensor noise state. */
  noise: { pos: number; heading: number; driftX: number; driftY: number };
  trail: { t: number; x: number; y: number }[];
  /** A driver's claw: closed / open; null when a bot drives (closed = holding something). */
  clawClosed: boolean | null;
  /** The driver plays in easy mode (Goals capture this robot's drops more loosely). */
  easy: boolean;
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
  /** Practice: drivers drive from the first second; no rule-violation checks. */
  practice?: boolean;
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
    if (opts.practice) {
      // practice has no time limit: one driver period that never ends
      const per = this.clock.phases[this.clock.phases.length - 1].period;
      this.clock = { matchType: this.clock.matchType, phases: [{ period: per, start: 0, end: Infinity }], total: Infinity, autonomousEnd: null, endgameStart: Infinity };
    }
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
      const ls = L.robots.find((r) => r.slot === rs.id);
      const start = rs.start ?? (ls ? fitStartToWall(ls, rs.config.chassis.lengthIn, rs.config.chassis.widthIn) : { pos: { x: 0, y: 0 }, heading: 0 });
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
        held: [],
        rollers: 0,
        busyUntil: 0,
        noise: { pos: rs.sensorSd?.pos ?? 0, heading: rs.sensorSd?.heading ?? 0, driftX: 0, driftY: 0 },
        trail: [],
        clawClosed: null,
        easy: false,
      });
    }
    // objects
    const jitter = this.opts.objectJitterSd ?? 0;
    const sortedGoal = <T extends { start: { where: string } }>(arr: T[]) => arr;
    const goalPlacements: { obj: SimObject; goalId: string; index: number; flipped: boolean }[] = [];
    // a Pin that starts in a Cup moves with it
    const cupJitter = new Map<string, { x: number; y: number }>();
    for (const p of sortedGoal(L.pins)) {
      const colors = PIN_COLORS[p.type];
      const obj = this.objects.add({ id: p.id, kind: 'pin', colors, matchloadAlliance: p.start.where === 'matchload' ? p.start.alliance : undefined });
      const s = p.start;
      if (s.where === 'field') {
        const j = { x: jitter ? this.rng.normal(0, jitter) : 0, y: jitter ? this.rng.normal(0, jitter) : 0 };
        const x = s.pos.x + j.x;
        const y = s.pos.y + j.y;
        const upEnd = colors[1] === s.upColor || colors[0] !== s.upColor; // local +Y half is the named one
        if (s.lying) this.objects.spawn(obj, { x, y, z: 0, flipped: false, lie: (s.axis ?? 0) + (upEnd ? 0 : Math.PI) });
        else {
          if (s.inCup) cupJitter.set(s.inCup, j);
          this.objects.spawn(obj, { x, y, z: s.inCup ? CUP.length - PIN.half + pinSeatLift() : 0, flipped: !upEnd });
        }
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
        const j = cupJitter.get(c.id) ?? { x: jitter ? this.rng.normal(0, jitter) : 0, y: jitter ? this.rng.normal(0, jitter) : 0 };
        this.objects.spawn(obj, { x: s.pos.x + j.x, y: s.pos.y + j.y, z: 0, flipped: !s.grayUp });
      } else if (s.where === 'goal') {
        goalPlacements.push({ obj, goalId: s.goalId, index: s.index, flipped: s.grayDown });
      } else if (s.where === 'held') {
        const r = this.robots.find((x) => x.id === s.robotSlot);
        if (r) this.attachAtStart(r, obj, !s.grayUp);
      }
    }
    for (const p of L.pins) {
      const cup = p.start.where === 'field' && p.start.inCup ? this.objects.objects.get(p.start.inCup) : undefined;
      const pin = this.objects.objects.get(p.id);
      if (cup?.body && pin?.body) this.objects.bond(cup, pin);
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

  /** Upright (keeping whichever end is up and the yaw it has in the claw). */
  private static upright(q: Quat): Quat {
    return ObjectManager.uprightRotation(q, headingOf(q));
  }

  /**
   * Where each held piece belongs in the holder (carriage frame): a claw grips the
   * bottom piece with its base just above the holder bottom and every piece nested on
   * it sits one nesting step higher; a two-pocket holder has a pocket beside the first.
   */
  private retarget(r: SimRobot, speed: number = CLAW.surfaceSpeed, rate = 6) {
    const single = r.cfg.intake.capacity === 'single';
    let cy = 0;
    r.held.forEach((o, i) => {
      const h = o.hold!;
      const L = halfLenIn(o.kind);
      let p: V3;
      if (single) {
        cy = i === 0 ? L + 0.05 : cy + nestOffset();
        p = { x: 0, y: cy * IN, z: 0 };
      } else p = o.pocket === 'secondary' ? { x: -0.4 * IN, y: (L + 0.05) * IN, z: 3.4 * IN } : { x: 0, y: (L + 0.05) * IN, z: 0 };
      // taken off a stack: held where it was gripped until it is clear of the stack
      if (h.clearOf) p = { ...h.local.p };
      h.target = { p, q: MatchSim.upright(h.local.q) };
      h.speed = speed;
      h.rate = rate;
    });
    this.refreshHeld(r);
  }

  private refreshHeld(r: SimRobot) {
    if (r.cfg.intake.capacity === 'single') {
      r.held.forEach((o, i) => (o.pocket = i === 0 ? 'primary' : 'secondary'));
      r.primary = r.held[0] ?? null;
      r.secondary = r.held[1] ?? null;
    } else {
      r.primary = r.held.find((o) => o.pocket === 'primary') ?? null;
      r.secondary = r.held.find((o) => o.pocket === 'secondary') ?? null;
    }
    r.body.setPayload(r.held.reduce((m, o) => m + massOf(o), 0));
  }

  /** Grip pieces where they are now (carriage frame); the rollers then seat them in the holder. */
  private grip(r: SimRobot, objs: SimObject[], opts: { clearOf?: string; pocket?: 'primary' | 'secondary'; at?: 'top' | 'bottom' } = {}) {
    const f = r.body.carriageFrame();
    const added: SimObject[] = [];
    for (const o of objs) {
      const local = ObjectManager.toLocal(f, o.body!.translation(), o.body!.rotation());
      const cols = this.objects.grip(o, r.id, r.body.carriage, local, local, CLAW.surfaceSpeed, 6);
      for (const c of cols) this.robotColliderOwner.set(c.handle, r.id);
      if (opts.clearOf && o === objs[0]) o.hold!.clearOf = opts.clearOf;
      if (opts.pocket) o.pocket = opts.pocket;
      added.push(o);
    }
    r.held = opts.at === 'bottom' ? [...added, ...r.held] : [...r.held, ...added];
    this.retarget(r);
    r.busyUntil = Math.max(r.busyUntil, this.t + 0.12);
    this.log({ t: this.t, type: 'intake', robotId: r.id, text: `${r.id} intakes ${added.map((o) => o.id).join(' + ')}` });
    this.checkPossession(r);
  }

  /** Let go of everything held (the claw opens; `push` m/s when the rollers spit it out). */
  private letGo(r: SimRobot, push?: V3) {
    if (!r.held.length) return;
    const ids = r.held.map((o) => o.id).join(' + ');
    for (const o of r.held) {
      for (const c of o.hold?.colliders ?? []) this.robotColliderOwner.delete(c.handle);
      this.objects.ungrip(o, this.t, r.body.carriage, push, r.easy);
    }
    r.held = [];
    this.refreshHeld(r);
    this.log({ t: this.t, type: 'release', robotId: r.id, text: `${r.id} ${push ? 'pushes out' : 'releases'} ${ids} at holder height ${r.body.holderHeight().toFixed(1)}"` });
  }

  private attachAtStart(r: SimRobot, obj: SimObject, flipped: boolean) {
    // spawned in the holder, then gripped there (already in place)
    const f = r.body.carriageFrame();
    const L = halfLenIn(obj.kind);
    const single = r.cfg.intake.capacity === 'single';
    const below = r.held[r.held.length - 1];
    let lp: V3 = { x: 0, y: (L + 0.05) * IN, z: 0 };
    if (below && single) lp = { x: 0, y: below.hold!.target.p.y + nestOffset() * IN, z: 0 };
    else if (below) lp = { x: -0.4 * IN, y: (L + 0.05) * IN, z: 3.4 * IN };
    const lq: Quat = flipped ? { x: 1, y: 0, z: 0, w: 0 } : { x: 0, y: 0, z: 0, w: 1 };
    const w = ObjectManager.toWorldPose(f, lp, lq);
    this.objects.spawn(obj, { x: 0, y: 0, z: 0, flipped: false });
    obj.body!.setTranslation(w.p, true);
    obj.body!.setRotation(w.q, true);
    this.grip(r, [obj], { pocket: below && !single ? 'secondary' : 'primary' });
    r.busyUntil = 0;
  }

  robot(id: string): SimRobot | undefined {
    return this.robots.find((r) => r.id === id);
  }

  period(): Period | 'ended' {
    return periodAt(this.clock, this.t);
  }

  log(e: SimEvent) {
    this.events.push(e);
    if (this.events.length > 6000) this.events.splice(0, 2000); // endless practice
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
    if (this.steps % 6 === 3) this.bondSettledPairs();
    this.objects.stepBonds();
    this.objects.stepAssist(this.t);
    this.stepClaws();
    this.world.step();
    this.t += DT;
    this.steps++;
    this.syncClaws();
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
    r.rollers = req.outtake ? -1 : req.intake ? 1 : 0;
    // open the claw: everything held drops
    if (req.release && r.held.length) this.letGo(r);
    // rollers out: what is held is pushed out the front; loose pieces at the jaws are pushed away
    if (req.outtake) {
      const f = r.body.carriageFrame();
      const out = rotateV(f.q, { x: CLAW.outSpeed * IN, y: 0, z: 0 });
      if (r.held.length) this.letGo(r, out);
      else for (const o of this.atJaws(r)) this.pushPiece(r, o.obj, out);
    }
    // index (swap pockets)
    if (req.index && !busy && cfg.intake.capacity === 'pinAndCup' && r.held.length) {
      for (const o of r.held) o.pocket = o.pocket === 'primary' ? 'secondary' : 'primary';
      this.retarget(r, 3.4 / Math.max(0.05, cfg.intake.indexTimeSec));
      r.busyUntil = t + cfg.intake.indexTimeSec;
    }
    // reorient (a wrist flips the gripped piece end-for-end, up where it has room)
    if (req.reorient && !busy && cfg.intake.canReorient && r.primary && (cfg.intake.capacity !== 'single' || r.held.length === 1) && r.body.holderHeight() >= halfLenIn(r.primary.kind) - 0.5) {
      const h = r.primary.hold!;
      h.target = { p: h.target.p, q: quatMul(h.target.q, { x: 1, y: 0, z: 0, w: 0 }) };
      h.rate = Math.PI / Math.max(0.05, cfg.intake.reorientTimeSec);
      r.busyUntil = t + cfg.intake.reorientTimeSec;
    }
    // rollers in: pull in and grip
    if (req.intake && !req.outtake && !busy) this.runIntake(r);
    // toggle actuation
    if (req.toggle) {
      const tb = this.field.toggles.find((x) => x.geom.id === req.toggle!.toggleId);
      if (tb) {
        // The arm reaches `reachIn` past the bumper; the bar can be worked anywhere along its length.
        const g = tb.geom;
        const pose = r.body.pose();
        const front = { x: pose.pos.x + Math.cos(pose.heading) * (r.cfg.chassis.lengthIn / 2), y: pose.pos.y + Math.sin(pose.heading) * (r.cfg.chassis.lengthIn / 2) };
        const rel = { x: front.x - g.pos.x, y: front.y - g.pos.y };
        const along = rel.x * g.tangent.x + rel.y * g.tangent.y;
        const gap = rel.x * g.normal.x + rel.y * g.normal.y; // bumper to the inner wall face
        const facing = Math.abs(wrapAngle(pose.heading - Math.atan2(-g.normal.y, -g.normal.x)));
        if (Math.abs(along) < g.length / 2 && gap < r.cfg.toggleArm.reachIn + 2.5 && facing < (40 * Math.PI) / 180) {
          const target = toggleTargetAngle(req.toggle.target);
          const delta = wrapAngle(target - toggleAngle(tb));
          if (Math.abs(delta) > (40 * Math.PI) / 180) tb.actuate = Math.sign(delta) * 600; // rad/s²: past the ridge, the detent seats it
        }
      }
    }
    // match load request
    if (req.matchLoad && !this.loaderQueue.some((q) => q.objectId === req.matchLoad!.objectId)) {
      this.loaderQueue.push({ ...req.matchLoad, robotId: r.id, requestedAt: t });
    }
  }

  /** Can the holder take one more piece of this kind? A bot never goes over the possession limit. */
  private canTake(r: SimRobot, k: 'pin' | 'cup', also: SimObject[] = []): boolean {
    const want = r.req.intakeKind ?? null;
    if (want !== null && k !== want) return false;
    const all = [...r.held, ...also];
    if (r.cfg.intake.capacity !== 'single') return !all.some((o) => o.kind === k) && r.held.length < 2;
    if (r.clawClosed === null) {
      const P = this.opts.params.possession;
      const n = all.filter((o) => o.kind === k).length + 1;
      return n <= (k === 'pin' ? P.maxPins : P.maxCups);
    }
    return true;
  }

  /**
   * Loose pieces at the claw's jaws, nearest first (carriage frame, in): in front of
   * the holder axis between the roller shafts, low enough for the rollers to reach.
   * A driver's claw reaches only what is at its jaws; easy mode and bots reach further.
   */
  private atJaws(r: SimRobot): { obj: SimObject; x: number; z: number; d: number }[] {
    const cfg = r.cfg;
    const f = r.body.carriageFrame();
    const hh = r.body.holderHeight();
    const zone = r.req.precise ? { depth: 3.0, half: 1.2 } : r.easy ? { depth: 4.5, half: 2.6 } : { depth: cfg.intake.captureDepthIn, half: cfg.intake.captureHalfWidthIn };
    const out: { obj: SimObject; x: number; z: number; d: number }[] = [];
    for (const obj of this.objects.objects.values()) {
      if (obj.mode !== 'free' || !obj.body) continue;
      const lp = ObjectManager.toLocal(f, obj.body.translation(), obj.body.rotation()).p;
      const x = lp.x / IN;
      const z = lp.z / IN;
      if (x < -1.2 || x > zone.depth || Math.abs(z) > zone.half) continue;
      const b = bottomIn(obj) - hh;
      if (b < -2.5 || b > 1.5) continue;
      out.push({ obj, x, z, d: Math.hypot(x, z) });
    }
    return out.sort((p, q) => p.d - q.d);
  }

  /** The rollers drive a loose piece (and anything bonded to it) at the claw's velocity plus `v` (m/s, world). */
  private pushPiece(r: SimRobot, obj: SimObject, v: V3) {
    const car = r.body.carriage;
    const w = car.angvel();
    for (const o of this.objects.bondedGroup(obj)) {
      const b = o.body!;
      const vc = car.velocityAtPoint(b.translation());
      const cur = b.linvel();
      b.setLinvel({ x: vc.x + v.x, y: cur.y, z: vc.z + v.z }, true);
      // the rollers hold it upright as it moves (a Cup lying down just slides)
      const up = upOf(b.rotation());
      const k = o.kind === 'pin' || Math.abs(up.y) > 0.7 ? 10 * Math.sign(up.y || 1) : 0;
      b.setAngvel({ x: -up.z * k, y: w.y, z: up.x * k }, true);
    }
  }

  private runIntake(r: SimRobot) {
    const cfg = r.cfg;
    const single = cfg.intake.capacity === 'single';
    const f = r.body.carriageFrame();
    // holding a stack: a piece nested under the gripped one is taken in at the bottom
    // (the rollers lift the stack and grip the new piece under it)
    if (single && r.held.length) {
      const base = r.held[0];
      const under = this.objects.nestedOn(base, -1);
      if (under && this.canTake(r, under.kind) && (under.kind !== 'pin' || tiltDeg(under) <= cfg.intake.maxPinTiltDeg)) this.grip(r, [under], { at: 'bottom' });
      return;
    }
    const full = single ? r.held.length > 0 : r.held.length >= 2;
    if (full) return;
    // the nearest loose piece at the jaws: pulled toward the holder axis, gripped once there
    for (const c of this.atJaws(r)) {
      const obj = c.obj;
      if (!this.canTake(r, obj.kind)) continue;
      // the claw closes only around a standing Pin: one lying on its side (or tipped
      // past the claw's limit) slips out and is never lifted
      if (obj.kind === 'pin' && tiltDeg(obj) > cfg.intake.maxPinTiltDeg) continue;
      // the top piece of a pair isn't between the rollers — its base is
      if (this.objects.nestedOn(obj, -1)) continue;
      const pocket = single || !r.held.length ? 'primary' : 'secondary';
      // a second pocket fills beside the first: the piece is taken when it reaches the first one.
      // A Cup lying down is too long to come all the way in: it is gripped where it stops and stood up.
      const lying = obj.kind === 'cup' && tiltDeg(obj) > 30;
      const reach = pocket === 'primary' ? (lying ? 2.3 : 0.45) : (r.held[0] ? (r.held[0].kind === 'pin' ? PIN.diameter : CUP.diameter) / 2 : 0) + (obj.kind === 'pin' ? PIN.diameter : CUP.diameter) / 2 + 0.3;
      if (c.d < reach) {
        // pieces nested on it ride along (a claw only; a bot never takes more than it may possess)
        const chain = [obj];
        if (single) {
          for (let top = this.objects.nestedOn(obj, 1); top && !chain.includes(top); top = this.objects.nestedOn(top, 1)) {
            if (r.clawClosed === null && !this.canTake(r, top.kind, chain)) break;
            chain.push(top);
          }
        }
        this.grip(r, chain, { pocket });
        return;
      }
      const k = CLAW.surfaceSpeed;
      const clamp = (v: number) => Math.max(-k, Math.min(k, v));
      // centering first (the shafts squeeze it between them), then in toward the axis
      const v = rotateV(f.q, { x: clamp(-c.x * 8) * IN, y: 0, z: clamp(-c.z * 12) * IN });
      this.pushPiece(r, obj, v);
      return;
    }
    // descore: the top element of a stack between the jaws at the holder's height
    if (r.req.noDescore || r.held.length) return;
    const hh = r.body.holderHeight();
    for (const st of this.objects.stacks.values()) {
      const top = st.elements[st.elements.length - 1];
      if (!top || !this.canTake(r, top.kind)) continue;
      const lp = ObjectManager.toLocal(f, top.body!.translation(), top.body!.rotation()).p;
      if (Math.hypot(lp.x, lp.z) / IN > 0.8) continue;
      if (Math.abs(bottomIn(top) - hh) > 1.2) continue;
      const g = st.goal;
      const own = g.type === 'alliance' && g.allianceColor === r.alliance;
      if (!own && this.clock.matchType === 'headToHead') this.addViolation(r, g.type === 'alliance' ? 'SG9' : 'SG10', 'major', `${r.id} removed ${top.id} from ${g.id}`);
      const obj = this.objects.unstackTop(g.id);
      if (obj) {
        this.log({ t: this.t, type: 'intake', robotId: r.id, text: `${r.id} removes ${obj.id} from ${g.id}` });
        this.grip(r, [obj], { clearOf: g.id, pocket: 'primary' });
      }
      return;
    }
  }

  /** Possession limit (matches only): more Pins or Cups held than allowed. */
  private checkPossession(r: SimRobot) {
    if (this.opts.practice || this.clock.matchType !== 'headToHead') return;
    const P = this.opts.params.possession;
    const pins = r.held.filter((o) => o.kind === 'pin').length;
    const cups = r.held.filter((o) => o.kind === 'cup').length;
    if (pins > P.maxPins || cups > P.maxCups) this.addViolation(r, 'SG (possession)', 'minor', `${r.id} held ${pins} Pin${pins === 1 ? '' : 's'} and ${cups} Cup${cups === 1 ? '' : 's'} (limit ${P.maxPins} + ${P.maxCups})`, `${r.id}|POSS|${r.held.map((o) => o.id).join(',')}`);
  }

  /** The rollers move held pieces into place (before the physics step). */
  private stepClaws() {
    for (const r of this.robots) for (const o of r.held) this.objects.stepHeld(o, DT);
  }

  /** Held pieces' bodies follow their claws (after the physics step). */
  private syncClaws() {
    for (const r of this.robots) {
      if (!r.held.length) continue;
      const f = r.body.carriageFrame();
      let changed = false;
      for (const o of r.held) {
        this.objects.syncHeld(o, f);
        const h = o.hold!;
        if (!h.clearOf) continue;
        // clear of the stack it came off: well above what is left of it, or away from it
        const st = this.objects.stacks.get(h.clearOf)!;
        const p = o.body!.translation();
        const off = Math.hypot(p.x / IN - st.goal.pos.x, -p.z / IN - st.goal.pos.y);
        if (bottomIn(o) > stackTop(st.goal.height, st.elements.length) + 1.3 || off > 3.4) {
          h.clearOf = undefined;
          changed = true;
        }
      }
      if (changed) this.retarget(r);
    }
  }

  /**
   * A piece that came to rest nested on a loose one (a Pin dropped into a Cup, a Cup
   * over a Pin, a pair set down) is held to it like the field's starting pairs.
   */
  private bondSettledPairs() {
    const still = (o: SimObject) => {
      const v = o.body!.linvel();
      return Math.hypot(v.x, v.y, v.z) / IN < 0.5 && tiltDeg(o) < 10;
    };
    // seated, not caught at the top of a bounce: the middles sit a half plus the seat lift apart
    const seated = CUP.half + pinSeatLift();
    for (const top of this.objects.objects.values()) {
      if (top.mode !== 'free' || !top.body || !still(top)) continue;
      const below = (o: SimObject, other: SimObject) => other.body!.translation().y < o.body!.translation().y;
      if (top.bonds.some((bd) => below(top, bd.other))) continue; // already held to its base
      const base = this.objects.nestedOn(top, -1);
      if (!base?.body || !still(base) || base.bonds.some((bd) => !below(base, bd.other))) continue;
      if (Math.abs(Math.abs(top.body.translation().y - base.body.translation().y) / IN - seated) > 0.2) continue;
      this.objects.bond(base, top);
    }
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
    if (this.clock.matchType !== 'headToHead' || this.opts.practice) return;
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
    let touch = false;
    for (const c of objectColliders(obj)) {
      this.world.contactPairsWith(c, (c2: Collider) => {
        if (this.robotColliderOwner.has(c2.handle)) touch = true;
      });
      if (touch) break;
    }
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
      if (r.trail.length > 4000) r.trail.splice(0, 1000);
    }
    // endless practice: keep recent history only (a 2-minute match stays well below)
    if (this.telemetry.length > 40000) this.telemetry.splice(0, 10000);
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

  /** Render frame of the current state (see sim/frame.ts). */
  sceneFrame(): SceneFrame {
    const pq = (b: { translation(): V3; rotation(): Quat }) => {
      const t = b.translation();
      const q = b.rotation();
      return { p: { x: t.x, y: t.y, z: t.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
    };
    return {
      t: this.t,
      robots: this.robots.map((r) => {
        const holding = (r.held.some((o) => o.kind === 'pin') ? 1 : 0) | (r.held.some((o) => o.kind === 'cup') ? 2 : 0);
        return { id: r.id, alliance: r.alliance, cfg: r.cfg, chassis: pq(r.body.chassis), carriage: pq(r.body.carriage), holderH: r.body.holderHeight(), trail: r.trail, claw: r.clawClosed ?? (holding !== 0 || r.rollers > 0), holding, rollers: r.rollers, align: this.alignHint(r) };
      }),
      objects: [...this.objects.objects.values()].map((o) =>
        o.body ? { id: o.id, kind: o.kind, colors: o.colors, ...pq(o.body), stacked: o.mode === 'stacked' } : { id: o.id, kind: o.kind, colors: o.colors, p: null, q: null },
      ),
      toggles: this.field.toggles.map((tb) => ({ id: tb.geom.id, ...pq(tb.body) })),
    };
  }

  /**
   * Aligner for what a robot would drop (the gripped piece, with anything nested on
   * it): the nearest Goal that takes that kind next — or loose piece standing on the
   * tiles it would nest on (a Pin into a Cup, a Cup over a Pin) — and whether opening
   * the claw now drops it in: its tip over the opening (within what the opening's
   * funnel takes, from the shapes) and its bottom clear above the rim.
   */
  alignHint(r: SimRobot): AlignHint | null {
    const obj = r.held[0];
    if (!obj?.body || obj.mode !== 'held') return null;
    const p = obj.body.translation();
    const x = p.x / IN;
    const y = -p.z / IN;
    const bottom = bottomIn(obj);
    let best: AlignHint | null = null;
    let bestOff = 8;
    for (const tg of this.objects.dropTargets(obj.kind)) {
      const off = Math.hypot(x - tg.at.x, y - tg.at.y);
      if (off >= bestOff) continue;
      bestOff = off;
      const tol = r.easy ? this.objects.funnel.assistRadius : tg.tol;
      const lined = off <= tol;
      const high = bottom >= tg.top - 0.15;
      best = { goal: tg.goal ? tg.goal.goal.id : tg.id, state: lined && high ? 2 : lined ? 1 : 0, top: tg.top, tol, from: { x, y }, ...(tg.piece ? { at: tg.at } : {}) };
    }
    return best;
  }

  /** Current physical state as a FieldLayout (for MPC replanning). */
  layoutNow(forRobot?: SimRobot): FieldLayout {
    const L = this.opts.layout;
    const pins: FieldLayout['pins'] = [];
    const cups: FieldLayout['cups'] = [];
    // a Pin tipped past what this robot's claw can grab is out of its reach
    const maxTilt = forRobot?.cfg.intake.maxPinTiltDeg ?? 90;
    for (const spec of L.pins) {
      const o = this.objects.objects.get(spec.id)!;
      const tipped = o.mode === 'free' && !!o.body && tiltDeg(o) > maxTilt;
      const start = (tipped ? { where: 'unavailable' } : this.objStart(o)) as FieldLayout['pins'][number]['start'];
      // standing in a Cup: the pair is picked up together
      const cup = start.where === 'field' && !start.lying ? this.objects.nestedOn(o, -1) : null;
      pins.push({ ...spec, start: cup && start.where === 'field' ? { ...start, inCup: cup.id } : start });
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
    if (o.mode === 'held') {
      if (o.kind === 'pin') return { where: 'held', robotSlot: o.robotId, upColor: up ? o.colors![1] : o.colors![0] };
      return { where: 'held', robotSlot: o.robotId, grayUp: up };
    }
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
  return { intake: false, outtake: false, intakeKind: null, noDescore: false, precise: false, release: false, index: false, reorient: false, toggle: null, matchLoad: null };
}

function massOf(o: SimObject) {
  return o.kind === 'pin' ? PIN.massKg : CUP.massKg;
}

export { headingOf, toWorld, yawQuat };
