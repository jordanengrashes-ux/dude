import { IN, wrapAngle } from '../core/units';
import type { Vec2 } from '../core/vec';
import { add, dist, distToSegment, fromAngle } from '../core/vec';
import { CUP, MIDFIELD_REACH, PIN } from '../field/geometry';
import { derivePerf, type DrivePerf } from '../robot/kinematics';
import { toggleAngle, togglePosition, toggleTargetAngle } from '../physics/field';
import { upOf } from '../physics/frames';
import type { SimObject } from '../physics/objects';
import { Grid } from '../planner/grid';
import { astar } from '../planner/astar';
import { PlanWorld, type Action, type Escape, type PlanConfig } from '../planner/model';
import { beamSearch } from '../planner/search/beam';
import { approach, backOff, DEFAULT_TUNING, driveStraight, pursue, turnTo, type DriveTuning, type PursuitState } from './drive';
import type { Controller, MatchSim, Sensing, SimRobot } from './match';

/**
 * Executes a planner action sequence on the physical robot, with model-predictive
 * replanning (MPC): when an action fails (object moved or taken, missed seat,
 * blocked path) or periodically, it rebuilds the planning model from the CURRENT
 * physical state and re-optimizes the remainder of the match.
 */

export interface MpcOptions {
  enabled: boolean;
  periodicSec: number;
  beamWidth: number;
  candidateK: number;
  maxExpansions: number;
}

export const DEFAULT_MPC: MpcOptions = { enabled: true, periodicSec: 0, beamWidth: 10, candidateK: 5, maxExpansions: 2500 };

type Phase = 'start' | 'escape' | 'route' | 'align' | 'approach' | 'index' | 'reorient' | 'release' | 'settle' | 'toggle' | 'backoff' | 'waitLoad' | 'wait' | 'parked' | 'done';

interface Active {
  action: Action;
  label: string;
  phase: Phase;
  t0: number;
  phaseT0: number;
  ps?: PursuitState;
  ap?: { pre: Vec2; center: Vec2; heading: number };
  objId?: string;
  goalId?: string;
  toggleId?: string;
  loaderId?: string;
  bit?: number;
  holderTarget: number;
  retries: number;
  backFrom?: Vec2;
  /** Straight-line escape from a tight spot before following the route. */
  esc?: Escape & { from?: Vec2; t1?: number };
  backHeading?: number;
  progress: { t: number; d: number };
  stuckCount: number;
  phaseTimes: Record<string, number>;
  /** Objects already held when the action started. */
  heldAtStart?: string[];
  /** Approach headings that failed (blocked by clutter); retries avoid them. */
  badHeadings: number[];
  /** When a robot started blocking the way (route phase). */
  blockedSince?: number;
  /** Waiting for another robot to clear the target spot (start phase). */
  waitUntil?: number;
  /** Toggle: spot along the bar being used, and spots that turned out out of reach. */
  toggleSpot?: number;
  /** A one-piece claw letting go of this piece before the pick / load (which then gets 2 s more). */
  dropId?: string;
  dropped?: boolean;
  /** More time for a long first drive (s). */
  extraTime?: number;
  badSpots?: number[];
}

export interface ActionRecord {
  label: string;
  tStart: number;
  tEnd: number;
  ok: boolean;
  reason?: string;
  /** Seconds spent in each execution phase. */
  phases: Record<string, number>;
}

export class PlanExecutor implements Controller {
  readonly kind = 'plan';
  world: PlanWorld;
  queue: Action[];
  cur: Active | null = null;
  perf: DrivePerf;
  history: ActionRecord[] = [];
  replans = 0;
  failures = 0;
  /** A substitution happened: the plan's object indices no longer match reality. */
  private substituted = false;
  /** Goals / objects recently failed on — excluded from replanning for a while. */
  private avoidGoals = new Map<string, number>();
  private avoidObjects = new Map<string, number>();
  private avoidToggles = new Map<string, number>();
  private avoidLoaders = new Map<string, number>();
  private lastReplan = 0;
  private tuning: DriveTuning;

  constructor(
    readonly base: PlanConfig,
    actions: Action[],
    readonly mpc: MpcOptions = DEFAULT_MPC,
    world?: PlanWorld,
    tuning?: DriveTuning,
  ) {
    this.world = world ?? new PlanWorld(base);
    this.queue = actions.slice();
    this.perf = derivePerf(base.robot, { cruiseFraction: base.cruiseFraction });
    this.tuning = { ...DEFAULT_TUNING, trackWidth: base.robot.drivetrain.trackWidthIn, ...tuning, cruiseFraction: base.cruiseFraction };
  }

  private trackWidth(r: SimRobot) {
    return r.cfg.drivetrain.trackWidthIn;
  }

  update(sim: MatchSim, r: SimRobot, sense: Sensing, _dt: number) {
    if (!this.cur) {
      if (this.mpc.enabled && this.mpc.periodicSec > 0 && sim.t - this.lastReplan > this.mpc.periodicSec && this.queue.length) this.replan(sim, r, 'periodic');
      let next = this.queue.shift();
      if (!next && this.mpc.enabled && sim.t < this.base.tEnd - 3 && sim.t - this.lastReplan > 5) {
        this.replan(sim, r, 'plan exhausted');
        next = this.queue.shift();
      }
      if (!next) {
        r.body.cmd = { left: 0, right: 0 };
        return;
      }
      if (this.opposingSideInAutonomous(sim, next)) {
        // physics ran ahead of the model's timing: hold until Driver Control (SG7)
        this.queue.unshift(next);
        r.body.cmd = { left: 0, right: 0 };
        return;
      }
      this.cur = { action: next, label: this.world.actionLabel(next), phase: 'start', t0: sim.t, phaseT0: sim.t, holderTarget: r.cfg.lift.holderMinHeightIn, retries: 0, progress: { t: sim.t, d: Infinity }, stuckCount: 0, phaseTimes: {}, heldAtStart: [r.primary?.id, r.secondary?.id].filter((x): x is string => !!x), badHeadings: [] };
      sim.log({ t: sim.t, type: 'action', robotId: r.id, text: `${r.id} ▶ ${this.cur.label}` });
    }
    const a = this.cur;
    const ok = this.stepAction(sim, r, sense, a);
    this.fence(sim, r, sense);
    if (ok === true) this.finish(sim, r, true);
    else if (typeof ok === 'string') this.finish(sim, r, false, ok);
  }

