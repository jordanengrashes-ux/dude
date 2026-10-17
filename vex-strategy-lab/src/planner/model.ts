import { clamp, wrapAngle } from '../core/units';
import type { Vec2 } from '../core/vec';
import { add, dist, fromAngle, obbCorners, scale, sub, distPointToPolygon } from '../core/vec';
import {
  buildGoals,
  buildLoaders,
  buildToggles,
  footprintInMidfield,
  HALF,
  MIDFIELD_INNER_HALF,
  PIN,
  CUP,
  quadrantOf,
  sideOf,
  type GoalGeom,
  type LoaderGeom,
  type ToggleGeom,
} from '../field/geometry';
import type { FieldLayout, PinType } from '../field/layout';
import { PIN_COLORS } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import { derivePerf, liftTime, maxHolderHeight, polylineTime, robotTopHeight, straightTime, turnTime, type DrivePerf } from '../robot/kinematics';
import type { FieldState, QuadrantId, RobotStatus, StackElement, TogglePosition } from '../rules/fieldState';
import type { Alliance, HalfColor, MatchType, OverrideParams } from '../rules/ruleset';
import { computeScore, evaluateAwp, type ScoreReport } from '../rules/scoring';
import { buildClock, type MatchClock } from '../rules/timing';
import { DistanceField } from './astar';
import { Grid } from './grid';
import { VisGraph } from './visgraph';

/**
 * Abstract game model for planning.
 *
 * A PlanState captures everything that matters for scoring decisions: robot pose,
 * lift height, held objects (≤ 1 Pin + 1 Cup), every object's status, Goal stacks,
 * Toggle positions, Match Load usage and the clock. Actions are macro-actions
 * (pick / load / place / toggle / park / wait) whose durations come from the robot
 * performance model (robot/kinematics.ts) and grid path planning (A* / Dijkstra).
 * Scores are ALWAYS computed by the rules engine (rules/scoring.ts) on a FieldState
 * built from the PlanState — the planner has no point values of its own.
 */

export type ObjKind = 'pin' | 'cup';

export interface StaticObj {
  idx: number;
  id: string;
  kind: ObjKind;
  pinType?: PinType;
  colors?: [HalfColor, HalfColor];
  startPos?: Vec2;
  startWhere: 'field' | 'goal' | 'preload' | 'matchload';
  matchloadAlliance?: Alliance;
  preloadSlot?: string;
  /** Initial orientation bit: pin → index of color facing up; cup → 1 if gray up. */
  startUp: number;
  startGoal?: string;
}

export const ST_FIELD = 0;
export const ST_HELD = 1;
export const ST_PLACED = 2;
export const ST_UNAVAILABLE = 3;
export const ST_MATCHLOAD = 4;

export type Action =
  | { type: 'pick'; obj: number }
  | { type: 'load'; obj: number; loader: number }
  | { type: 'place'; goal: number; bit: number }
  | { type: 'toggle'; toggle: number }
  | { type: 'park' }
  | { type: 'wait'; until: number };

export interface ExternalEvent {
  t: number;
  kind: 'claim' | 'place' | 'toggle' | 'midfield';
  obj?: number;
  goal?: number;
  bit?: number;
  toggle?: number;
  position?: TogglePosition;
  alliance?: Alliance;
  robotId?: string;
}

export interface PlanState {
  t: number;
  pos: Vec2;
  heading: number;
  holderH: number;
  heldPin: number;
  heldCup: number;
  status: Uint8Array;
  up: Uint8Array;
  /** Stack element codes per goal: objIdx * 2 + bit (pin: bit = index of color DOWN; cup: bit = 1 if gray DOWN). */
  stacks: number[][];
  toggles: TogglePosition[];
  loaderFreeAt: number[];
  parked: boolean;
  eventsApplied: number;
  /** External robots predicted in the Midfield at end (from events). */
  extMidfield: { alliance: Alliance; robotId: string }[];
  auto?: { own: number; opp: number; awp: boolean; report: ScoreReport };
  depth: number;
}

export interface StepInfo {
  action: Action;
  label: string;
  tStart: number;
  tEnd: number;
  travelDist: number;
  travelTime: number;
  turnTime: number;
  liftTime: number;
  mechTime: number;
  waitTime: number;
  path: Vec2[];
  endPos: Vec2;
  endHeading: number;
  holderH: number;
  valueBefore: number;
  valueAfter: number;
  /** Probability-of-failure estimate from tolerances (0..1). */
  risk: number;
  notes: string[];
}

export interface PlanConfig {
  params: OverrideParams;
  robot: RobotConfig;
  layout: FieldLayout;
  matchType: MatchType;
  robotId: string;
  alliance: Alliance;
  /** Planning window, absolute match seconds. */
  tStart: number;
  tEnd: number;
  objective: 'own' | 'margin';
  /** Points-equivalent value assigned to earning the AWP (0 = ignore). */
  awpWeight: number;
  includeAutonBonus: boolean;
  /** Predicted opponent Autonomous score (H2H) when no events describe it. */
  opponentAutoScore: number;
  externalEvents: ExternalEvent[];
  /** Max candidate pickups per kind considered at each decision (∞ = all). */
  candidateK: number;
  /** Allow the Park (end in Midfield) action. */
  allowPark: boolean;
  /** Controller cruise fraction used for time estimates. */
  cruiseFraction: number;
  /** Positioning error standard deviation (in) for risk estimates. */
  positionSigma: number;
  /** Restrict to these object indices (small scenarios / tests). */
  objectFilter?: (o: StaticObj) => boolean;
  /** Restrict to these goal ids. */
  goalFilter?: (g: GoalGeom) => boolean;
  toggleFilter?: (t: ToggleGeom) => boolean;
  /** Initial robot pose override. */
  startPose?: { pos: Vec2; heading: number; holderH?: number };
}

