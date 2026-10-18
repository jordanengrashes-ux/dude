import { buildLoaders, buildToggles } from '../field/geometry';
import type { Controller, MatchSim, Sensing, SimRobot } from './match';

/**
 * Human driver control and bot ↔ human hand-over.
 *
 * DriverInput is the whole control surface of a robot, the same for keyboard,
 * mouse, gamepad and remote players: arcade drive, the lift (analog up/down or a
 * height preset), the claw (closing grabs what is in front, opening lets go; drop
 * also opens it), the toggle arm, pocket index, flip and a Match Load request.
 * One-shot actions are press counters, so a press is never lost when inputs are
 * sampled once per physics step or arrive over the network.
 */

export interface DriverInput {
  /** Arcade drive, −1…1. */
  forward: number;
  turn: number;
  /** Lift: + raises, − lowers the arm (−1…1). */
  lift: number;
  /** Holder height preset (in) to move the lift to; null when none. Analog lift input cancels it. */
  preset: number | null;
  /** Claw toggle: every change opens / closes the claw (closing grabs what is in front, opening lets go). */
  claw: boolean;
  /** Easy mode: the claw grabs whatever the robot drives into (and Goals capture more loosely). */
  easy: boolean;
  /** No momentum: the robot goes exactly as fast as the sticks say and stops when released. */
  noMomentum: boolean;
  /** Toggle arm engaged while held (works the nearest Toggle toward this robot's color). */
  toggle: boolean;
  /** Press counters. */
  drop: number;
  index: number;
  flip: number;
  load: number;
}

export const zeroInput = (): DriverInput => ({ forward: 0, turn: 0, lift: 0, preset: null, claw: false, easy: false, noMomentum: false, toggle: false, drop: 0, index: 0, flip: 0, load: 0 });

/** Lift presets (holder-bottom height, in): floor, Alliance Goal, short Goal, tall Goal. */
export const LIFT_PRESETS = [
  { key: 'floor', label: 'Floor', h: 0 },
  { key: 'alliance', label: 'Alliance Goal', h: 4.0 },
  { key: 'short', label: 'Short Goal', h: 6.5 },
  { key: 'tall', label: 'Tall Goal', h: 9.4 },
] as const;

/**
 * Arcade mix with a small deadband. When forward + turn would exceed full power,
 * both sides are scaled down together (the turn is kept), so the robot still turns
 * while driving: full forward + full turn drives one side and holds the other.
 */
export function arcade(forward: number, turn: number): { left: number; right: number } {
  const dz = (v: number) => (Math.abs(v) < 0.06 ? 0 : v);
  const f = dz(forward);
  const t = dz(turn) * (0.6 + 0.4 * Math.abs(f)); // gentle in place for aiming, more at speed where the wheels scrub harder
  const k = Math.max(1, Math.abs(f) + Math.abs(t));
  return { left: (f - t) / k, right: (f + t) / k };
}

/** Whether a human may drive now: Driver Control, or the whole run in Driver Skills. */
export function driverAllowed(sim: MatchSim): boolean {
  if (sim.opts.practice) return sim.period() !== 'ended';
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
  /** The claw: closed or open (flipped by every change of the input's claw toggle). */
  private clawClosed = false;
  /** Take the claw state from what the robot holds at the next update (after a hand-over). */
  private syncClaw = true;
  /** The claw is closing on something until this time (s). */
  private grabUntil = -1;
  /** Easy mode: no automatic grab until this time (just let go of something). */
  private easyHoldOff = -1;

  constructor(private input: () => DriverInput | null) {}

  /** Forget edge state (e.g. when a different player takes over). */
  reset() {
    const cur = this.input() ?? zeroInput();
    this.last = { ...cur };
    this.holdH = null;
    this.presetH = null;
    this.grabUntil = -1;
    this.easyHoldOff = -1;
    this.syncClaw = true;
  }

  update(sim: MatchSim, r: SimRobot, sense: Sensing) {
    const inp = this.input() ?? zeroInput();
    r.body.cmd = arcade(inp.forward, inp.turn);
    r.body.direct = inp.noMomentum;
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
    // claw: each toggle flips it — closing grabs what is in front (the intake runs
    // briefly), opening lets go. A robot taken over while holding something has its
    // claw closed; in easy mode the claw is closed exactly when it holds something.
    const holding = !!(r.primary || r.secondary);
    if (this.syncClaw || inp.easy) {
      this.clawClosed = holding;
      this.syncClaw = false;
    }
    let opened = false;
    if (inp.claw !== this.last.claw) {
      this.clawClosed = !this.clawClosed;
      if (this.clawClosed) this.grabUntil = sim.t + 0.3; // the jaws closing
      else opened = true;
    }
    if (inp.drop > this.last.drop) {
      this.clawClosed = false;
      opened = true;
    }
    if (opened) {
      r.req.release = true;
      this.easyHoldOff = sim.t + 1.5; // don't grab back what was just dropped
    }
    // easy mode: the claw takes whatever the robot drives into (never off a Goal)
    const auto = inp.easy && sim.t >= this.easyHoldOff;
    r.req.intake = sim.t < this.grabUntil || auto;
    if (auto && !(sim.t < this.grabUntil)) r.req.noDescore = true;
    // a real claw takes only what is between its jaws; easy mode keeps the wide grab
    r.req.precise = !inp.easy;
    r.easy = inp.easy;
    r.clawClosed = this.clawClosed;
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
      r.clawClosed = null;
      r.easy = false;
      r.body.direct = false;
    }
    if (this.botStale) {
      this.botStale = false;
      if (isResumable(this.bot)) this.bot.resume(sim, r, 'a driver handed the robot back');
    }
    this.bot.update(sim, r, sense, dt);
  }
}