  /**
   * Virtual fence: never drive (or turn) into a pose that breaks SG7 in Autonomous
   * or enters the opposing Load Zones in Driver Control. Cuts the offending part of
   * the command; a robot already pushed inside may still drive out.
   */
  private fence(sim: MatchSim, r: SimRobot, sense: Sensing) {
    const w = this.world;
    if (w.cfg.matchType !== 'headToHead' || !w.poseAllowed(sense.pos, sense.heading, sim.t)) return;
    const { left, right } = r.body.cmd;
    let fwd = (left + right) / 2;
    let turn = (right - left) / 2;
    if (Math.abs(fwd) > 0.02 && !w.poseAllowed(add(sense.pos, fromAngle(sense.heading, 3 * Math.sign(fwd))), sense.heading, sim.t)) fwd = 0;
    if (Math.abs(turn) > 0.02 && !w.poseAllowed(sense.pos, sense.heading + 0.12 * Math.sign(turn), sim.t)) turn = 0;
    r.body.cmd = { left: fwd - turn, right: fwd + turn };
  }

  private opposingSideInAutonomous(sim: MatchSim, a: Action): boolean {
    const w = this.world;
    if (w.cfg.matchType !== 'headToHead' || !w.isAutonomous(sim.t)) return false;
    const own = w.cfg.alliance === 'red' ? 'R' : 'B';
    if (a.type === 'toggle') return !w.toggles[a.toggle].quadrant.startsWith(own);
    if (a.type === 'place') return w.goals[a.goal].type !== 'midfield' && !w.goals[a.goal].quadrant.startsWith(own);
    return false;
  }

  private setPhase(a: Active, p: Phase, t: number) {
    a.phaseTimes[a.phase] = (a.phaseTimes[a.phase] ?? 0) + (t - a.phaseT0);
    a.phase = p;
    a.phaseT0 = t;
  }

  private finish(sim: MatchSim, r: SimRobot, ok: boolean, reason?: string) {
    const a = this.cur!;
    a.phaseTimes[a.phase] = (a.phaseTimes[a.phase] ?? 0) + (sim.t - a.phaseT0);
    this.history.push({ label: a.label, tStart: a.t0, tEnd: sim.t, ok, reason, phases: a.phaseTimes });
    sim.log({ t: sim.t, type: ok ? 'action' : 'failure', robotId: r.id, text: `${r.id} ${ok ? '✓' : '✗'} ${a.label}${reason ? ` — ${reason}` : ''}` });
    this.cur = null;
    r.body.cmd = { left: 0, right: 0 };
    if (ok && this.substituted) {
      this.substituted = false;
      if (this.mpc.enabled) this.replan(sim, r, 'substituted object');
    }
    if (!ok) {
      this.failures++;
      if (a.goalId) this.avoidGoals.set(a.goalId, sim.t + 20);
      if (a.objId && (a.action.type === 'pick' || a.action.type === 'load')) this.avoidObjects.set(a.objId, sim.t + 20);
      if (a.toggleId) this.avoidToggles.set(a.toggleId, sim.t + 20);
      if (a.loaderId) this.avoidLoaders.set(a.loaderId, sim.t + 20);
      if (this.mpc.enabled) this.replan(sim, r, reason ?? 'failure');
    }
  }

  /** Take the robot back after a human drove it: drop the interrupted action and replan from here. */
  resume(sim: MatchSim, r: SimRobot, reason: string) {
    this.cur = null;
    r.body.liftManual = null;
    if (this.mpc.enabled) this.replan(sim, r, reason);
  }

  /** Re-optimize the rest of the window from the current physical state. */
  replan(sim: MatchSim, r: SimRobot, reason: string) {
    const pose = r.body.pose();
    const layout = sim.layoutNow(r);
    const cfg: Partial<PlanConfig> = {
      layout,
      tStart: sim.t,
      startPose: { pos: pose.pos, heading: pose.heading, holderH: r.body.holderHeight() },
      candidateK: this.mpc.candidateK,
      externalEvents: this.base.externalEvents.filter((e) => e.t > sim.t),
    };
    const now = sim.t;
    const avoidG = new Set([...this.avoidGoals].filter(([, until]) => until > now).map(([g]) => g));
    const avoidO = new Set([...this.avoidObjects].filter(([, until]) => until > now).map(([o]) => o));
    const baseGoal = this.base.goalFilter;
    const baseObj = this.base.objectFilter;
    if (avoidG.size) cfg.goalFilter = (g) => !avoidG.has(g.id) && (!baseGoal || baseGoal(g));
    if (avoidO.size) cfg.objectFilter = (o) => !avoidO.has(o.id) && (!baseObj || baseObj(o));
    const avoidT = [...this.avoidToggles].filter(([, until]) => until > now).map(([id]) => id);
    cfg.blockedToggles = [...(this.base.blockedToggles ?? []), ...avoidT];
    const avoidL = [...this.avoidLoaders].filter(([, until]) => until > now).map(([id]) => id);
    if (avoidL.length) cfg.blockedLoaders = [...(this.base.blockedLoaders ?? []), ...avoidL];
    const w = this.world.fork({ config: cfg });
    const res = beamSearch(w, { width: this.mpc.beamWidth, alpha: 0.3 }, { maxMs: Infinity, maxExpansions: this.mpc.maxExpansions });
    this.world = w;
    this.queue = res.best.actions.slice();
    this.replans++;
    this.lastReplan = sim.t;
    sim.log({ t: sim.t, type: 'replan', robotId: r.id, text: `${r.id} replans (${reason}): ${this.queue.length} actions, value ${res.best.value}` });
  }