const APPROACH = 8; // straight-in distance before pickup/placement (in)

export interface PoseExcept {
  goal?: string;
  loader?: string;
  toggle?: string;
}
const DIRS = 12;

export class PlanWorld {
  readonly cfg: PlanConfig;
  readonly perf: DrivePerf;
  readonly clock: MatchClock;
  readonly objs: StaticObj[];
  readonly goals: GoalGeom[];
  readonly toggles: ToggleGeom[];
  readonly loaders: LoaderGeom[];
  readonly gridAuto: Grid;
  readonly gridDriver: Grid;
  readonly clearance: number;
  readonly maxHolder: number;
  readonly legalHolder: { pre: number; end: number };
  private dfCache = new Map<string, DistanceField>();
  private approachCache = new Map<string, { pre: Vec2; center: Vec2; heading: number }[]>();
  private vgAuto?: VisGraph;
  private vgDriver?: VisGraph;
  evaluations = 0;

  constructor(cfg: PlanConfig, shared?: { from: PlanWorld; motorScale?: number }) {
    this.cfg = cfg;
    this.perf = derivePerf(cfg.robot, { cruiseFraction: cfg.cruiseFraction, motorScale: shared?.motorScale });
    this.clock = buildClock(cfg.matchType, cfg.params);
    this.goals = buildGoals().filter((g) => !cfg.goalFilter || cfg.goalFilter(g));
    this.toggles = buildToggles().filter((t) => !cfg.toggleFilter || cfg.toggleFilter(t));
    this.loaders = buildLoaders();
    this.clearance = Math.max(cfg.robot.chassis.lengthIn, cfg.robot.chassis.widthIn) / 2 + 1.5;
    if (shared) {
      // Geometry depends only on robot footprint, alliance and match type — share it.
      const f = shared.from;
      this.gridAuto = f.gridAuto;
      this.gridDriver = f.gridDriver;
      this.vgAuto = f.vgAuto;
      this.vgDriver = f.vgDriver;
      this.approachCache = f.approachCache;
      this.dfCache = f.dfCache;
    } else {
      this.gridAuto = new Grid({ clearance: this.clearance, alliance: cfg.alliance, forbidOpposingSide: cfg.matchType === 'headToHead' });
      this.gridDriver = new Grid({ clearance: this.clearance, alliance: cfg.alliance, forbidOpposingLoadZones: cfg.matchType === 'headToHead' });
    }
    this.maxHolder = maxHolderHeight(cfg.robot);
    const vmax = cfg.params.robot.verticalMaxIn;
    const legalPre = Math.min(this.maxHolder, vmax - cfg.robot.rack.carriageHeightIn);
    this.legalHolder = { pre: legalPre, end: cfg.params.robot.verticalLimitAppliesInEndgame ? legalPre : this.maxHolder };
    this.objs = [];
    const L = cfg.layout;
    for (const p of L.pins) {
      const s = p.start;
      const colors = PIN_COLORS[p.type];
      const o: StaticObj = {
        idx: this.objs.length,
        id: p.id,
        kind: 'pin',
        pinType: p.type,
        colors,
        startWhere: s.where,
        startUp: s.where === 'field' || s.where === 'preload' ? (colors[1] === s.upColor ? 1 : 0) : 1,
      };
      if (s.where === 'field') o.startPos = s.pos;
      if (s.where === 'matchload') o.matchloadAlliance = s.alliance;
      if (s.where === 'preload') o.preloadSlot = s.robotSlot;
      if (s.where === 'goal') o.startGoal = s.goalId;
      this.objs.push(o);
    }
    for (const c of L.cups) {
      const s = c.start;
      const o: StaticObj = { idx: this.objs.length, id: c.id, kind: 'cup', startWhere: s.where, startUp: s.where === 'field' ? (s.grayUp ? 1 : 0) : 1 };
      if (s.where === 'field') o.startPos = s.pos;
      if (s.where === 'matchload') o.matchloadAlliance = s.alliance;
      this.objs.push(o);
    }
  }

  /**
   * Same scenario with a different robot (performance, battery, traction) —
   * used by Monte Carlo robustness trials. Footprint must be unchanged.
   */
  fork(opts: { robot?: RobotConfig; motorScale?: number; positionSigma?: number; config?: Partial<PlanConfig> }): PlanWorld {
    const cfg: PlanConfig = { ...this.cfg, ...opts.config, robot: opts.robot ?? this.cfg.robot, positionSigma: opts.positionSigma ?? this.cfg.positionSigma };
    this.visGraph(this.gridAuto);
    this.visGraph(this.gridDriver);
    return new PlanWorld(cfg, { from: this, motorScale: opts.motorScale });
  }

  // ---------------------------------------------------------------- state

