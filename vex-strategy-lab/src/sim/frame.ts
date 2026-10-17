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
  result: string | null;
  violations: number;
  collisions: number;
}

export function hudData(sim: MatchSim): HudData {
  const per = periodAt(sim.clock, sim.t);
  const totals = sim.displayTotals();
  const rep = sim.liveScore();
  const rem = remaining(sim.clock, sim.t);
  const autoLeft = sim.clock.autonomousEnd !== null ? Math.max(0, sim.clock.autonomousEnd - sim.t) : 0;
  const r = sim.result;
  return {
    period: per === 'ended' ? 'Match over' : per === 'autonomous' ? 'Autonomous' : per === 'driver' ? (isEndgame(sim.clock, sim.t) ? 'Endgame' : 'Driver Control') : 'Robot Skills',
    clock: formatClock(per === 'autonomous' ? autoLeft : rem),
    t: sim.t,
    headToHead: sim.clock.matchType === 'headToHead',
    totals: { red: totals.red, blue: totals.blue },
    bonus: totals.bonus,
    ownership: { R1: rep.ownership.R1 ?? null, R2: rep.ownership.R2 ?? null, B1: rep.ownership.B1 ?? null, B2: rep.ownership.B2 ?? null, midfield: rep.ownership.midfield ?? null },
    result: r ? `AWP: red ${r.awp.red.earned ? '✓' : '✗'} · blue ${r.awp.blue.earned ? '✓' : '✗'} · ${r.bonus.explanation}` : null,
    violations: sim.violations.length,
    collisions: sim.events.filter((e) => e.type === 'collision').length,
  };
}