  private chooseApproach(sim: MatchSim, r: SimRobot, sense: Sensing, target: Vec2, key: string, except: { goal?: string; loader?: string; toggle?: string }, onlyHeading?: number, avoid: number[] = []) {
    // legal approaches only (SG7 / Load Zones), as the model plans them: a pickup reaches 3" past its stop
    const reach = key.startsWith('dyn-') ? 3 : 0;
    const aps = this.world
      .approaches(target, key, except, onlyHeading)
      .filter((ap) => !avoid.some((h) => Math.abs(wrapAngle(ap.heading - h)) < Math.PI / 4))
      .filter((ap) => this.world.poseAllowed(ap.center, ap.heading, sim.t) && (!reach || this.world.poseAllowed(add(ap.center, fromAngle(ap.heading, reach)), ap.heading, sim.t)));
    const grid = this.world.gridAt(sim.t);
    const vg = this.world.visGraph(grid);
    let best: { ap: (typeof aps)[number]; path: Vec2[]; cost: number; esc: Escape | null } | null = null;
    const { esc, start, lead } = this.routeStart(grid, sense);
    const others = this.otherRobots(sim, r);
    let robotGrid: Grid | null = null;
    let pieceGrid: Grid | null = null;
    let pieces: { pos: Vec2; r: number }[] | null = null;
    this.robotInTheWay = false;
    for (const ap of aps) {
      // another robot is standing where this approach ends
      if (others.some((o) => dist(o.pos, ap.center) < o.r + this.world.clearance - 2 || dist(o.pos, ap.pre) < o.r + this.world.clearance - 2)) {
        this.robotInTheWay = true;
        continue;
      }
      let path = grid.segmentClear(start, ap.pre) ? [start, ap.pre] : vg.path(start, grid.pointBlocked(ap.pre) ? grid.nearestFree(ap.pre) ?? ap.pre : ap.pre);
      if (!path) continue;
      let penalty = 0;
      if (others.some((o) => this.blocksPath(o, path!))) {
        // detour around the robots in the way (grid A* with them stamped in)
        robotGrid ??= new Grid({ ...grid.opts, extraObstacles: others.map((o) => ({ pos: o.pos, r: o.r })) });
        const alt = astar(robotGrid, start, ap.pre);
        if (alt) path = [start, ...alt.points.slice(1)];
        else penalty = 3; // no way around now: it may clear by the time we get there
      }
      // loose Pins and Cups: drive around them rather than plow them along (or knock them over)
      pieces ??= this.loosePieces(sim, target);
      if (pieces.some((o) => this.blocksPath({ pos: o.pos, r: o.r - 1.5 }, path!))) {
        pieceGrid ??= new Grid({ ...grid.opts, extraObstacles: [...others.map((o) => ({ pos: o.pos, r: o.r })), ...pieces] });
        const alt = pieceGrid.pointBlocked(ap.pre) ? null : astar(pieceGrid, start, ap.pre);
        if (alt) path = [start, ...alt.points.slice(1)];
        else penalty += 1;
      }
      path = [...lead, ...path];
      let len = 0;
      for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
      const turn = Math.abs(wrapAngle(ap.heading - Math.atan2(ap.pre.y - path[Math.max(0, path.length - 2)].y, ap.pre.x - path[Math.max(0, path.length - 2)].x)));
      const cost = len / this.perf.vCruise + turn * 0.25 + penalty;
      if (!best || cost < best.cost) best = { ap, path, cost, esc };
    }
    return best;
  }

  /** Set by chooseApproach: some approach was ruled out only because a robot stands there. */
  private robotInTheWay = false;

  /** No approach now: wait a little if another robot is in the way, else fail. */
  private noApproach(r: SimRobot, a: Active, t: number, reason: string): string | undefined {
    if (this.robotInTheWay && t - a.t0 < 2.5) {
      r.body.cmd = { left: 0, right: 0 };
      a.waitUntil = t + 0.3;
      return undefined;
    }
    return reason;
  }

  /** Loose pieces on the tiles as circles (a lying piece reaches half its length), except those at `target`. */
  private loosePieces(sim: MatchSim, target: Vec2): { pos: Vec2; r: number }[] {
    const out: { pos: Vec2; r: number }[] = [];
    for (const o of sim.objects.objects.values()) {
      if (o.mode !== 'free' || !o.body) continue;
      const t = o.body.translation();
      const pos = { x: t.x / IN, y: -t.z / IN };
      if (t.y / IN > 9 || dist(pos, target) < 3) continue;
      const lying = Math.abs(upOf(o.body.rotation()).y) < 0.7;
      out.push({ pos, r: lying ? (o.kind === 'pin' ? PIN.half : CUP.half) : (o.kind === 'pin' ? PIN.diameter : CUP.diameter) / 2 });
    }
    return out;
  }