  initialState(): PlanState {
    const cfg = this.cfg;
    const N = this.objs.length;
    const status = new Uint8Array(N);
    const up = new Uint8Array(N);
    const stacks: number[][] = this.goals.map(() => []);
    let heldPin = -1;
    const slot = cfg.robotId;
    for (const o of this.objs) {
      up[o.idx] = o.startUp;
      if (cfg.objectFilter && !cfg.objectFilter(o)) {
        status[o.idx] = ST_UNAVAILABLE;
        continue;
      }
      switch (o.startWhere) {
        case 'field':
          status[o.idx] = ST_FIELD;
          break;
        case 'goal': {
          status[o.idx] = ST_PLACED;
          const gi = this.goals.findIndex((g) => g.id === o.startGoal);
          if (gi >= 0) stacks[gi].push(o.idx * 2 + 0);
          break;
        }
        case 'preload':
          if (o.preloadSlot === slot) {
            status[o.idx] = ST_HELD;
            heldPin = o.idx;
          } else status[o.idx] = ST_UNAVAILABLE;
          break;
        case 'matchload':
          status[o.idx] = o.matchloadAlliance === cfg.alliance ? ST_MATCHLOAD : ST_UNAVAILABLE;
          break;
      }
    }
    const rs = cfg.layout.robots.find((r) => r.slot === slot) ?? cfg.layout.robots[0];
    const sp = cfg.startPose ?? { pos: rs.pos, heading: rs.heading };
    const s: PlanState = {
      t: cfg.tStart,
      pos: { ...sp.pos },
      heading: sp.heading,
      holderH: cfg.startPose?.holderH ?? cfg.robot.rack.holderMinHeightIn,
      heldPin,
      heldCup: -1,
      status,
      up,
      stacks,
      toggles: this.toggles.map(() => 'yellow' as TogglePosition),
      loaderFreeAt: this.loaders.map(() => cfg.tStart),
      parked: false,
      eventsApplied: 0,
      extMidfield: [],
      depth: 0,
    };
    this.applyEvents(s, s.t);
    return s;
  }

  clone(s: PlanState): PlanState {
    return {
      ...s,
      pos: { ...s.pos },
      status: s.status.slice(),
      up: s.up.slice(),
      stacks: s.stacks.map((x) => x.slice()),
      toggles: s.toggles.slice(),
      loaderFreeAt: s.loaderFreeAt.slice(),
      extMidfield: s.extMidfield.slice(),
    };
  }

  private applyEvents(s: PlanState, upTo: number) {
    const ev = this.cfg.externalEvents;
    while (s.eventsApplied < ev.length && ev[s.eventsApplied].t <= upTo) {
      const e = ev[s.eventsApplied++];
      if (e.kind === 'claim' && e.obj !== undefined) {
        if (s.status[e.obj] === ST_FIELD || s.status[e.obj] === ST_MATCHLOAD) s.status[e.obj] = ST_UNAVAILABLE;
      } else if (e.kind === 'place' && e.goal !== undefined && e.obj !== undefined) {
        const gi = this.goals.findIndex((g) => g.id === this.goalIdFromIndex(e.goal!));
        if (gi >= 0) s.stacks[gi].push(e.obj * 2 + (e.bit ?? 0));
        s.status[e.obj] = ST_PLACED;
      } else if (e.kind === 'toggle' && e.toggle !== undefined && e.position) {
        const ti = this.toggles.findIndex((t) => t.id === buildToggles()[e.toggle!].id);
        if (ti >= 0) s.toggles[ti] = e.position;
      } else if (e.kind === 'midfield' && e.alliance && e.robotId) {
        if (!s.extMidfield.some((m) => m.robotId === e.robotId)) s.extMidfield.push({ alliance: e.alliance, robotId: e.robotId });
      }
    }
  }

  /** External events reference the global goal index (buildGoals order). */
  private goalIdFromIndex(i: number): string {
    return buildGoals()[i].id;
  }

  isAutonomous(t: number): boolean {
    return this.clock.autonomousEnd !== null && t < this.clock.autonomousEnd - 1e-9;
  }

  periodEnd(t: number): number {
    if (this.isAutonomous(t)) return Math.min(this.clock.autonomousEnd!, this.cfg.tEnd);
    return this.cfg.tEnd;
  }

  isEndgame(t: number): boolean {
    return t >= this.clock.endgameStart;
  }

  gridAt(t: number): Grid {
    return this.isAutonomous(t) ? this.gridAuto : this.gridDriver;
  }

  objPos(s: PlanState, o: StaticObj, loader?: number): Vec2 | null {
    if (s.status[o.idx] === ST_FIELD && o.startPos) return o.startPos;
    if (loader !== undefined) return this.loaders[loader].dispense;
    return null;
  }

  // ------------------------------------------------------------ geometry

  /** Holder-axis point for a robot pose. */
  holderPoint(pos: Vec2, heading: number): Vec2 {
    return add(pos, fromAngle(heading, this.cfg.robot.intake.holderOffsetIn));
  }

  /**
   * Is the robot footprint at this pose clear of fixed Field Elements? The element
   * being approached is exempt: a Goal post enters the U-slot, a Loader corner sits
   * in front of the slot, a Toggle is touched by the front of the robot.
   */
  poseClear(center: Vec2, heading: number, except: PoseExcept = {}): boolean {
    const r = this.cfg.robot.chassis;
    const poly = obbCorners(center, heading, r.lengthIn, r.widthIn);
    for (const p of poly) if (Math.abs(p.x) > HALF - 0.3 || Math.abs(p.y) > HALF - 0.3) return false;
    for (const g of this.allGoals) {
      if (g.id === except.goal) continue;
      if (distPointToPolygon(g.pos, poly) < g.postRadius + 0.6) return false;
    }
    for (const l of this.loaders) {
      if (l.id === except.loader) continue;
      if (distPointToPolygon(l.corner, poly) < l.footprint * Math.SQRT2 + 0.5) return false;
    }
    for (const t of this.allToggles) {
      if (t.id === except.toggle) continue;
      if (distPointToPolygon(t.pos, poly) < 2.5) return false;
    }
    return true;
  }

  private _allGoals?: GoalGeom[];
  get allGoals(): GoalGeom[] {
    return (this._allGoals ??= buildGoals());
  }
  private _allToggles?: ToggleGeom[];
  get allToggles(): ToggleGeom[] {
    return (this._allToggles ??= buildToggles());
  }

