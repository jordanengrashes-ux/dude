import { Rng } from '../core/rng';
import { clamp } from '../core/units';
import type { Vec2 } from '../core/vec';
import { buildGoals, buildToggles } from '../field/geometry';
import type { FieldLayout } from '../field/layout';
import { cloneRobot, type RobotConfig } from '../robot/config';
import type { MatchType, OverrideParams, Alliance } from '../rules/ruleset';
import { PlanWorld, type Action, type ExternalEvent, type PlanConfig } from '../planner/model';
import { beamSearch } from '../planner/search/beam';
import { planKey, replay } from '../planner/search/common';
import type { UncertaintyConfig } from '../planner/robustness';
import { DEFAULT_MPC, PlanExecutor, type MpcOptions } from './executor';
import { MatchSim, type Controller, type RobotSetup, type Sensing, type SimRobot } from './match';
import { approach, backOff, DEFAULT_TUNING } from './drive';
import { SlotController, type DriverInput } from './driver';
import { derivePerf } from '../robot/kinematics';

/**
 * Scenario assembly: which robots are on the field, how each one is controlled,
 * and how the optimizer accounts for the other robots.
 *
 * Strategies:
 *  - 'optimized'  — plan from the optimizer (or a fresh beam search), executed with MPC
 *  - 'toggles'    — scripted: keeps flipping Toggles to its own color
 *  - 'midfield'   — scripted: waits, then parks in the Midfield (contests SC5b/SC6)
 *  - 'defender'   — scripted: sits in front of the opponents' most valuable Goal
 *  - 'idle'       — stays still (only when explicitly selected)
 *  - 'manual'     — keyboard control
 */

export type Strategy = 'optimized' | 'toggles' | 'midfield' | 'defender' | 'idle' | 'manual';

export interface SlotSetup {
  slot: string;
  alliance: Alliance;
  enabled: boolean;
  strategy: Strategy;
  robot: RobotConfig;
  /** Precomputed plan (e.g. the optimizer's best) for 'optimized' slots. */
  plan?: Action[];
}

export interface ScenarioConfig {
  params: OverrideParams;
  layout: FieldLayout;
  matchType: MatchType;
  slots: SlotSetup[];
  seed: number;
  mpc?: MpcOptions;
  /** Beam width for automatically planned robots (opponents / partner). */
  aiBeamWidth?: number;
  /** Practice: drivers drive from the start, no rule-violation checks. */
  practice?: boolean;
}

export function planConfigFor(sc: ScenarioConfig, slot: SlotSetup, events: ExternalEvent[] = [], overrides: Partial<PlanConfig> = {}): PlanConfig {
  const isH2H = sc.matchType === 'headToHead';
  const total = isH2H ? sc.params.timing.autonomousSec + sc.params.timing.driverSec : sc.params.timing.skillsSec;
  return {
    params: sc.params,
    robot: slot.robot,
    layout: sc.layout,
    matchType: sc.matchType,
    robotId: slot.slot,
    alliance: slot.alliance,
    tStart: 0,
    tEnd: total,
    objective: 'own',
    awpWeight: 0,
    includeAutonBonus: isH2H,
    opponentAutoScore: 0,
    externalEvents: events,
    candidateK: 5,
    allowPark: true,
    cruiseFraction: 0.85,
    positionSigma: 0.3,
    patrolToggles: slot.strategy === 'toggles',
    ...overrides,
  };
}

/**
 * Convert a robot's planned actions into time-stamped events other planners can
 * anticipate (objects it will take, stacks it will build, Toggles it will flip,
 * when it will be in the Midfield). Object indices match because every world is
 * built from the same layout without object filters.
 */
