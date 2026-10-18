import type { Vec2 } from '../core/vec';
import { buildMatch, type ScenarioConfig } from '../sim/scenario';
import type { AutonProgram } from './program';
import type { StepRecord } from './runner';

/** What a quick run of an autonomous program did. */
export interface AutonRunResult {
  /** Robot path, sampled every 50 ms. */
  trace: { t: number; pos: Vec2; heading: number }[];
  records: StepRecord[];
  /** When the last step finished (null: still running when time ran out). */
  finishedAt: number | null;
  /** Length of the window: 15 s (match) or 60 s (Skills). */
  window: number;
  score: { red: number; blue: number };
  /** Grabs, releases and placements, in order. */
  events: { t: number; text: string }[];
  /** Rule violations (e.g. crossing the Autonomous Line). */
  violations: string[];
}

/**
 * Run a program on the physics robot until its window ends (or it has finished and
 * the pieces have settled). Yields to the browser between chunks when `yieldEvery`
 * is set, so the page stays responsive.
 */
export async function simulateProgram(sc: ScenarioConfig, program: AutonProgram, opts: { yieldEvery?: number; onProgress?: (t: number, window: number) => void } = {}): Promise<AutonRunResult> {
  const built = await buildMatch(sc, undefined, undefined, new Map());
  const sim = built.sim;
  try {
    const auton = built.autons.get(program.slot);
    if (!auton) throw new Error(`No robot runs ${program.slot}`);
    const window = sc.matchType === 'headToHead' ? sc.params.timing.autonomousSec : sc.params.timing.skillsSec;
    const chunk = opts.yieldEvery ?? 0.5;
    while (sim.t < window - 1e-9) {
      sim.runUntil(Math.min(window, sim.t + chunk));
      opts.onProgress?.(sim.t, window);
      // finished and settled: no need to simulate the idle rest of the window
      if (auton.finishedAt !== null && sim.t > auton.finishedAt + 1.5) break;
      if (opts.yieldEvery) await new Promise((r) => setTimeout(r, 0));
    }
    const s = sim.liveScore();
    return {
      trace: auton.trace.slice(),
      records: auton.records.map((r) => ({ ...r })),
      finishedAt: auton.finishedAt,
      window,
      score: { red: s.totals.red, blue: s.totals.blue },
      events: sim.events.filter((e) => e.type === 'intake' || e.type === 'release' || e.type === 'seat' || e.type === 'matchload').map((e) => ({ t: e.t, text: e.text })),
      violations: sim.violations.map((v) => `${v.ruleId} at ${v.time.toFixed(1)} s: ${v.description}`),
    };
  } finally {
    sim.dispose();
  }
}