  /**
   * Candidate approaches that put the holder axis on `target`, facing `heading`.
   * Returns the pre-approach point (reached by path planning) and the final pose.
   */
  approaches(target: Vec2, key: string, except: PoseExcept = {}, onlyHeading?: number): { pre: Vec2; center: Vec2; heading: number }[] {
    const cached = this.approachCache.get(key);
    if (cached) return cached;
    const out: { pre: Vec2; center: Vec2; heading: number }[] = [];
    const off = this.cfg.robot.intake.holderOffsetIn;
    const headings = onlyHeading !== undefined ? [onlyHeading] : Array.from({ length: DIRS }, (_, k) => (k / DIRS) * 2 * Math.PI);
    for (const h of headings) {
      const u = fromAngle(h);
      const center = sub(target, scale(u, off));
      const pre = sub(center, scale(u, APPROACH));
      if (!this.poseClear(center, h, except)) continue;
      if (!this.poseClear(pre, h, except)) continue;
      // intermediate pose halfway along the straight-in
      if (!this.poseClear(sub(center, scale(u, APPROACH / 2)), h, except)) continue;
      out.push({ pre, center, heading: h });
    }
    this.approachCache.set(key, out);
    return out;
  }

  distanceField(grid: Grid, target: Vec2): DistanceField {
    const key = `${grid === this.gridAuto ? 'A' : 'D'}:${Math.round(target.x * 2)}:${Math.round(target.y * 2)}`;
    let df = this.dfCache.get(key);
    if (!df) {
      df = new DistanceField(grid, target);
      if (this.dfCache.size > 4000) this.dfCache.clear();
      this.dfCache.set(key, df);
    }
    return df;
  }

  private pathCache = new Map<string, { pts: Vec2[]; len: number; time?: number } | null>();
  private _objDMinGoal?: Float64Array;
  /** Static: distance from each object's start position to the nearest planning Goal. */
  get objDMinGoal(): Float64Array {
    if (!this._objDMinGoal) {
      const a = new Float64Array(this.objs.length).fill(Infinity);
      for (const o of this.objs) if (o.startPos) for (const g of this.goals) a[o.idx] = Math.min(a[o.idx], dist(o.startPos, g.pos));
      this._objDMinGoal = a;
    }
    return this._objDMinGoal;
  }

  visGraph(grid: Grid): VisGraph {
    if (grid === this.gridAuto) return (this.vgAuto ??= new VisGraph(grid));
    return (this.vgDriver ??= new VisGraph(grid));
  }

  /**
   * Travel from the current pose to an approach (pre-point → straight-in).
   * The path is the direct line when clear, otherwise the distance-field shortest
   * path (string-pulled). Search and reporting use the same computation, so the
   * times the optimizer ranks plans by are exactly the times it reports.
   */
  travel(s: PlanState, ap: { pre: Vec2; center: Vec2; heading: number }, _detailed: boolean): { time: number; dist: number; turn: number; path: Vec2[] } | null {
    const grid = this.gridAt(s.t);
    const p = this.perf;
    // If the robot sits inside the inflated region of the element it just used,
    // it first reverses straight out (the way it came in).
    let startPt = s.pos;
    let backOut = 0;
    if (grid.pointBlocked(s.pos)) {
      const back = fromAngle(s.heading + Math.PI);
      for (let k = 1; k <= 14; k++) {
        const q = add(s.pos, scale(back, k));
        if (!grid.pointBlocked(q)) {
          startPt = q;
          backOut = k;
          break;
        }
      }
    }
    const key = `${grid === this.gridAuto ? 'A' : 'D'}|${startPt.x.toFixed(1)},${startPt.y.toFixed(1)}|${ap.pre.x.toFixed(1)},${ap.pre.y.toFixed(1)}|${ap.heading.toFixed(3)}`;
    let cached = this.pathCache.get(key);
    if (cached === undefined) {
      let pts: Vec2[] | null;
      if (dist(startPt, ap.pre) < 0.5 || grid.lineFree(startPt, ap.pre)) pts = [startPt, ap.pre];
      else pts = this.visGraph(grid).path(startPt, grid.pointBlocked(ap.pre) ? grid.nearestFree(ap.pre) ?? ap.pre : ap.pre);
      if (pts && dist(pts[pts.length - 1], ap.pre) > 1e-6) pts = [...pts, ap.pre];
      cached = pts ? { pts, len: pts.reduce((acc, q, i) => (i ? acc + dist(pts![i - 1], q) : 0), 0) } : null;
      if (this.pathCache.size > 200000) this.pathCache.clear();
      this.pathCache.set(key, cached);
    }
    if (!cached) return null;
    const pts = [...cached.pts, ap.center];
    const moving = cached.len > 1;
    const firstDir = moving ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : ap.heading;
    const preDir = moving ? Math.atan2(ap.pre.y - pts[pts.length - 3].y, ap.pre.x - pts[pts.length - 3].x) : s.heading;
    const t0 = this.turnCost(Math.abs(wrapAngle(firstDir - s.heading)));
    const t1 = this.turnCost(Math.abs(wrapAngle(ap.heading - preDir))) * (moving ? 0.5 : 1);
    const tBack = backOut > 0 ? straightTime(p, backOut) : 0;
    if (cached.time === undefined) cached.time = polylineTime(p, pts);
    const time = tBack + cached.time + t0 + t1;
    const path = backOut > 0 ? [s.pos, ...pts] : pts;
    return { time, dist: backOut + cached.len + APPROACH, turn: t0 + t1, path };
  }

  /** Turn cost for a heading change; small changes are absorbed by path following. */
  turnCost(angle: number): number {
    if (angle < 0.15) return 0;
    return turnTime(this.perf, angle) * clamp(angle / Math.PI + 0.35, 0.35, 1);
  }

  // ------------------------------------------------------------- scoring

