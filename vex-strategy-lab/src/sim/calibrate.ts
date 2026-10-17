import { buildLayout } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import { PlanWorld, type PlanConfig } from '../planner/model';
import { beamSearch } from '../planner/search/beam';
import type { OverrideParams } from '../rules/ruleset';
import { PlanExecutor } from './executor';
import { MatchSim } from './match';

/**
 * Calibrate the planner's execution overheads against the physics simulation.
 * Runs a standard Skills plan (no replanning), then compares each successful
 * action's simulated duration with the model's estimate from the same state.
 * Returns median (physics − model) per action type, added to the current values.
 */
export interface CalibrationResult {
  execution: RobotConfig['execution'];
  samples: { type: string; model: number; physics: number }[];
  physicsScore: number;
  plannedValue: number;
}

export async function calibrateExecution(robot: RobotConfig, params: OverrideParams, seed = 1, seconds = 45, runs = 4): Promise<CalibrationResult> {
  const layout = buildLayout('skillsDriver');
  const cfg: PlanConfig = {
    params,
    robot,
    layout,
    matchType: 'skillsDriver',
    robotId: 'red-1',
    alliance: 'red',
    tStart: 0,
    tEnd: seconds,
    objective: 'own',
    awpWeight: 0,
    includeAutonBonus: false,
    opponentAutoScore: 0,
    externalEvents: [],
    candidateK: 5,
    allowPark: false,
    cruiseFraction: 0.85,
    positionSigma: 0.3,
  };
  const w = new PlanWorld(cfg);
  const plan = beamSearch(w, { width: 12, alpha: 0.3 }, { maxMs: Infinity, maxExpansions: Infinity });
  // Several physics runs with small object-placement jitter; each contributes the
  // actions executed before its first failure (after that the model state diverges).
  const samples: CalibrationResult['samples'] = [];
  let score = 0;
  for (let k = 0; k < runs; k++) {
    const ex = new PlanExecutor(cfg, plan.best.actions, { enabled: false, periodicSec: 0, beamWidth: 8, candidateK: 5, maxExpansions: 1000 }, w);
    const sim = await MatchSim.create({ params, layout, robots: [{ id: 'red-1', alliance: 'red', config: robot, controller: ex, start: robot.start }], seed: seed + k, objectJitterSd: k === 0 ? 0 : 0.3 });
    sim.runUntil(seconds);
    let s = w.initialState();
    for (let i = 0; i < ex.history.length && i < plan.best.actions.length; i++) {
      const a = plan.best.actions[i];
      const h = ex.history[i];
      const r = w.apply(s, a, true);
      if (!r || !h.ok) break;
      samples.push({ type: a.type, model: r.step.tEnd - r.step.tStart, physics: h.tEnd - h.tStart });
      s = r.s;
    }
    if (k === 0) score = sim.liveScore().totals.red;
    sim.dispose();
  }
  const med = (type: string) => {
    const d = samples.filter((x) => x.type === type).map((x) => x.physics - x.model).sort((p, q) => p - q);
    return d.length ? d[Math.floor(d.length / 2)] : 0;
  };
  const e = robot.execution;
  const clampPos = (x: number) => Math.max(0, Math.round(x * 100) / 100);
  const execution = {
    pickOverheadSec: clampPos(e.pickOverheadSec + med('pick')),
    placeOverheadSec: clampPos(e.placeOverheadSec + med('place')),
    toggleOverheadSec: clampPos(e.toggleOverheadSec + med('toggle')),
    loadOverheadSec: clampPos(e.loadOverheadSec + med('load')),
    parkOverheadSec: e.parkOverheadSec,
    calibratedFrom: `Physics calibration (seeds ${seed}–${seed + runs - 1}, ${samples.length} actions) ${new Date().toISOString().slice(0, 10)}`,
  };
  return { execution, samples, physicsScore: score, plannedValue: plan.best.value };
}
