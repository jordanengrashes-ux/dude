import { buildLoaders, buildToggles } from '../field/geometry';
import type { Controller, MatchSim, Sensing, SimRobot } from './match';

/**
 * Human driver control and bot ↔ human hand-over.
 *
 * DriverInput is the whole control surface of a robot, the same for keyboard,
 * gamepad and remote players: arcade drive, the lift (analog up/down or a height
 * preset), the claw (close = run the intake, drop = release the held object), the
 * toggle arm, pocket index, flip and a Match Load request. One-shot actions are
 * press counters, so a press is never lost when inputs are sampled once per
 * physics step or arrive over the network.
 */

export interface DriverInput {
  /** Arcade drive, −1…1. */
  forward: number;
  turn: number;
  /** Lift: + raises, − lowers the arm (−1…1). */
  lift: number;
  /** Holder height preset (in) to move the lift to; null when none. Analog lift input cancels it. */
  preset: number | null;
  /** Claw closed: the intake runs while held. */
  claw: boolean;
  /** Toggle arm engaged while held (works the nearest Toggle toward this robot's color). */
  toggle: boolean;
  /** Press counters. */
  drop: number;
  index: number;
  flip: number;
  load: number;
}

export const zeroInput = (): DriverInput => ({ forward: 0, turn: 0, lift: 0, preset: null, claw: false, toggle: false, drop: 0, index: 0, flip: 0, load: 0 });

/** Lift presets (holder-bottom height, in): floor, Alliance Goal, short Goal, tall Goal. */
export const LIFT_PRESETS = [
  { key: 'floor', label: 'Floor', h: 0 },
  { key: 'alliance', label: 'Alliance Goal', h: 4.0 },
  { key: 'short', label: 'Short Goal', h: 6.5 },
  { key: 'tall', label: 'Tall Goal', h: 9.4 },
] as const;

/** Whether a human may drive now: Driver Control, or the whole run in Driver Skills. */
export function driverAllowed(sim: MatchSim): boolean {
  const per = sim.period();
  if (per === 'driver') return true;
  return per === 'skills' && sim.clock.matchType === 'skillsDriver';
}

/** Applies a DriverInput to a robot every physics step. */
export class DriverController implements Controller {
  readonly kind = 'driver';
  private last: DriverInput = zeroInput();
  private holdH: number | null = null;
  private presetH: number | null = null;

  constructor(private input: () => DriverInput | null) {}

  /** Forget edge state (e.g. when a different player takes over). */
  reset() {
    const cur = this.input() ?? zeroInput();
    this.last = { ...cur };
    this.holdH = null;
    this.presetH = null;
  }

  update(sim: MatchSim, r: SimRobot, sense: Sensing) {
    const inp = this.input() ?? zeroInput();
    // arcade drive with a small deadband
    const dz = (v: number) => (Math.abs(v) < 0.06 ? 0 : v);
    const f = dz(inp.forward);
    const t = dz(inp.turn) * 0.75;
    r.body.cmd = { left: Math.max(-1, Math.min(1, f - t)), right: Math.max(-1, Math.min(1, f + t)) };
    // lift: analog overrides, a preset runs to its height, otherwise hold where it stopped
    const minH = r.cfg.lift.holderMinHeightIn;
    if (inp.preset !== this.last.preset && inp.preset !== null) this.presetH = Math.max(minH, inp.preset);
    if (Math.abs(inp.lift) > 0.05) {
      r.body.liftManual = Math.max(-1, Math.min(1, inp.lift));
      this.presetH = null;
      this.holdH = null;
    } else {
      r.body.liftManual = null;
      if (this.presetH !== null) r.body.liftTarget = this.presetH;
      else {
        if (this.holdH === null) this.holdH = sense.holderHeight;
        r.body.liftTarget = this.holdH;
      }
    }
    // claw and mechanisms
    r.req.intake = inp.claw;
    if (inp.drop > this.last.drop) r.req.release = true;
    if (inp.index > this.last.index) r.req.index = true;
    if (inp.flip > this.last.flip) r.req.reorient = true;
    const own = sim.clock.matchType === 'headToHead' ? r.alliance : sim.opts.params.skills.ownedToggleColor;
    if (inp.toggle) {
      const tg = buildToggles().reduce((a, b) => (Math.hypot(b.pos.x - sense.pos.x, b.pos.y - sense.pos.y) < Math.hypot(a.pos.x - sense.pos.x, a.pos.y - sense.pos.y) ? b : a));
      r.req.toggle = { toggleId: tg.id, target: own };
    }
    if (inp.load > this.last.load) {
      const loaders = buildLoaders().filter((x) => sim.clock.matchType !== 'headToHead' || x.alliance === r.alliance);
      const l = loaders.reduce((a, b) => (Math.hypot(b.dispense.x - sense.pos.x, b.dispense.y - sense.pos.y) < Math.hypot(a.dispense.x - sense.pos.x, a.dispense.y - sense.pos.y) ? b : a));
      const next = [...sim.objects.objects.values()].find(
        (o) => o.mode === 'offfield' && (sim.clock.matchType !== 'headToHead' || o.matchloadAlliance === r.alliance) && !(r.primary?.kind === o.kind || r.secondary?.kind === o.kind),
      );
      if (next) r.req.matchLoad = { loaderId: l.id, objectId: next.id };
    }
    this.last = { ...inp };
  }
}

/** A bot that can hand control back after a human drove (e.g. PlanExecutor replans from the current field). */
export interface Resumable {
  resume(sim: MatchSim, r: SimRobot, reason: string): void;
}

const isResumable = (c: Controller): c is Controller & Resumable => typeof (c as Partial<Resumable>).resume === 'function';

/**
 * One robot slot: a bot, optionally taken over by a human driver. During
 * Autonomous the bot always runs (the robot's autonomous program); a human drives
 * from Driver Control on. When the human leaves, the bot resumes from the
 * current field state.
 */
export class SlotController implements Controller {
  readonly kind = 'slot';
  readonly driver: DriverController;
  private human = false;
  private botStale = false;
  private driving = false;
  /** Who is driving, for the UI ("bot" or a player name). */
  driverName: string | null = null;

  constructor(
    readonly slot: string,
    readonly bot: Controller,
    input: () => DriverInput | null,
  ) {
    this.driver = new DriverController(input);
  }

  get isHuman() {
    return this.human;
  }

  setHuman(name: string) {
    this.human = true;
    this.driverName = name;
    this.driver.reset();
  }

  setBot() {
    this.human = false;
    this.driverName = null;
  }

  update(sim: MatchSim, r: SimRobot, sense: Sensing, dt: number) {
    const drive = this.human && driverAllowed(sim);
    if (drive) {
      if (!this.driving) {
        this.driver.reset();
        r.body.liftManual = null;
      }
      this.driving = true;
      this.botStale = true;
      this.driver.update(sim, r, sense);
      return;
    }
    if (this.driving) {
      this.driving = false;
      r.body.liftManual = null;
    }
    if (this.botStale) {
      this.botStale = false;
      if (isResumable(this.bot)) this.bot.resume(sim, r, 'a driver handed the robot back');
    }
    this.bot.update(sim, r, sense, dt);
  }
}