  fieldState(s: PlanState, atEnd: boolean): FieldState {
    const goals = this.allGoals.map((g) => {
      const gi = this.goals.findIndex((x) => x.id === g.id);
      const stack: StackElement[] = gi < 0 ? [] : s.stacks[gi].map((code) => this.element(code));
      return { id: g.id, type: g.type, allianceColor: g.allianceColor, quadrant: g.quadrant, stack };
    });
    const toggles = this.allToggles.map((t) => {
      const ti = this.toggles.findIndex((x) => x.id === t.id);
      return { quadrant: t.quadrant, position: ti < 0 ? ('yellow' as TogglePosition) : s.toggles[ti], robotContact: false };
    });
    const robots: RobotStatus[] = [
      {
        id: this.cfg.robotId,
        alliance: this.cfg.alliance,
        inMidfield: atEnd && s.parked,
        contactingPerimeter: false,
      },
    ];
    if (atEnd) for (const m of s.extMidfield) robots.push({ id: m.robotId, alliance: m.alliance, inMidfield: true, contactingPerimeter: false });
    return { goals, toggles, robots };
  }

  element(code: number): StackElement {
    const o = this.objs[code >> 1];
    const bit = code & 1;
    if (o.kind === 'pin') {
      const down = o.colors![bit];
      const top = o.colors![1 - bit];
      return { kind: 'pin', id: o.id, bottom: down, top };
    }
    return { kind: 'cup', id: o.id, grayDown: bit === 1 };
  }

  score(s: PlanState, atEnd = true): ScoreReport {
    this.evaluations++;
    const period = this.cfg.matchType === 'headToHead' ? (this.isAutonomous(s.t) && !atEnd ? 'autonomous' : 'driver') : 'skills';
    return computeScore(this.fieldState(s, atEnd), this.cfg.params, { matchType: this.cfg.matchType, period });
  }

  /**
   * Objective value of stopping here: the robot idles for the rest of the window,
   * remaining external events (other robots' predicted actions) still happen and the
   * Autonomous snapshot is taken at the end of Autonomous.
   */
  value(s0: PlanState): number {
    const ae = this.clock.autonomousEnd;
    const pendingEvents = s0.eventsApplied < this.cfg.externalEvents.length;
    const pendingAuto = this.cfg.matchType === 'headToHead' && ae !== null && !s0.auto && this.cfg.tStart < ae && this.cfg.tEnd > ae;
    const s = pendingEvents || pendingAuto ? this.finalize(s0) : s0;
    const opp: Alliance = this.cfg.alliance === 'red' ? 'blue' : 'red';
    const endIsAuto = this.cfg.matchType === 'headToHead' && this.clock.autonomousEnd !== null && this.cfg.tEnd <= this.clock.autonomousEnd + 1e-9;
    const rep = endIsAuto ? this.autoReport(s) : this.score(s, true);
    let v = rep.totals[this.cfg.alliance];
    if (this.cfg.objective === 'margin') v -= rep.totals[opp];
    v += this.autoTerms(s, endIsAuto ? rep : undefined);
    return v;
  }

  private autoReport(s: PlanState): ScoreReport {
    return computeScore(this.fieldState(s, false), this.cfg.params, { matchType: 'headToHead', period: 'autonomous' });
  }

  /** Autonomous Bonus + AWP contributions (Head-to-Head windows that include Autonomous). */
  private autoTerms(s: PlanState, autoRep?: ScoreReport): number {
    if (this.cfg.matchType !== 'headToHead' || this.clock.autonomousEnd === null) return 0;
    if (this.cfg.tStart >= this.clock.autonomousEnd) return 0;
    let snap = s.auto;
    if (!snap) {
      const rep = autoRep ?? this.autoReport(s);
      snap = this.makeAutoSnapshot(s, rep);
    }
    let v = 0;
    const B = this.cfg.params.points;
    if (this.cfg.includeAutonBonus) {
      const mine = snap.own > snap.opp ? B.autonomousBonus : snap.own === snap.opp ? B.autonomousBonusTieEach : 0;
      const theirs = snap.opp > snap.own ? B.autonomousBonus : snap.own === snap.opp ? B.autonomousBonusTieEach : 0;
      v += mine;
      if (this.cfg.objective === 'margin') v -= theirs;
    }
    if (snap.awp) v += this.cfg.awpWeight;
    return v;
  }

  private makeAutoSnapshot(s: PlanState, rep: ScoreReport) {
    const opp: Alliance = this.cfg.alliance === 'red' ? 'blue' : 'red';
    const fs = this.fieldState(s, false);
    const awp = evaluateAwp(fs, rep, [], this.cfg.alliance, this.cfg.params).earned;
    const oppScore = Math.max(rep.totals[opp], this.cfg.opponentAutoScore);
    return { own: rep.totals[this.cfg.alliance], opp: oppScore, awp, report: rep };
  }

  /** Advance the clock (applying events and the Autonomous snapshot when crossing it). */
  advanceTo(s: PlanState, t: number) {
    const ae = this.clock.autonomousEnd;
    if (ae !== null && !s.auto && s.t < ae + 1e-9 && t >= ae - 1e-9 && this.cfg.tStart < ae) {
      this.applyEvents(s, ae);
      s.auto = this.makeAutoSnapshot(s, this.autoReport(s));
    }
    s.t = t;
    this.applyEvents(s, t);
  }

  // ------------------------------------------------------------- actions

  /** Next stack element type for a goal: even length → pin, odd → cup. */
  nextKind(s: PlanState, gi: number): ObjKind {
    return s.stacks[gi].length % 2 === 0 ? 'pin' : 'cup';
  }

  /** Holder-bottom height required to drop the next element onto goal gi. */
  requiredHolder(s: PlanState, gi: number): number {
    const g = this.goals[gi];
    const n = s.stacks[gi].length;
    // top of current stack
    let top: number;
    if (n === 0) top = g.height;
    else if (n % 2 === 1) top = g.height + PIN.half + ((n - 1) / 2) * PIN.length; // top pin
    else top = g.height + (n / 2) * CUP.length; // top cup
    return top + 0.5;
  }