export function predictEvents(w: PlanWorld, actions: Action[]): ExternalEvent[] {
  const ev: ExternalEvent[] = [];
  let s = w.initialState();
  const allGoals = buildGoals();
  const allToggles = buildToggles();
  for (const a of actions) {
    const r = w.apply(s, a);
    if (!r) continue;
    const t = r.step.tEnd;
    if (a.type === 'pick' || a.type === 'load') ev.push({ t: r.step.tStart + 0.5, kind: 'claim', obj: a.obj });
    if (a.type === 'place') {
      const code = r.s.stacks[a.goal][r.s.stacks[a.goal].length - 1];
      ev.push({ t, kind: 'place', goal: allGoals.findIndex((g) => g.id === w.goals[a.goal].id), obj: code >> 1, bit: code & 1 });
    }
    if (a.type === 'toggle') ev.push({ t, kind: 'toggle', toggle: allToggles.findIndex((x) => x.id === w.toggles[a.toggle].id), position: w.toggleTarget() });
    if (a.type === 'park') ev.push({ t, kind: 'midfield', alliance: w.cfg.alliance, robotId: w.cfg.robotId });
    s = r.s;
  }
  return ev.sort((p, q) => p.t - q.t);
}

/** Predicted events of every enabled scripted robot ('toggles', 'midfield'), optionally excluding one slot. */
function scriptedEvents(sc: ScenarioConfig, exclude?: string): ExternalEvent[] {
  let events: ExternalEvent[] = [];
  for (const slot of sc.slots) {
    if (!slot.enabled || slot.slot === exclude) continue;
    const w = new PlanWorld(planConfigFor(sc, slot));
    const acts = scriptedActions(sc, slot, w);
    if (acts) events = events.concat(predictEvents(w, acts));
  }
  return events;
}

export type ScenarioPlans = Map<string, { actions: Action[]; world: PlanWorld; events: ExternalEvent[]; value: number }>;

/** How the joint planning went, for the UI. */
export interface PlanningStats {
  rounds: number;
  /** No robot found a better plan against the others' final plans. */
  converged: boolean;
  /** Each optimized robot's planned value (its alliance's score in the model). */
  values: Record<string, number>;
}

/**
 * Plan every 'optimized' slot jointly, treating both alliances the same way. Each
 * robot plans around the scripted robots and the other robots' plans (their
 * predicted claims, placements, Toggle flips and Midfield parking).
 *
 * Partners coordinate: within an alliance robots plan in turn, each seeing its
 * partner's latest plan (the focus slot last). Opponents respond simultaneously:
 * round 0 each alliance plans without the opposing robots; in each following round
 * both alliances re-plan against the opponent's plans from the previous round,
 * keeping the better of the old and new plan. Neither alliance gets the last word.
 *
 * In Override this rarely settles: the last Toggle flip and the Midfield majority
 * decide who scores the yellow halves, so best responses keep flipping. Planning
 * stops when a round changes nothing (no robot can improve against the others: an
 * equilibrium of the planning model) or after `rounds`, and each robot keeps the
 * plan, world and value of the last round it planned in. A robot with a fixed plan
 * (the optimizer's, for the user's slot) keeps it.
 */
