import { buildMatch, planScenario, type BuiltScenario, type ScenarioConfig } from '../sim/scenario';
import { DT, type Controller, type MatchSim, type Sensing, type SimRobot } from '../sim/match';
import type { Action } from '../planner/model';
import { buildToggles, buildLoaders } from '../field/geometry';
import { store, type AppState } from './store';

/**
 * Drives the live simulation for the UI. Physics advances in fixed DT steps from
 * an accumulator (wall time × speed), so the frame rate never changes results.
 * Manual inputs are logged per step; a checkpoint restore rebuilds the scenario
 * and replays deterministically to the checkpoint time.
 */

export interface ManualInput {
  forward: number;
  turn: number;
  lift: number;
  intake: boolean;
  release: boolean;
  index: boolean;
  reorient: boolean;
  toggle: boolean;
  load: boolean;
}

const zeroInput = (): ManualInput => ({ forward: 0, turn: 0, lift: 0, intake: false, release: false, index: false, reorient: false, toggle: false, load: false });

class ManualController implements Controller {
  readonly kind = 'manual';
  constructor(private runner: SimRunner) {}
  update(sim: MatchSim, r: SimRobot, sense: Sensing) {
    const inp = this.runner.inputForStep(sim.steps);
    const f = inp.forward;
    const t = inp.turn * 0.7;
    r.body.cmd = { left: Math.max(-1, Math.min(1, f - t)), right: Math.max(-1, Math.min(1, f + t)) };
    r.body.liftManual = inp.lift !== 0 ? inp.lift : null;
    if (inp.lift === 0 && r.body.liftManual === null) r.body.liftTarget = sense.holderHeight;
    r.req.intake = inp.intake;
    r.req.release = inp.release;
    r.req.index = inp.index;
    r.req.reorient = inp.reorient;
    if (inp.toggle) {
      // actuate the nearest Toggle toward this robot's color
      const tg = buildToggles().reduce((a, b) => (Math.hypot(b.pos.x - sense.pos.x, b.pos.y - sense.pos.y) < Math.hypot(a.pos.x - sense.pos.x, a.pos.y - sense.pos.y) ? b : a));
      r.req.toggle = { toggleId: tg.id, target: sim.clock.matchType === 'headToHead' ? r.alliance : sim.opts.params.skills.ownedToggleColor };
    }
    if (inp.load) {
      const l = buildLoaders()
        .filter((x) => sim.clock.matchType !== 'headToHead' || x.alliance === r.alliance)
        .reduce((a, b) => (Math.hypot(b.dispense.x - sense.pos.x, b.dispense.y - sense.pos.y) < Math.hypot(a.dispense.x - sense.pos.x, a.dispense.y - sense.pos.y) ? b : a));
      const next = [...sim.objects.objects.values()].find((o) => o.mode === 'offfield' && (sim.clock.matchType !== 'headToHead' || o.matchloadAlliance === r.alliance) && !(r.primary?.kind === o.kind || r.secondary?.kind === o.kind));
      if (next) r.req.matchLoad = { loaderId: l.id, objectId: next.id };
    }
  }
}

export class SimRunner {
  built: BuiltScenario | null = null;
  sim: MatchSim | null = null;
  playing = false;
  speed = 1;
  tick = 0;
  building = false;
  /** Live keyboard state (sampled once per physics step while recording). */
  live: ManualInput = zeroInput();
  private inputLog: ManualInput[] = [];
  private replaying = false;
  private acc = 0;
  private listeners = new Set<() => void>();
  private scenario: ScenarioConfig | null = null;
  checkpoints: { t: number; steps: number; label: string }[] = [];
  error: string | null = null;

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  private emit() {
    this.tick++;
    for (const l of this.listeners) l();
  }

  inputForStep(step: number): ManualInput {
    if (this.replaying) return this.inputLog[step] ?? zeroInput();
    const inp = { ...this.live };
    this.inputLog[step] = inp;
    // one-shot buttons
    this.live.release = false;
    this.live.index = false;
    this.live.reorient = false;
    return inp;
  }

  scenarioFrom(s: AppState): ScenarioConfig {
    const userPlan = this.userPlan(s);
    return {
      params: s.params,
      layout: s.layout,
      matchType: s.matchType,
      seed: s.settings.seed,
      aiBeamWidth: 10,
      slots: s.slots.map((x) => (x.slot === s.userSlot ? { ...x, robot: s.robot, plan: userPlan ?? undefined } : x)),
    };
  }

  userPlan(s: AppState): Action[] | null {
    const r = s.report;
    if (!r) return null;
    const id = s.executePlan ?? (r.recommended === 'best' ? r.best.id : r.practical.id);
    return (r.candidates.find((c) => c.id === id) ?? r.best).actions;
  }

  async rebuild(s: AppState = store.get()) {
    if (this.building) return;
    this.building = true;
    this.error = null;
    try {
      this.sim?.dispose();
      this.sim = null;
      this.scenario = this.scenarioFrom(s);
      const plans = planScenario(this.scenario, s.userSlot);
      this.built = await buildMatch(this.scenario, new ManualController(this), undefined, plans);
      this.sim = this.built.sim;
      this.inputLog = [];
      this.checkpoints = [];
      this.acc = 0;
      this.playing = false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.building = false;
      this.emit();
    }
  }

  /** Advance by wall-clock seconds × speed using fixed physics steps. */
  frame(dtReal: number) {
    if (!this.sim || !this.playing) return;
    this.acc += Math.min(0.1, dtReal) * this.speed;
    let n = 0;
    const maxSteps = 240; // keep the UI responsive at high speed
    while (this.acc >= DT && n < maxSteps) {
      if (this.sim.t >= this.sim.clock.total) {
        this.playing = false;
        break;
      }
      this.sim.step();
      this.acc -= DT;
      n++;
    }
    if (n) this.emit();
  }

  stepOnce(n = 1) {
    if (!this.sim) return;
    for (let i = 0; i < n && this.sim.t < this.sim.clock.total; i++) this.sim.step();
    this.emit();
  }

  setPlaying(p: boolean) {
    this.playing = p;
    this.emit();
  }

  setSpeed(v: number) {
    this.speed = v;
    this.emit();
  }

  addCheckpoint(label?: string) {
    if (!this.sim) return;
    this.checkpoints.push({ t: this.sim.t, steps: this.sim.steps, label: label ?? `t=${this.sim.t.toFixed(1)} s` });
    this.emit();
  }

  /** Deterministic restore: rebuild and replay logged inputs to the checkpoint. */
  async restore(steps: number) {
    if (!this.scenario) return;
    const log = this.inputLog.slice(0, steps);
    const cps = this.checkpoints.slice();
    this.sim?.dispose();
    const plans = planScenario(this.scenario, store.get().userSlot);
    this.built = await buildMatch(this.scenario, new ManualController(this), undefined, plans);
    this.sim = this.built.sim;
    this.inputLog = log;
    this.replaying = true;
    while (this.sim.steps < steps) this.sim.step();
    this.replaying = false;
    this.checkpoints = cps;
    this.playing = false;
    this.emit();
  }

  /** Run to the end of the match headless (fast-forward). */
  runToEnd() {
    if (!this.sim) return;
    this.sim.runUntil(this.sim.clock.total + DT);
    this.playing = false;
    this.emit();
  }
}

export const runner = new SimRunner();