  goalLegal(_s: PlanState, gi: number, t: number): boolean {
    const g = this.goals[gi];
    const cfg = this.cfg;
    if (cfg.matchType === 'headToHead') {
      if (g.type === 'alliance' && g.allianceColor !== cfg.alliance) return false; // SG9
      if (g.type === 'midfield' && this.isEndgame(t)) return false; // SG12
      if (this.isAutonomous(t) && g.type !== 'midfield' && sideOf(g.pos) !== cfg.alliance) return false; // SG7
    }
    return true;
  }

  private canHold(s: PlanState, kind: ObjKind): boolean {
    const cap = this.cfg.robot.intake.capacity;
    if (cap === 'single') return s.heldPin < 0 && s.heldCup < 0;
    return kind === 'pin' ? s.heldPin < 0 : s.heldCup < 0;
  }

  legalActions(s: PlanState): Action[] {
    const out: Action[] = [];
    if (s.parked) return out;
    const auto = this.isAutonomous(s.t);
    const K = this.cfg.candidateK;
    const hp = this.holderPoint(s.pos, s.heading);
    for (const kind of ['pin', 'cup'] as ObjKind[]) {
      if (!this.canHold(s, kind)) continue;
      // field objects, nearest first
      const cands: { i: number; d: number }[] = [];
      for (const o of this.objs) {
        if (o.kind !== kind || s.status[o.idx] !== ST_FIELD || !o.startPos) continue;
        if (auto && this.cfg.matchType === 'headToHead' && sideOf(o.startPos) !== this.cfg.alliance && !(Math.abs(o.startPos.x) < MIDFIELD_INNER_HALF && Math.abs(o.startPos.y) < MIDFIELD_INNER_HALF)) continue;
        cands.push({ i: o.idx, d: dist(hp, o.startPos) });
      }
      cands.sort((a, b) => a.d - b.d || a.i - b.i);
      for (const c of cands.slice(0, K)) out.push({ type: 'pick', obj: c.i });
      // match loads
      const mlAllowed = !auto || this.cfg.params.matchLoads.allowedInAutonomous;
      if (mlAllowed) {
        const seenTypes = new Set<string>();
        for (const o of this.objs) {
          if (o.kind !== kind || s.status[o.idx] !== ST_MATCHLOAD) continue;
          const key = o.pinType ?? 'cup';
          if (seenTypes.has(key)) continue;
          seenTypes.add(key);
          this.loaders.forEach((l, li) => {
            if (this.cfg.matchType === 'headToHead' && l.alliance !== this.cfg.alliance) return;
            out.push({ type: 'load', obj: o.idx, loader: li });
          });
        }
      }
    }
    // placements
    const held: [number, ObjKind][] = [];
    if (s.heldPin >= 0) held.push([s.heldPin, 'pin']);
    if (s.heldCup >= 0) held.push([s.heldCup, 'cup']);
    for (const [oi, kind] of held) {
      const o = this.objs[oi];
      for (let gi = 0; gi < this.goals.length; gi++) {
        if (this.nextKind(s, gi) !== kind) continue;
        if (!this.goalLegal(s, gi, s.t)) continue;
        const bits = kind === 'pin' && o.colors![0] === o.colors![1] ? [0] : [0, 1];
        for (const bit of bits) {
          if (!this.cfg.robot.intake.canReorient && bit !== this.naturalBit(s, oi)) continue;
          out.push({ type: 'place', goal: gi, bit });
        }
      }
    }
    // toggles
    for (let ti = 0; ti < this.toggles.length; ti++) {
      const want: TogglePosition = this.toggleTarget();
      if (s.toggles[ti] === want) continue;
      const tg = this.toggles[ti];
      if (auto && this.cfg.matchType === 'headToHead' && !tg.quadrant.startsWith(this.cfg.alliance === 'red' ? 'R' : 'B')) continue;
      out.push({ type: 'toggle', toggle: ti });
    }
    if (this.cfg.allowPark && !auto && !s.parked) out.push({ type: 'park' });
    if (auto && this.cfg.tEnd > this.clock.autonomousEnd!) out.push({ type: 'wait', until: this.clock.autonomousEnd! });
    return out;
  }

  toggleTarget(): TogglePosition {
    if (this.cfg.matchType !== 'headToHead') return this.cfg.params.skills.ownedToggleColor;
    return this.cfg.alliance;
  }

  /** Orientation bit that results from placing without reorienting. */
  naturalBit(s: PlanState, oi: number): number {
    const o = this.objs[oi];
    if (o.kind === 'pin') return 1 - s.up[oi]; // the color facing down = the one not up
    return s.up[oi] === 1 ? 0 : 1; // gray up → grayDown = 0
  }

  actionLabel(a: Action, s?: PlanState): string {
    switch (a.type) {
      case 'pick':
        return `Pick ${this.objs[a.obj].id}`;
      case 'load':
        return `Load ${this.objs[a.obj].kind === 'pin' ? this.objs[a.obj].pinType + ' Pin' : 'Cup'} at ${this.loaders[a.loader].id}`;
      case 'place': {
        if (s) {
          const oi = this.nextKind(s, a.goal) === 'pin' ? s.heldPin : s.heldCup;
          if (oi >= 0) return `Place ${this.objs[oi].id} on ${this.goals[a.goal].id} (${this.orientLabel(oi, a.bit)})`;
        }
        return `Place on ${this.goals[a.goal].id}`;
      }
      case 'toggle':
        return `Set ${this.toggles[a.toggle].id} → ${this.toggleTarget()}`;
      case 'park':
        return 'Park in Midfield';
      case 'wait':
        return `Wait until ${a.until.toFixed(1)} s`;
    }
  }