  /** The other robots as circles (center, radius of their footprint). */
  private otherRobots(sim: MatchSim, r: SimRobot): { id: string; pos: Vec2; r: number }[] {
    const out: { id: string; pos: Vec2; r: number }[] = [];
    for (const o of sim.robots) {
      if (o === r) continue;
      out.push({ id: o.id, pos: o.body.pose().pos, r: Math.max(o.cfg.chassis.lengthIn, o.cfg.chassis.widthIn) / 2 });
    }
    return out;
  }

  /** Does robot `o` sit on this path (closer to a segment than our clearance + its radius)? */
  private blocksPath(o: { pos: Vec2; r: number }, path: Vec2[]): boolean {
    const R = o.r + this.world.clearance - 1;
    // a robot we are already touching only counts if the path heads into it
    const d0 = dist(o.pos, path[0]);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (d0 < R && i === 1) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const into = (o.pos.x - a.x) * dx + (o.pos.y - a.y) * dy > 0.5 * Math.hypot(dx, dy) * d0;
        if (into) return true;
        continue;
      }
      if (distToSegment(o.pos, a, b) < R) return true;
    }
    return false;
  }

  /**
   * Another robot directly in front of the direction of travel: returns how close
   * (0 = touching, 1 = at the edge of the look-ahead), or null when the way is clear.
   */
  private robotAhead(sim: MatchSim, r: SimRobot, sense: Sensing, dir: 1 | -1): { id: string; closeness: number } | null {
    const fx = Math.cos(sense.heading) * dir;
    const fy = Math.sin(sense.heading) * dir;
    let best: { id: string; closeness: number } | null = null;
    for (const o of this.otherRobots(sim, r)) {
      const dx = o.pos.x - sense.pos.x;
      const dy = o.pos.y - sense.pos.y;
      const along = dx * fx + dy * fy;
      const lat = Math.abs(dx * fy - dy * fx);
      const contact = o.r + r.cfg.chassis.lengthIn / 2;
      if (along <= 0 || lat > o.r + r.cfg.chassis.widthIn / 2 - 1) continue;
      const look = contact + 10;
      if (along > look) continue;
      const c = Math.max(0, (along - contact) / (look - contact));
      if (!best || c < best.closeness) best = { id: o.id, closeness: c };
    }
    return best;
  }

  /**
   * Where a route starts: the robot's position, the end of the model's straight
   * escape when it sits inside an inflated obstacle region, or — pinned where no
   * straight escape exists (e.g. pushed against a wall) — the nearest free point,
   * driven to first (`lead`). The planning model costs the same three cases.
   */
  private routeStart(grid: Grid, sense: Sensing): { esc: Escape | null; start: Vec2; lead: Vec2[] } {
    const esc = this.escapeFrom(grid, sense);
    if (esc) return { esc, start: esc.pt, lead: [] };
    if (grid.pointBlocked(sense.pos)) {
      const free = grid.nearestFree(sense.pos);
      if (free) return { esc: null, start: free, lead: [sense.pos] };
    }
    return { esc: null, start: sense.pos, lead: [] };
  }

  /** The model's straight-line escape when the robot starts inside an inflated obstacle region. */
  private escapeFrom(grid: Grid, sense: Sensing): Escape | null {
    return grid.pointBlocked(sense.pos) ? this.world.escape(grid, sense.pos, sense.heading) : null;
  }

  /** Enter the route phase, escaping first when the route starts from a tight spot. */
  private beginRoute(a: Active, t: number, esc: Active['esc']) {
    // a long drive shouldn't use up the time the robot has to do the job at the end of it
    if (a.ps && a.extraTime === undefined) {
      let len = 0;
      for (let i = 1; i < a.ps.path.length; i++) len += dist(a.ps.path[i - 1], a.ps.path[i]);
      a.extraTime = Math.min(4, Math.max(0, len / Math.max(0.5 * this.perf.vCruise, 1) - 2)); // turns and speed-ups: about half cruise on average
    }
    this.setPhase(a, esc ? 'escape' : 'route', t);
  }

  private heldOfKind(r: SimRobot, kind: 'pin' | 'cup'): SimObject | null {
    if (r.primary?.kind === kind) return r.primary;
    if (r.secondary?.kind === kind) return r.secondary;
    return null;
  }

  /** Returns true when done, a string on failure, undefined while in progress. */
  private stepAction(sim: MatchSim, r: SimRobot, sense: Sensing, a: Active): true | string | undefined {
    const act = a.action;
    const tw = this.trackWidth(r);
    const cfg = r.cfg;
    const t = sim.t;
    r.body.liftTarget = a.holderTarget;
    if (t - a.t0 > 9 + (a.dropped ? 2 : 0) + (a.extraTime ?? 0) && act.type !== 'wait' && a.phase !== 'parked') return 'timed out';
    switch (a.phase) {
      case 'start': {
        if (a.waitUntil !== undefined && t < a.waitUntil) {
          r.body.cmd = { left: 0, right: 0 };
          return undefined;
        }
        if (act.type === 'wait') {
          this.setPhase(a, 'wait', t);
          return undefined;
        }
        if ((act.type === 'pick' || act.type === 'load') && cfg.intake.capacity === 'single' && r.primary) {
          // a one-piece claw lets go of what it holds first (the plan gave up on placing it)
          a.dropId = r.primary.id;
          a.dropped = true;
          a.holderTarget = cfg.lift.holderMinHeightIn;
          this.setPhase(a, 'release', t);
          return undefined;
        }
        if (act.type === 'pick') {
          const id = this.world.objs[act.obj].id;
          const obj = sim.objects.objects.get(id);
          if (!obj || obj.mode !== 'free' || !obj.body) return `${id} is no longer available`;
          const p = obj.body.translation();
          const target = { x: p.x / IN, y: -p.z / IN };
          a.objId = id;
          a.holderTarget = cfg.lift.holderMinHeightIn;
          const ch = this.chooseApproach(sim, r, sense, target, `dyn-${id}`, {}, undefined, a.badHeadings);
          if (!ch) return this.noApproach(r, a, t, 'no approach to object');
          a.ap = ch.ap;
          a.ps = { path: ch.path, seg: 0 };
          a.esc = ch.esc ? { ...ch.esc } : undefined;
        } else if (act.type === 'load') {
          const id = this.world.objs[act.obj].id;
          const l = this.world.loaders[act.loader];
          a.objId = id;
          a.loaderId = l.id;
          a.holderTarget = cfg.lift.holderMinHeightIn;
          const h = Math.atan2(-l.outward.y, -l.outward.x);
          const ch = this.chooseApproach(sim, r, sense, l.dispense, `L-${l.id}`, { loader: l.id }, h);
          if (!ch) return this.noApproach(r, a, t, 'no approach to loader');
          a.ap = ch.ap;
          a.ps = { path: ch.path, seg: 0 };
          a.esc = ch.esc ? { ...ch.esc } : undefined;
        } else if (act.type === 'place') {
          const g = this.world.goals[act.goal];
          const st = sim.objects.stacks.get(g.id)!;
          const kind = sim.objects.nextKind(st);
          const obj = this.heldOfKind(r, kind);
          if (!obj || st.pending) {
            // The plan has another robot place on this Goal first (e.g. the partner,
            // running a little late): wait for it rather than give up the Goal.
            const gi = this.world.allGoals.findIndex((x) => x.id === g.id);
            const expected = this.base.externalEvents.some((e) => e.kind === 'place' && e.goal === gi && e.t > a.t0 - 2 && e.t < t + 4);
            if (expected && t - a.t0 < 4) {
              r.body.cmd = { left: 0, right: 0 };
              a.waitUntil = t + 0.25;
              return undefined;
            }
            return obj ? `${g.id} busy` : `not holding a ${kind} for ${g.id}`;
          }
          a.goalId = g.id;
          a.objId = obj.id;
          a.bit = act.bit;
          a.holderTarget = Math.min(this.world.maxHolder, sim.objects.topHeight(st) + 0.9);
          const ch = this.chooseApproach(sim, r, sense, g.pos, `G-${g.id}-${st.elements.length}`, { goal: g.id }, undefined, a.badHeadings);
          if (!ch) return this.noApproach(r, a, t, a.badHeadings.length ? 'every approach to the goal is blocked' : 'no approach to goal');
          a.ap = ch.ap;
          a.ps = { path: ch.path, seg: 0 };
          a.esc = ch.esc ? { ...ch.esc } : undefined;
        } else if (act.type === 'toggle') {
          const tg = this.world.toggles[act.toggle];
          a.toggleId = tg.id;
          const h = Math.atan2(-tg.normal.y, -tg.normal.x);
          let ch: ReturnType<typeof this.chooseApproach> = null;
          const spots = this.world.toggleTargets(act.toggle);
          for (let i = 0; i < spots.length; i++) {
            if (a.badSpots?.includes(i)) continue;
            const c = this.chooseApproach(sim, r, sense, spots[i], `T-${tg.id}`, { toggle: tg.id }, h);
            if (c && (!ch || c.cost < ch.cost)) {
              ch = c;
              a.toggleSpot = i;
            }
          }
          if (!ch) return this.noApproach(r, a, t, a.badSpots?.length ? 'pieces block the Toggle' : 'no approach to toggle');
          a.ap = ch.ap;
          a.ps = { path: ch.path, seg: 0 };
          a.esc = ch.esc ? { ...ch.esc } : undefined;
        } else if (act.type === 'park') {
          const L = cfg.chassis.lengthIn;
          let best: { path: Vec2[]; pos: Vec2; heading: number; len: number } | null = null;
          const grid = this.world.gridAt(t);
          const vg = this.world.visGraph(grid);
          const { esc, start, lead } = this.routeStart(grid, sense);
          const others = this.otherRobots(sim, r);
          let robotGrid: Grid | null = null;
          for (let k = 0; k < 8; k++) {
            const h = (k / 8) * 2 * Math.PI;
            const edge = MIDFIELD_REACH / (Math.abs(Math.cos(h)) + Math.abs(Math.sin(h)));
            const pos = fromAngle(h + Math.PI, edge + L / 2 - 4);
            if (!this.world.poseClear(pos, h)) continue;
            if (others.some((o) => dist(o.pos, pos) < o.r + this.world.clearance - 2)) continue; // spot taken
            let path = grid.segmentClear(start, pos) ? [start, pos] : vg.path(start, pos);
            if (path && others.some((o) => this.blocksPath(o, path!))) {
              robotGrid ??= new Grid({ ...grid.opts, extraObstacles: others.map((o) => ({ pos: o.pos, r: o.r })) });
              const alt = astar(robotGrid, start, pos);
              if (alt) path = [start, ...alt.points.slice(1)];
            }
            if (!path) continue;
            path = [...lead, ...path];
            let len = 0;
            for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
            if (!best || len < best.len) best = { path, pos, heading: h, len };
          }
          if (!best) return this.noApproach(r, a, t, 'no route to the Midfield');
          a.ap = { pre: best.pos, center: best.pos, heading: best.heading };
          a.ps = { path: best.path, seg: 0 };
          a.esc = esc ? { ...esc } : undefined;
        }
        a.progress = { t, d: Infinity };
        this.beginRoute(a, t, a.esc);
        return undefined;
      }
      case 'escape': {
        // Turn in place if needed, then drive straight out (forward or reverse), as the model assumes.
        const e = a.esc!;
        if (!e.from) {
          const turn = turnTo(this.perf, sense, e.heading, this.tuning, 0.06);
          r.body.cmd = { left: turn.left, right: turn.right };
          if (turn.done || e.rot < 0.06 || t - a.phaseT0 > 1.5) {
            e.from = sense.pos;
            e.t1 = t;
          }
          return undefined;
        }
        const out = driveStraight(this.perf, sense, e.from, e.dist, e.heading, e.reverse ? -1 : 1, tw, this.tuning);
        r.body.cmd = { left: out.left, right: out.right };
        // pinned (pieces or a wall in the way): don't push for the full 3 s, go on with the route
        const pinned = t - (e.t1 ?? a.phaseT0) > 0.6 && dist(sense.pos, e.from) < 1 && Math.abs(sense.speed) < 2;
        if (out.done || pinned || t - a.phaseT0 > 3) {
          a.progress = { t, d: Infinity };
          this.setPhase(a, 'route', t);
        }
        return undefined;
      }
      case 'route': {
        if (act.type === 'load' && a.objId) r.req.matchLoad = { loaderId: a.loaderId!, objectId: a.objId };
        if (act.type === 'pick' && a.objId) {
          const obj = sim.objects.objects.get(a.objId);
          if (!obj || obj.mode !== 'free') return `${a.objId} was taken or moved`;
        }
        if (this.intakeEarly(r, sense, a, t)) return undefined;
        const out = pursue(this.perf, sense, a.ps!, tw, this.tuning, act.type === 'park' ? 1.5 : 2.0);
        r.body.cmd = { left: out.left, right: out.right };
        // Yield to a robot in the way: slow down, stop short of it, and re-route if it
        // stays there. The robot whose id sorts first re-routes sooner, so two robots
        // meeting head-on don't both swerve the same way.
        // Only the forward part slows: the robot can still turn away from it.
        const fwd = (out.left + out.right) / 2;
        const ahead = Math.abs(fwd) > 0.05 ? this.robotAhead(sim, r, sense, fwd >= 0 ? 1 : -1) : null;
        if (ahead) {
          const k = ahead.closeness < 0.15 ? 0 : 0.35 + 0.65 * ahead.closeness;
          const turn = (out.right - out.left) / 2;
          r.body.cmd = { left: fwd * k - turn, right: fwd * k + turn };
          a.blockedSince ??= t;
          a.progress.t = t; // waiting for a robot is not being stuck
          if (t - a.blockedSince > (r.id < ahead.id ? 0.6 : 1.3)) {
            a.blockedSince = undefined;
            a.stuckCount++;
            sim.log({ t, type: 'collision', robotId: r.id, text: `${r.id} yields to ${ahead.id} — re-routing (${a.stuckCount})` });
            if (a.stuckCount > 4) return `blocked by ${ahead.id}`;
            if (fwd > 0) {
              // back away to make room, then re-route around it
              a.backFrom = sense.pos;
              a.backHeading = sense.heading;
              this.setPhase(a, 'backoff', t);
            } else this.setPhase(a, 'start', t);
          }
          return undefined;
        }
        a.blockedSince = undefined;
        // stuck detection → reroute around other robots
        const dGoal = dist(sense.pos, a.ps!.path[a.ps!.path.length - 1]);
        if (dGoal < a.progress.d - 2) a.progress = { t, d: dGoal };
        else if (t - a.progress.t > 1.6) {
          // Stuck (another robot, or a loose object wedged against the chassis):
          // reverse out first, then re-plan the approach from a different side.
          a.stuckCount++;
          a.progress = { t, d: dGoal };
          sim.log({ t, type: 'collision', robotId: r.id, text: `${r.id} blocked — backing out (${a.stuckCount})` });
          if (a.stuckCount > 3) return 'blocked';
          if (a.ap) a.badHeadings.push(a.ap.heading);
          a.backFrom = sense.pos;
          a.backHeading = sense.heading;
          this.setPhase(a, 'backoff', t);
          return undefined;
        }
        if (out.done) {
          if (act.type === 'park') {
            this.setPhase(a, 'parked', t);
            return undefined;
          }
          this.setPhase(a, 'align', t);
        }
        return undefined;
      }
      case 'align': {
        if (this.intakeEarly(r, sense, a, t)) return undefined;
        const aimAt = this.aimPoint(sim, a);
        const aimHeading = aimAt && act.type !== 'toggle' ? Math.atan2(aimAt.y - sense.pos.y, aimAt.x - sense.pos.x) : a.ap!.heading;
        const out = turnTo(this.perf, sense, aimHeading, this.tuning, 0.05);
        r.body.cmd = { left: out.left, right: out.right };
        if (act.type === 'place') {
          const obj = sim.objects.objects.get(a.objId!);
          if (!obj) return 'object lost';
          if (obj.pocket === 'secondary' && t >= r.busyUntil) {
            r.req.index = true;
            return undefined;
          }
          if (this.needsReorient(obj, a.bit!) && t >= r.busyUntil && obj.pocket === 'primary') {
            if (!cfg.intake.canReorient) return 'cannot reorient';
            r.req.reorient = true;
            return undefined;
          }
          const lifted = sense.holderHeight >= a.holderTarget - 0.5;
          if (out.done && lifted && t >= r.busyUntil && !this.needsReorient(obj, a.bit!)) this.setPhase(a, 'approach', t);
          return undefined;
        }
        if (act.type === 'load') {
          r.req.matchLoad = { loaderId: a.loaderId!, objectId: a.objId! };
          const obj = sim.objects.objects.get(a.objId!);
          if (out.done && obj && obj.mode === 'free') this.setPhase(a, 'approach', t);
          // a piece sitting in the Loader's mouth keeps the Drive Team from loading
          else if (out.done && t - a.phaseT0 > 3 + sim.opts.params.matchLoads.humanLoadSec) return 'Loader mouth blocked';
          return undefined;
        }
        if (out.done) this.setPhase(a, 'approach', t);
        return undefined;
      }
      case 'approach': {
        const ap = a.ap!;
        // A pushed object can lead the robot toward a forbidden zone: stop short of it.
        const fwd = (r.body.cmd.left + r.body.cmd.right) / 2;
        if (!this.world.poseAllowed(add(sense.pos, fromAngle(sense.heading, 2 * Math.sign(fwd || 1))), sense.heading, t)) {
          r.body.cmd = { left: 0, right: 0 };
          return sim.period() === 'autonomous' ? 'would cross the Autonomous Line' : 'would enter the opposing Load Zone';
        }
        if (act.type === 'pick' || act.type === 'load') {
          r.req.intake = true;
          // run only the pocket for the planned kind, so a neighbor isn't swallowed
          r.req.intakeKind = this.world.objs[act.obj].kind;
          const obj = sim.objects.objects.get(a.objId!);
          if (obj && (obj.mode === 'intaking' || obj.mode === 'held') && obj.robotId === r.id) {
            r.body.cmd = { left: 0, right: 0 };
            if (obj.mode === 'held' || t >= r.busyUntil) return true;
            return undefined;
          }
          // The intake grabs whatever is in front of it: accept a same-kind substitute.
          const kind = obj?.kind ?? 'pin';
          const sub = [r.primary, r.secondary].find((o) => o && o.kind === kind && o.id !== a.objId && !a.heldAtStart?.includes(o.id));
          if (sub) {
            r.body.cmd = { left: 0, right: 0 };
            if (t >= r.busyUntil) {
              sim.log({ t, type: 'action', robotId: r.id, text: `${r.id} intook ${sub.id} instead of ${a.objId}` });
              this.substituted = true;
              return true;
            }
            return undefined;
          }
          if (obj && obj.mode !== 'free') return `${a.objId} taken`;
          // aim the holder at the object's current position (slight overshoot to capture)
          const target = obj?.body ? { x: obj.body.translation().x / IN, y: -obj.body.translation().z / IN } : add(ap.center, fromAngle(ap.heading, cfg.intake.holderOffsetIn));
          const out = approach(this.perf, sense, target, cfg.intake.holderOffsetIn - 1.5, 16, tw, this.tuning);
          r.body.cmd = { left: out.left, right: out.right };
          if (out.done || t - a.phaseT0 > 2.5) {
            if (a.retries++ >= 1) return 'intake missed';
            a.badHeadings.push(ap.heading);
            a.backFrom = sense.pos;
            a.backHeading = sense.heading;
            this.setPhase(a, 'backoff', t);
          }
          return undefined;
        }
        if (act.type === 'place') {
          const g = this.world.goals[act.goal];
          const out = approach(this.perf, sense, g.pos, cfg.intake.holderOffsetIn, 16, tw, this.tuning);
          r.body.cmd = { left: out.left, right: out.right };
          const holder = add(sense.pos, fromAngle(sense.heading, cfg.intake.holderOffsetIn));
          const off = dist(holder, g.pos);
          if (off < 0.3 && Math.abs(sense.speed) < 2.5) {
            r.body.cmd = { left: 0, right: 0 };
            this.setPhase(a, 'release', t);
          } else if (t - a.phaseT0 > 2.5 || (t - a.phaseT0 > 0.8 && Math.abs(sense.speed) < 0.8 && Math.abs(sense.yawRate) < 0.2)) {
            // blocked (clutter in the slot / against the post): try a different side
            if (a.retries++ >= 2) return 'could not align with goal';
            a.badHeadings.push(ap.heading);
            a.backFrom = sense.pos;
            a.backHeading = sense.heading;
            this.setPhase(a, 'backoff', t);
          }
          return undefined;
        }
        if (act.type === 'toggle') {
          const target = add(ap.center, fromAngle(ap.heading, cfg.intake.holderOffsetIn - 1.0));
          const out = approach(this.perf, sense, target, cfg.intake.holderOffsetIn, 16, tw, this.tuning);
          r.body.cmd = { left: out.left, right: out.right };
          const stalled = t - a.phaseT0 > 0.4 && Math.abs(sense.speed) < 1.5;
          if (out.done || stalled || t - a.phaseT0 > 1.5) this.setPhase(a, 'toggle', t);
          return undefined;
        }
        return undefined;
      }
      case 'release': {
        r.body.cmd = { left: 0, right: 0 };
        if (t < r.busyUntil) return undefined;
        // a drop lets go near the tiles, so the piece doesn't bounce away
        if (a.dropId && r.body.holderHeight() > cfg.lift.holderMinHeightIn + 0.6 && t - a.phaseT0 < 1.5) return undefined;
        r.req.release = true;
        this.setPhase(a, 'settle', t);
        return undefined;
      }
      case 'settle': {
        r.body.cmd = { left: 0, right: 0 };
        const obj = sim.objects.objects.get(a.objId!);
        if (a.dropId) {
          if (r.primary?.id === a.dropId) return t - a.phaseT0 > 1.0 ? `${a.dropId} did not let go` : undefined;
          // back away from it, then go for the pick
          a.dropId = undefined;
          a.backFrom = sense.pos;
          a.backHeading = sense.heading;
          this.setPhase(a, 'backoff', t);
          return undefined;
        }
        if (obj && (obj.mode === 'seating' || obj.mode === 'stacked')) {
          if (obj.mode === 'stacked' || t - a.phaseT0 > 0.25) {
            a.backFrom = sense.pos;
            a.backHeading = sense.heading;
            a.retries = 99;
            this.setPhase(a, 'backoff', t);
          }
          return undefined;
        }
        if (t - a.phaseT0 > 0.9) return `${a.objId} did not seat on ${a.goalId}`;
        return undefined;
      }
      case 'toggle': {
        const tb = sim.field.toggles.find((x) => x.geom.id === a.toggleId)!;
        const want = this.world.toggleTarget();
        r.req.toggle = { toggleId: a.toggleId!, target: want };
        const out = approach(this.perf, sense, add(a.ap!.center, fromAngle(a.ap!.heading, cfg.intake.holderOffsetIn)), cfg.intake.holderOffsetIn, 6, tw, this.tuning);
        r.body.cmd = { left: out.left * 0.5, right: out.right * 0.5 };
        // Once past the unstable midpoint the detent seats it — back away (SC4: no contact).
        const nearTarget = Math.abs(wrapAngle(toggleTargetAngle(want) - toggleAngle(tb))) < (45 * Math.PI) / 180;
        if (togglePosition(tb) === want || nearTarget) {
          a.backFrom = sense.pos;
          a.backHeading = sense.heading;
          a.retries = 99;
          this.setPhase(a, 'backoff', t);
          return undefined;
        }
        // stalled out of the arm's reach (pieces piled against the wall): back off and
        // work the bar from another spot along it
        const g = tb.geom;
        const front = add(sense.pos, fromAngle(sense.heading, cfg.chassis.lengthIn / 2));
        const gap = (front.x - g.pos.x) * g.normal.x + (front.y - g.pos.y) * g.normal.y;
        if (t - a.phaseT0 > 0.6 && gap > cfg.toggleArm.reachIn + 2.5 && Math.abs(sense.speed) < 1) {
          a.badSpots = [...(a.badSpots ?? []), a.toggleSpot ?? 0];
          if (act.type !== 'toggle' || a.badSpots.length >= this.world.toggleTargets(act.toggle).length) return 'pieces block the Toggle';
          a.backFrom = sense.pos;
          a.backHeading = sense.heading;
          this.setPhase(a, 'backoff', t);
          return undefined;
        }
        if (t - a.phaseT0 > 2.5) return 'toggle did not move';
        return undefined;
      }
      case 'backoff': {
        a.holderTarget = act.type === 'place' ? Math.max(cfg.lift.holderMinHeightIn, a.holderTarget) : a.holderTarget;
        const out = backOff(this.perf, sense, a.backFrom!, act.type === 'toggle' ? 5 : a.retries >= 99 ? 6 : 10, a.backHeading!, tw, this.tuning);
        r.body.cmd = { left: out.left, right: out.right };
        if (out.done || t - a.phaseT0 > 1.5) {
          if (a.retries >= 99) {
            if (act.type === 'place') a.holderTarget = cfg.lift.holderMinHeightIn;
            return true;
          }
          this.setPhase(a, 'start', t);
        }
        return undefined;
      }
      case 'wait': {
        r.body.cmd = { left: 0, right: 0 };
        if (act.type === 'wait' && t >= act.until - 1e-9) return true;
        return undefined;
      }
      case 'parked': {
        r.body.cmd = { left: 0, right: 0 };
        a.holderTarget = cfg.lift.holderMinHeightIn;
        // parked early (nothing else looked doable, e.g. both Loaders blocked a moment ago):
        // look again now and then — there may be work by now
        if (t < this.world.clock.endgameStart - 8 && t - a.phaseT0 > 8) return true;
        return undefined; // stays parked to the end
      }
      default:
        return undefined;
    }
  }

  /**
   * Closing in on a pick / load: the intake already runs, so a piece the robot
   * reaches early is taken rather than knocked over. True once it has something new
   * (the approach phase then finishes the action).
   */
  private intakeEarly(r: SimRobot, sense: Sensing, a: Active, t: number): boolean {
    const act = a.action;
    if ((act.type !== 'pick' && act.type !== 'load') || !a.ap || dist(sense.pos, a.ap.center) > 14) return false;
    r.req.intake = true;
    r.req.intakeKind = this.world.objs[act.obj].kind;
    if (![r.primary, r.secondary].some((o) => o && !a.heldAtStart?.includes(o.id))) return false;
    this.setPhase(a, 'approach', t);
    return true;
  }

  /** Point the holder must reach for the current action (live object/goal position). */
  private aimPoint(sim: MatchSim, a: Active): Vec2 | null {
    const act = a.action;
    if (act.type === 'pick' && a.objId) {
      const b = sim.objects.objects.get(a.objId)?.body;
      return b ? { x: b.translation().x / IN, y: -b.translation().z / IN } : null;
    }
    if (act.type === 'load' && a.loaderId) return this.world.loaders.find((l) => l.id === a.loaderId)!.dispense;
    if (act.type === 'place') return this.world.goals[act.goal].pos;
    return null;
  }

  private needsReorient(obj: SimObject, bit: number): boolean {
    const up = upOf(obj.body!.rotation()).y >= 0;
    if (obj.kind === 'pin') {
      if (obj.colors![0] === obj.colors![1]) return false;
      const downIdx = up ? 0 : 1;
      return downIdx !== bit;
    }
    const grayDown = !up;
    return (grayDown ? 1 : 0) !== bit;
  }
}