export function planScenario(sc: ScenarioConfig, focusSlot?: string, opts: { rounds?: number; stats?: PlanningStats } = {}): ScenarioPlans {
  const order = sc.slots.filter((s) => s.enabled && s.strategy === 'optimized').sort((a, b) => (a.slot === focusSlot ? 1 : 0) - (b.slot === focusSlot ? 1 : 0));
  const scripted = scriptedEvents(sc);
  const out: ScenarioPlans = new Map();
  const predicted = new Map<string, ExternalEvent[]>();
  const beam = (w: PlanWorld) => beamSearch(w, { width: sc.aiBeamWidth ?? 12, alpha: 0.3 }, { maxMs: Infinity, maxExpansions: Infinity }).best;
  const allianceOf = (slot: string) => sc.slots.find((s) => s.slot === slot)!.alliance;
  /** Events of every other robot: partners from `own`, opponents from `opp`. */
  const eventsAgainst = (slot: string, own: Map<string, ExternalEvent[]>, opp: Map<string, ExternalEvent[]>) => {
    const a = allianceOf(slot);
    const ev = [...scripted];
    for (const [k, e] of own) if (k !== slot && allianceOf(k) === a) ev.push(...e);
    for (const [k, e] of opp) if (allianceOf(k) !== a) ev.push(...e);
    return ev.sort((p, q) => p.t - q.t);
  };
  /** Plan (or re-plan) one robot against `events`; returns whether its plan changed. */
  const planOne = (slot: SlotSetup, events: ExternalEvent[], sink: Map<string, ExternalEvent[]>): boolean => {
    const w = new PlanWorld(planConfigFor(sc, slot, events));
    const prev = out.get(slot.slot)?.actions;
    let actions: Action[];
    let value: number;
    if (slot.plan || prev) {
      const old = replay(w, slot.plan ?? prev!);
      actions = old.actions;
      value = old.value;
      if (!slot.plan) {
        const fresh = beam(w);
        if (fresh.value > value + 1e-9) {
          actions = fresh.actions;
          value = fresh.value;
        }
      }
    } else {
      const fresh = beam(w);
      actions = fresh.actions;
      value = fresh.value;
    }
    out.set(slot.slot, { actions, world: w, events, value });
    sink.set(slot.slot, predictEvents(w, actions));
    return !!prev && planKey(actions) !== planKey(prev);
  };
  const noOpp = new Map<string, ExternalEvent[]>();
  for (const slot of order) planOne(slot, eventsAgainst(slot.slot, predicted, noOpp), predicted);
  const maxRounds = opts.rounds ?? 2;
  let rounds = 0;
  let converged = new Set(order.map((s) => s.alliance)).size <= 1;
  while (!converged && rounds < maxRounds) {
    rounds++;
    const prev = new Map(predicted);
    const cur = new Map<string, ExternalEvent[]>();
    let changed = false;
    // partners: this round's plan if already updated, else the previous one
    for (const slot of order) if (planOne(slot, eventsAgainst(slot.slot, new Map([...prev, ...cur]), prev), cur)) changed = true;
    for (const [k, e] of cur) predicted.set(k, e);
    converged = !changed;
  }
  const values: Record<string, number> = {};
  for (const [k, p] of out) values[k] = p.value;
  if (opts.stats) Object.assign(opts.stats, { rounds, converged, values });
  return out;
}

/** Fixed action lists used by the scripted 'toggles' and 'midfield' strategies. */
export function scriptedActions(sc: ScenarioConfig, slot: SlotSetup, w: PlanWorld): Action[] | null {
  if (slot.strategy === 'toggles') {
    // Patrol the Toggles around the perimeter for the whole match, re-asserting each
    // one; in Autonomous only the own-side Toggles (SG7), then wait for Driver Control.
    const acts: Action[] = [];
    let s = w.initialState();
    let next = 0;
    const n = w.toggles.length;
    while (acts.length < 400 && n > 0) {
      let done = false;
      for (let j = 0; j < n && !done; j++) {
        const ti = (next + j) % n;
        const r = w.apply(s, { type: 'toggle', toggle: ti });
        if (r) {
          acts.push({ type: 'toggle', toggle: ti });
          s = r.s;
          next = ti + 1;
          done = true;
        }
      }
      if (done) continue;
      const ae = w.clock.autonomousEnd;
      const r = ae !== null && w.isAutonomous(s.t) ? w.apply(s, { type: 'wait', until: ae }) : null;
      if (!r) break;
      acts.push({ type: 'wait', until: ae! });
      s = r.s;
    }
    return acts;
  }
  if (slot.strategy === 'midfield') {
    const ae = sc.matchType === 'headToHead' ? sc.params.timing.autonomousSec : 0;
    return ae > 0 ? [{ type: 'wait', until: ae }, { type: 'park' }] : [{ type: 'park' }];
  }
  return null;
}

/**
 * Predicted actions of every enabled robot except `focusSlot`, as external events
 * the focus robot's optimizer plans around (objects taken, stacks built, Toggles
 * flipped, Midfield occupancy).
 */
export function predictOthers(sc: ScenarioConfig, focusSlot: string): ExternalEvent[] {
  const others: ScenarioConfig = { ...sc, slots: sc.slots.filter((s) => s.slot !== focusSlot) };
  const planned = planScenario(others);
  let events: ExternalEvent[] = scriptedEvents(others);
  for (const [, p] of planned) events = events.concat(predictEvents(p.world, p.actions));
  return events.sort((a, b) => a.t - b.t);
}