  /**
   * Apply an action. Returns null if infeasible (no path, would exceed the period,
   * illegal, lift cannot reach). The returned StepInfo explains the time cost.
   */
  apply(s0: PlanState, a: Action, detailed = false): { s: PlanState; step: StepInfo } | null {
    const cfg = this.cfg;
    const R = cfg.robot;
    const p = this.perf;
    const tEndPeriod = this.periodEnd(s0.t);
    const valueBefore = detailed ? this.value(s0) : 0;
    const s = this.clone(s0);
    s.depth++;
    const notes: string[] = [];
    let travelTime = 0;
    let travelDist = 0;
    let turnT = 0;
    let liftT = 0;
    let mechT = 0;
    let waitT = 0;
    let path: Vec2[] = [];
    let risk = 0;
    let label = this.actionLabel(a);

    const moveTo = (target: Vec2, key: string, except: PoseExcept, liftTarget: number, onlyHeading?: number) => {
      const aps = this.approaches(target, key, except, onlyHeading);
      let best: { ap: { pre: Vec2; center: Vec2; heading: number }; tr: { time: number; dist: number; turn: number; path: Vec2[] }; total: number } | null = null;
      // When detailed, only refine the best fast-mode candidate (consistent choice).
      // Consider the approach headings closest to the direct line first (cheap prefilter).
      const direct = Math.atan2(target.y - s.pos.y, target.x - s.pos.x);
      const near = aps
        .map((ap) => ({ ap, dh: Math.abs(wrapAngle(ap.heading - direct)) }))
        .sort((x, y) => x.dh - y.dh)
        .slice(0, 5)
        .map((x) => x.ap);
      const scored = near
        .map((ap) => ({ ap, tr: this.travel(s, ap, false) }))
        .filter((x) => x.tr !== null) as { ap: { pre: Vec2; center: Vec2; heading: number }; tr: { time: number; dist: number; turn: number; path: Vec2[] } }[];
      for (const c of scored) {
        const lt = liftTime(p, s.holderH, liftTarget);
        const total = Math.max(c.tr.time - APPROACH / Math.max(p.vCruise, 1), lt) + APPROACH / Math.max(p.vCruise * 0.6, 1);
        if (!best || total < best.total) best = { ...c, total };
      }
      if (!best) return false;
      if (detailed) {
        const tr = this.travel(s, best.ap, true);
        if (!tr) return false;
        best.tr = tr;
      }
      const lt = liftTime(p, s.holderH, liftTarget);
      // lift runs during travel; the straight-in must start with the lift at height
      const preTime = best.tr.time - APPROACH / Math.max(p.vCruise, 1);
      travelTime = Math.max(preTime, lt) + APPROACH / Math.max(p.vCruise * 0.6, 1);
      if (lt > preTime) notes.push(`waited ${(lt - preTime).toFixed(2)} s for the lift`);
      liftT = lt;
      travelDist = best.tr.dist;
      turnT = best.tr.turn;
      path = best.tr.path;
      s.pos = { ...best.ap.center };
      s.heading = best.ap.heading;
      s.holderH = liftTarget;
      return true;
    };

    const minH = R.rack.holderMinHeightIn;
    switch (a.type) {
      case 'pick': {
        const o = this.objs[a.obj];
        if (s.status[a.obj] !== ST_FIELD || !o.startPos || !this.canHold(s, o.kind)) return null;
        if (!moveTo(o.startPos, `o${a.obj}`, {}, minH)) return null;
        mechT = R.intake.intakeTimeSec + (R.intake.capacity === 'pinAndCup' && (s.heldPin >= 0 || s.heldCup >= 0) ? R.intake.indexTimeSec : 0);
        s.status[a.obj] = ST_HELD;
        if (o.kind === 'pin') s.heldPin = a.obj;
        else s.heldCup = a.obj;
        risk = 0.02;
        break;
      }
      case 'load': {
        const o = this.objs[a.obj];
        const l = this.loaders[a.loader];
        if (s.status[a.obj] !== ST_MATCHLOAD || !this.canHold(s, o.kind)) return null;
        if (this.isAutonomous(s.t) && !cfg.params.matchLoads.allowedInAutonomous) return null;
        const lh = Math.atan2(-l.outward.y, -l.outward.x);
        if (!moveTo(l.dispense, `l${a.loader}`, { loader: l.id }, minH, lh)) return null;
        const arrive = s0.t + travelTime;
        // The Drive Team can introduce the next Match Load while the robot travels;
        // never before Driver Control unless loading in Autonomous is allowed.
        const earliest = cfg.matchType === 'headToHead' && !cfg.params.matchLoads.allowedInAutonomous ? (this.clock.autonomousEnd ?? 0) : cfg.tStart;
        const ready = Math.max(s.loaderFreeAt[a.loader], earliest) + cfg.params.matchLoads.humanLoadSec;
        waitT = Math.max(0, ready - arrive);
        mechT = R.intake.intakeTimeSec + (R.intake.capacity === 'pinAndCup' && (s.heldPin >= 0 || s.heldCup >= 0) ? R.intake.indexTimeSec : 0);
        s.status[a.obj] = ST_HELD;
        s.up[a.obj] = 1; // drive team loads it with the preferred side up (default yellow / gray up)
        if (o.kind === 'pin') s.heldPin = a.obj;
        else s.heldCup = a.obj;
        risk = 0.03;
        break;
      }
      case 'place': {
        const g = this.goals[a.goal];
        const kind = this.nextKind(s, a.goal);
        const oi = kind === 'pin' ? s.heldPin : s.heldCup;
        if (oi < 0) return null;
        if (!this.goalLegal(s, a.goal, s.t)) return null;
        const req = this.requiredHolder(s, a.goal);
        const limit = this.isEndgame(s.t) ? this.legalHolder.end : this.legalHolder.pre;
        if (req > this.maxHolder) {
          notes.push(`lift cannot reach ${req.toFixed(1)}"`);
          return null;
        }
        if (req > limit) return null;
        if (robotTopHeight(R, req) > cfg.params.robot.verticalMaxIn && !(this.isEndgame(s.t) && !cfg.params.robot.verticalLimitAppliesInEndgame)) return null;
        if (!moveTo(g.pos, `g${a.goal}`, { goal: g.id }, req)) return null;
        const reorient = a.bit !== this.naturalBit(s, oi);
        if (reorient && !R.intake.canReorient) return null;
        mechT = R.intake.releaseTimeSec + (reorient ? R.intake.reorientTimeSec : 0);
        if (R.intake.capacity === 'pinAndCup' && s.heldPin >= 0 && s.heldCup >= 0) mechT += R.intake.indexTimeSec;
        s.stacks[a.goal].push(oi * 2 + a.bit);
        s.status[oi] = ST_PLACED;
        if (kind === 'pin') s.heldPin = -1;
        else s.heldCup = -1;
        // Funnel tolerance vs positioning error → miss probability (Gaussian radial error).
        const tol = R.intake.placeToleranceIn + (kind === 'cup' ? 0.4 : 0);
        const sig = cfg.positionSigma;
        risk = sig > 0 ? Math.exp(-(tol * tol) / (2 * sig * sig)) : 0;
        label = `Place ${this.objs[oi].id} on ${g.id} (${this.orientLabel(oi, a.bit)})`;
        break;
      }
      case 'toggle': {
        const tg = this.toggles[a.toggle];
        const want = this.toggleTarget();
        if (s.toggles[a.toggle] === want) return null;
        // face the wall at the toggle: robot front ~1" off the perimeter
        const target = add(tg.pos, scale(tg.normal, R.chassis.lengthIn / 2 + R.toggleArm.reachIn - R.intake.holderOffsetIn));
        const th = Math.atan2(-tg.normal.y, -tg.normal.x);
        if (!moveTo(target, `t${a.toggle}`, { toggle: tg.id }, s.holderH, th)) return null;
        mechT = R.toggleArm.actuateTimeSec + straightTime(p, 4); // actuate + back off (SC4 no contact)
        s.pos = sub(s.pos, fromAngle(s.heading, 4));
        s.toggles[a.toggle] = want;
        risk = 0.05;
        break;
      }
      case 'park': {
        if (this.isAutonomous(s.t)) return null;
        // nearest pose overlapping the Midfield by ~3", facing the center
        const L = R.chassis.lengthIn;
        const cands: { pos: Vec2; heading: number }[] = [];
        for (let k = 0; k < 8; k++) {
          const h = (k / 8) * 2 * Math.PI;
          const pos = fromAngle(h + Math.PI, MIDFIELD_INNER_HALF + L / 2 - 3);
          if (this.poseClear(pos, h)) cands.push({ pos, heading: h });
        }
        let bestT = Infinity;
        let bestC: { pos: Vec2; heading: number } | null = null;
        let bestPath: Vec2[] = [];
        let bestD = 0;
        for (const c of cands) {
          const ap = { pre: c.pos, center: c.pos, heading: c.heading };
          const tr = this.travel(s, ap, detailed);
          if (!tr) continue;
          if (tr.time < bestT) {
            bestT = tr.time;
            bestC = c;
            bestPath = tr.path;
            bestD = tr.dist;
          }
        }
        if (!bestC) return null;
        travelTime = bestT;
        travelDist = bestD;
        path = bestPath;
        s.pos = bestC.pos;
        s.heading = bestC.heading;
        if (!footprintInMidfield(s.pos, s.heading, R.chassis.lengthIn, R.chassis.widthIn)) return null;
        s.parked = true;
        break;
      }
      case 'wait': {
        if (a.until <= s.t) return null;
        waitT = a.until - s.t;
        break;
      }
    }
    const dur = travelTime + mechT + waitT;
    const tEnd = s0.t + dur;
    if (tEnd > tEndPeriod + 1e-6) return null;
    if (a.type !== 'wait' && this.isAutonomous(s0.t) && tEnd > this.clock.autonomousEnd! + 1e-6) return null;
    // Driver-period placements on the Midfield Goal must finish before the Endgame (SG12).
    if (a.type === 'place' && this.goals[a.goal].type === 'midfield' && cfg.matchType === 'headToHead' && this.isEndgame(tEnd)) return null;
    this.advanceTo(s, tEnd);
    if (a.type === 'load') s.loaderFreeAt[a.loader] = tEnd;
    const step: StepInfo = {
      action: a,
      label,
      tStart: s0.t,
      tEnd,
      travelDist,
      travelTime,
      turnTime: turnT,
      liftTime: liftT,
      mechTime: mechT,
      waitTime: waitT,
      path,
      endPos: { ...s.pos },
      endHeading: s.heading,
      holderH: s.holderH,
      valueBefore,
      valueAfter: detailed ? this.value(s) : 0,
      risk,
      notes,
    };
    return { s, step };
  }

  orientLabel(oi: number, bit: number): string {
    const o = this.objs[oi];
    if (o.kind === 'pin') return `${o.colors![bit]} down`;
    return bit ? 'gray down' : 'gray up';
  }

  /** Finish the window: wait to the end (lets the Autonomous snapshot happen). */
  finalize(s: PlanState): PlanState {
    const f = this.clone(s);
    this.advanceTo(f, Math.max(f.t, this.cfg.tEnd));
    return f;
  }

  quadrantOfGoal(gi: number): QuadrantId | 'midfield' {
    const g = this.goals[gi];
    return g.type === 'midfield' ? 'midfield' : quadrantOf(g.pos);
  }
}
