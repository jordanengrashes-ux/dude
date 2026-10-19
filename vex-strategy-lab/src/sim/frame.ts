import type { RobotConfig } from '../robot/config';
import type { Alliance, HalfColor } from '../rules/ruleset';
import { formatClock, isEndgame, periodAt, remaining } from '../rules/timing';
import type { Quat, V3 } from '../physics/frames';
import type { MatchSim } from './match';

/**
 * What the views need to draw one instant of a match, independent of where it
 * came from: the local physics (offline / team-mode host) or a host's network
 * snapshot (team-mode guest). World units (meters, Y up).
 */
/**
 * state 0: near the Goal, not lined up; 1: lined up but held too low (raise it);
 * 2: lined up and high enough — open the claw and it drops in. `top`: stack top (in).
 * `at` set: the target is a loose piece standing on the tiles (`goal` is its id) — a
 * Cup the held Pin would drop into, or a Pin the held Cup would drop over.
 */
export interface AlignHint {
  goal: string;
  state: 0 | 1 | 2;
  /** Top of the target (in): the rim the held piece's bottom has to clear. */
  top: number;
  /** A loose piece's position (a Goal's comes from its id). */
  at?: { x: number; y: number };
  /** How far off the target's axis the held piece may be and still drop in (in). */
  tol?: number;
  /** Where the held piece's axis is now (in). */
  from?: { x: number; y: number };
}

export interface SceneFrame {
  t: number;
  robots: {
    id: string;
    alliance: Alliance;
    cfg: RobotConfig;
    chassis: { p: V3; q: Quat };
    carriage: { p: V3; q: Quat };
    /** Holder-bottom height (in). */
    holderH: number;
    trail: { x: number; y: number }[];
    /** Claw closed (a driver's claw, or a bot holding something). */
    claw: boolean;
    /** Held kinds: 1 = Pin, 2 = Cup. */
    holding: number;
    /** Claw rollers: 1 in, −1 out, 0 stopped. */
    rollers?: number;
    /** Aligner: the Goal the held object would go on, and whether releasing now places it. */
    align: AlignHint | null;
  }[];
  /** `stacked`: Placed on (or seating onto) a Goal. */
  objects: { id: string; kind: 'pin' | 'cup'; colors?: [HalfColor, HalfColor]; p: V3 | null; q: Quat | null; stacked?: boolean }[];
  toggles: { id: string; p: V3; q: Quat }[];
}

/** Scoreboard summary shown over the field. */
export interface HudData {
  period: string;
  clock: string;
  t: number;
  headToHead: boolean;
  totals: { red: number; blue: number };
  bonus: { red: number; blue: number } | null;
  ownership: Record<'R1' | 'R2' | 'B1' | 'B2' | 'midfield', Alliance | null>;
  /** The Midfield owner shown is who would own it if the Match ended now (it is decided at the end). */
  midfieldAtEnd?: boolean;
  result: string | null;
  violations: number;
  collisions: number;
}

export function hudData(sim: MatchSim): HudData {
  const per = periodAt(sim.clock, sim.t);
  const totals = sim.displayTotals();
  const rep = sim.liveScore();
  const atEnd = sim.endOfMatchCounts();
  const rem = remaining(sim.clock, sim.t);
  const autoLeft = sim.clock.autonomousEnd !== null ? Math.max(0, sim.clock.autonomousEnd - sim.t) : 0;
  const r = sim.result;
  return {
    period: per === 'ended' ? (sim.opts.practice ? 'Practice over' : 'Match over') : sim.opts.practice ? 'Practice' : per === 'autonomous' ? 'Autonomous' : per === 'driver' ? (isEndgame(sim.clock, sim.t) ? 'Endgame' : 'Driver Control') : 'Robot Skills',
    // practice: no time limit, the clock counts up
    clock: formatClock(sim.opts.practice ? Math.floor(sim.t) : per === 'autonomous' ? autoLeft : rem),
    t: sim.t,
    headToHead: sim.clock.matchType === 'headToHead',
    totals: { red: totals.red, blue: totals.blue },
    bonus: totals.bonus,
    ownership: { R1: rep.ownership.R1 ?? null, R2: rep.ownership.R2 ?? null, B1: rep.ownership.B1 ?? null, B2: rep.ownership.B2 ?? null, midfield: (atEnd ? rep : sim.liveScore(true)).ownership.midfield ?? null },
    midfieldAtEnd: !atEnd,
    result: r ? `AWP: red ${r.awp.red.earned ? '✓' : '✗'} · blue ${r.awp.blue.earned ? '✓' : '✗'} · ${r.bonus.explanation}` : null,
    violations: sim.violations.length,
    collisions: sim.events.filter((e) => e.type === 'collision').length,
  };
}