class IdleController implements Controller {
  readonly kind = 'idle';
  update(_sim: MatchSim, r: SimRobot) {
    r.body.cmd = { left: 0, right: 0 };
  }
}

/** Scripted defender: drives to a blocking pose in front of a Goal and holds it. */
class DefenderController implements Controller {
  readonly kind = 'defender';
  private perf;
  constructor(
    private target: Vec2,
    private cfg: RobotConfig,
    private startAfter: number,
  ) {
    this.perf = derivePerf(cfg);
  }
  update(sim: MatchSim, r: SimRobot, sense: Sensing) {
    if (sim.t < this.startAfter) {
      r.body.cmd = { left: 0, right: 0 };
      return;
    }
    const tune = { ...DEFAULT_TUNING, trackWidth: this.cfg.drivetrain.trackWidthIn };
    const out = approach(this.perf, sense, this.target, 0, 30, this.cfg.drivetrain.trackWidthIn, tune);
    r.body.cmd = Math.abs(out.along) < 1.5 ? backOff(this.perf, sense, sense.pos, 0, sense.heading, this.cfg.drivetrain.trackWidthIn, tune) : { left: out.left, right: out.right };
  }
}

export interface BuiltScenario {
  sim: MatchSim;
  plans: ScenarioPlans;
  executors: Map<string, PlanExecutor>;
  /** Every robot's slot: its bot, which a human driver can take over at any time. */
  slots: Map<string, SlotController>;
}

/** Driver input for a slot this step (null = nobody is driving it). */
export type InputSource = (slot: string) => DriverInput | null;

export interface TrialPerturbation {
  motorScale: Record<string, number>;
  tractionScale: Record<string, number>;
  battery: Record<string, number>;
  sensorSd: { pos: number; heading: number };
  objectJitterSd: number;
}

export async function buildMatch(sc: ScenarioConfig, inputs?: InputSource, perturb?: TrialPerturbation, prePlanned?: BuiltScenario['plans']): Promise<BuiltScenario> {
  const plans = prePlanned ?? planScenario(sc);
  const executors = new Map<string, PlanExecutor>();
  const slotCtl = new Map<string, SlotController>();
  const robots: RobotSetup[] = [];
  for (const slot of sc.slots) {
    if (!slot.enabled) continue;
    let ctl: Controller;
    const robot = cloneRobot(slot.robot);
    if (perturb?.battery[slot.slot] !== undefined) robot.battery.voltage = perturb.battery[slot.slot];
    switch (slot.strategy) {
      case 'optimized': {
        const p = plans.get(slot.slot);
        if (!p) {
          ctl = new IdleController(); // plan still being computed
          break;
        }
        const ex = new PlanExecutor(p.world.cfg, p.actions, sc.mpc ?? DEFAULT_MPC, p.world);
        executors.set(slot.slot, ex);
        ctl = ex;
        break;
      }
      case 'toggles':
      case 'midfield': {
        const cfg = planConfigFor(sc, slot, [], { allowPark: slot.strategy === 'midfield' });
        const w = new PlanWorld(cfg);
        const ex = new PlanExecutor(cfg, scriptedActions(sc, slot, w)!, { ...DEFAULT_MPC, enabled: false }, w);
        executors.set(slot.slot, ex);
        ctl = ex;
        break;
      }
      case 'defender': {
        // block in front of the most valuable opposing-side neutral Goal (Midfield excluded)
        const opp: Alliance = slot.alliance === 'red' ? 'blue' : 'red';
        const goals = buildGoals().filter((g) => g.type === 'neutral' && (opp === 'red' ? g.pos.x + g.pos.y < 0 : g.pos.x + g.pos.y > 0));
        const g = goals[0] ?? buildGoals()[0];
        const dir = { x: -g.pos.x, y: -g.pos.y };
        const l = Math.hypot(dir.x, dir.y) || 1;
        const target = { x: g.pos.x + (dir.x / l) * 16, y: g.pos.y + (dir.y / l) * 16 };
        ctl = new DefenderController(target, robot, sc.matchType === 'headToHead' ? sc.params.timing.autonomousSec : 0);
        break;
      }
      default:
        ctl = new IdleController();
    }
    const sl = new SlotController(slot.slot, ctl, () => inputs?.(slot.slot) ?? null);
    if (slot.strategy === 'manual') sl.setHuman('You');
    slotCtl.set(slot.slot, sl);
    robots.push({
      id: slot.slot,
      alliance: slot.alliance,
      config: robot,
      controller: sl,
      start: undefined, // starting poses come from the layout (editable in Field Setup)
      motorScale: perturb?.motorScale[slot.slot],
      tractionScale: perturb?.tractionScale[slot.slot],
      sensorSd: perturb?.sensorSd,
    });
  }
  const sim = await MatchSim.create({ params: sc.params, layout: sc.layout, robots, seed: sc.seed, objectJitterSd: perturb?.objectJitterSd, practice: sc.practice });
  return { sim, plans, executors, slots: slotCtl };
}

