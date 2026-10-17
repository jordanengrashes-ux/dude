import type { Period } from './fieldState';
import type { MatchType, OverrideParams } from './ruleset';

/**
 * Match clock. Time `t` is seconds since the start of the first period.
 * Head-to-Head: [0, auto) Autonomous → (pause, modeled as instant) → [auto, auto+driver) Driver.
 * Skills: one 60 s period (driver or autonomous coding).
 */

export interface Phase {
  period: Period;
  start: number;
  end: number;
}

export interface MatchClock {
  matchType: MatchType;
  phases: Phase[];
  total: number;
  autonomousEnd: number | null;
  endgameStart: number;
}

export function buildClock(matchType: MatchType, params: OverrideParams): MatchClock {
  const T = params.timing;
  if (matchType === 'headToHead') {
    const autoEnd = T.autonomousSec;
    const total = T.autonomousSec + T.driverSec;
    return {
      matchType,
      phases: [
        { period: 'autonomous', start: 0, end: autoEnd },
        { period: 'driver', start: autoEnd, end: total },
      ],
      total,
      autonomousEnd: autoEnd,
      endgameStart: total - T.endgameSec,
    };
  }
  return {
    matchType,
    phases: [{ period: 'skills', start: 0, end: T.skillsSec }],
    total: T.skillsSec,
    autonomousEnd: null,
    endgameStart: T.skillsSec - T.endgameSec,
  };
}

export function periodAt(clock: MatchClock, t: number): Period | 'ended' {
  for (const p of clock.phases) if (t >= p.start && t < p.end) return p.period;
  return 'ended';
}

export function isEndgame(clock: MatchClock, t: number): boolean {
  return t >= clock.endgameStart && t < clock.total;
}

export function remaining(clock: MatchClock, t: number): number {
  return Math.max(0, clock.total - t);
}

/** Format seconds-remaining the way a field display shows it (m:ss). */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
