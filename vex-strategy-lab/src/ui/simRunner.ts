import { buildMatch, type BuiltScenario, type PlanningStats, type ScenarioConfig, type ScenarioPlans } from '../sim/scenario';
import { cachedPlans, planScenarioAsync } from '../sim/planCache';
import { DT, type MatchSim } from '../sim/match';
import { zeroInput, type DriverInput } from '../sim/driver';
import type { Action } from '../planner/model';
import { store, type AppState } from './store';
import { bindTeam } from '../net/session';

/**
 * Drives the live simulation for the UI. Physics advances in fixed DT steps from
 * an accumulator (wall time × speed), so the frame rate never changes results.
 *
 * Every robot is a slot whose bot can be taken over by a driver: the local
 * keyboard/gamepad (`local`, driving `localSlot`) or a remote team-mode player
 * (`remote`). Driver inputs are logged per slot and step, so a checkpoint
 * restore rebuilds the scenario and replays deterministically.
 */

export type SlotDriver = { kind: 'bot' } | { kind: 'local'; name: string } | { kind: 'remote'; name: string; peerId: string };

export class SimRunner {
  built: BuiltScenario | null = null;
  sim: MatchSim | null = null;
  playing = false;
  speed = 1;
  tick = 0;
  building = false;
  /** Local driver input (keyboard / gamepad), sampled once per physics step. */
  live: DriverInput = zeroInput();
  /** Slot the local driver controls (null = spectating). */
  localSlot: string | null = null;
  /** Latest inputs from remote team-mode drivers, by slot. */
  remote = new Map<string, DriverInput>();
  /** Who drives each slot. */
  drivers = new Map<string, SlotDriver>();
  private inputLog = new Map<string, DriverInput[]>();
  private replaying = false;
  private acc = 0;
  private listeners = new Set<() => void>();
  private scenario: ScenarioConfig | null = null;
  checkpoints: { t: number; steps: number; label: string }[] = [];
  error: string | null = null;
  /** Plans are being computed in the background; the robots wait at their start. */
  planning = false;
  /** How the joint planning of the current scenario went (null while planning). */
  planningStats: PlanningStats | null = null;
  private version = 0;

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

  /** Match type, rules and layout of the running scenario (team-mode setup). */
  scenarioInfo() {
    const sc = this.scenario;
    return sc ? { matchType: sc.matchType, params: sc.params, layout: sc.layout } : null;
  }

  /** Driver input for a slot at the current physics step (logged for deterministic replay). */
  inputFor(slot: string): DriverInput | null {
    const step = this.sim?.steps ?? 0;
    const d = this.drivers.get(slot);
    if (!d || d.kind === 'bot') return null;
    let log = this.inputLog.get(slot);
    if (!log) this.inputLog.set(slot, (log = []));
    if (this.replaying) return log[step] ?? zeroInput();
    const inp = d.kind === 'local' ? { ...this.live } : { ...(this.remote.get(slot) ?? zeroInput()) };
    log[step] = inp;
    return inp;
  }

  /** Hand a slot to a driver (or back to its bot). */
  setDriver(slot: string, d: SlotDriver) {
    if (d.kind === 'local') {
      if (this.localSlot && this.localSlot !== slot) this.setDriver(this.localSlot, { kind: 'bot' });
      this.localSlot = slot;
    } else if (this.localSlot === slot) this.localSlot = null;
    if (d.kind === 'bot') this.remote.delete(slot);
    this.drivers.set(slot, d);
    const sc = this.built?.slots.get(slot);
    if (sc) {
      if (d.kind === 'bot') sc.setBot();
      else sc.setHuman(d.name);
    }
    this.emit();
  }

  /** Drivers per slot, for the UI. */
  driverOf(slot: string): SlotDriver {
    return this.drivers.get(slot) ?? { kind: 'bot' };
  }

  private applyDrivers() {
    if (!this.built) return;
    for (const [slot, sc] of this.built.slots) {
      const d = this.drivers.get(slot);
      if (d && d.kind !== 'bot') sc.setHuman(d.name);
      else if (sc.isHuman) {
        // 'manual' strategy slots start with the local driver
        this.drivers.set(slot, { kind: 'local', name: 'You' });
        if (!this.localSlot) this.localSlot = slot;
      }
    }
  }

  scenarioFrom(s: AppState): ScenarioConfig {
    if (s.practice) {
      // only your robot, driven by you from the first second
      const me = s.slots.find((x) => x.slot === s.userSlot) ?? s.slots[0];
      return { params: s.params, layout: s.layout, matchType: s.matchType, seed: s.settings.seed, practice: true, slots: [{ ...me, robot: s.robot, enabled: true, strategy: 'manual' }] };
    }
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

  /**
   * Build the match for the current setup. With plans at hand (cache, or the
   * shipped default) this is immediate; otherwise the field appears at once with
   * the robots waiting, and the plans computed in a worker are swapped in when
   * ready. A newer rebuild supersedes one still planning.
   */
  async rebuild(s: AppState = store.get()) {
    const version = ++this.version;
    this.building = true;
    this.error = null;
    this.emit();
    try {
      const sc = this.scenarioFrom(s);
      const hit = cachedPlans(sc, s.userSlot);
      if (hit) {
        this.planning = false;
        await this.install(version, sc, hit.plans, hit.stats);
        return;
      }
      this.planning = true;
      this.planningStats = null;
      await this.install(version, sc, new Map(), null);
      this.building = false;
      this.emit();
      const res = await planScenarioAsync(sc, s.userSlot);
      if (version !== this.version) return;
      this.planning = false;
      await this.install(version, sc, res.plans, res.stats);
    } catch (e) {
      if (version !== this.version) return;
      this.planning = false;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (version === this.version) {
        this.building = false;
        this.emit();
      }
    }
  }

  private async install(version: number, sc: ScenarioConfig, plans: ScenarioPlans, stats: PlanningStats | null) {
    const built = await buildMatch(sc, (slot) => this.inputFor(slot), undefined, plans);
    if (version !== this.version) {
      built.sim.dispose();
      return;
    }
    this.sim?.dispose();
    this.scenario = sc;
    this.built = built;
    this.sim = built.sim;
    this.planningStats = stats;
    this.applyDrivers();
    this.inputLog = new Map();
    this.checkpoints = [];
    this.acc = 0;
    this.playing = false;
  }

  /**
   * Advance by wall-clock seconds × speed using fixed physics steps. `maxDt` caps a
   * long gap (e.g. 1 s when a team-mode host's hidden tab only gets timer ticks).
   */
  frame(dtReal: number, maxDt = 0.1) {
    if (!this.sim || !this.playing) return;
    this.acc += Math.min(maxDt, dtReal) * this.speed;
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
    if (p && this.planning) return; // robots have no plans yet
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
    const log = new Map([...this.inputLog].map(([k, v]) => [k, v.slice(0, steps)]));
    const cps = this.checkpoints.slice();
    this.sim?.dispose();
    this.built = await buildMatch(this.scenario, (slot) => this.inputFor(slot), undefined, this.built?.plans ?? new Map());
    this.sim = this.built.sim;
    this.applyDrivers();
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
bindTeam(runner);