export interface PhysicsTrialStats {
  trials: number;
  scores: number[];
  margins: number[];
  mean: number;
  median: number;
  best: number;
  worst: number;
  sd: number;
  pTarget: number | null;
  failures: { label: string; count: number }[];
  violations: { ruleId: string; count: number }[];
  meanReplans: number;
}

/**
 * Physics Monte Carlo: run the full simulation `trials` times with sampled motor,
 * traction, battery, sensor and object-placement uncertainty. Scores always come
 * from the rules engine on the final simulated field.
 */
export async function physicsMonteCarlo(sc: ScenarioConfig, focusSlot: string, unc: UncertaintyConfig, trials: number, seed: number, target: number | null = null, onTrial?: (k: number, score: number) => void): Promise<PhysicsTrialStats> {
  const rng = new Rng(seed);
  const plans = planScenario(sc, focusSlot);
  const scores: number[] = [];
  const margins: number[] = [];
  const fails = new Map<string, number>();
  const viol = new Map<string, number>();
  let replans = 0;
  const focus = sc.slots.find((s) => s.slot === focusSlot)!;
  for (let k = 0; k < trials; k++) {
    const perturb: TrialPerturbation = { motorScale: {}, tractionScale: {}, battery: {}, sensorSd: { pos: unc.positionSigma * 0.5, heading: 0.004 }, objectJitterSd: unc.objectPosSd };
    for (const s of sc.slots) {
      perturb.motorScale[s.slot] = clamp(rng.normal(1, unc.motorSd), 0.6, 1.3);
      perturb.tractionScale[s.slot] = clamp(rng.normal(1, unc.tractionSd), 0.5, 1.4);
      perturb.battery[s.slot] = rng.range(unc.batteryMin, unc.batteryMax);
    }
    const built = await buildMatch({ ...sc, seed: seed * 1000 + k }, undefined, perturb, plans);
    built.sim.runUntil(built.sim.clock.total + 0.05);
    const fin = built.sim.result ? built.sim.result.totals : built.sim.liveScore().totals;
    const own = fin[focus.alliance];
    const opp = fin[focus.alliance === 'red' ? 'blue' : 'red'];
    scores.push(own);
    margins.push(own - opp);
    const ex = built.executors.get(focusSlot);
    if (ex) {
      replans += ex.replans;
      for (const h of ex.history) if (!h.ok) fails.set(h.label.replace(/ \(.*\)$/, ''), (fails.get(h.label.replace(/ \(.*\)$/, '')) ?? 0) + 1);
    }
    for (const v of built.sim.violations) if (v.robotId === focusSlot) viol.set(v.ruleId, (viol.get(v.ruleId) ?? 0) + 1);
    built.sim.dispose();
    onTrial?.(k, own);
  }
  const sorted = scores.slice().sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, scores.length));
  return {
    trials,
    scores,
    margins,
    mean,
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    best: sorted[sorted.length - 1] ?? 0,
    worst: sorted[0] ?? 0,
    sd,
    pTarget: target === null ? null : scores.filter((x) => x >= target).length / Math.max(1, scores.length),
    failures: [...fails].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    violations: [...viol].map(([ruleId, count]) => ({ ruleId, count })),
    meanReplans: replans / Math.max(1, trials),
  };
}
