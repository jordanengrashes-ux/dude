import type { ScoreReport } from '../rules/scoring';
import { compareRoutes, explainPlan, summarizeSteps, type RouteSummary, type StepExplanation } from './explain';
import { PlanWorld, type Action, type PlanConfig, type StepInfo } from './model';
import { DEFAULT_UNCERTAINTY, evaluateRobustness, type RobustnessStats, type UncertaintyConfig } from './robustness';
import { beamSearch } from './search/beam';
import { upperBoundAdd } from './search/bounds';
import { branchAndBound } from './search/branchAndBound';
import { addToPool, planKey, replay, type Candidate, type SearchStats } from './search/common';
import { evolve } from './search/evolve';
import { mcts } from './search/mcts';

/**
 * Strategy optimizer: runs complementary search methods under one time budget,
 * keeps the best plan found so far, attempts a proof of optimality with
 * branch-and-bound, and selects a "practical best" by Monte Carlo robustness.
 *
 *  - Beam search: broad, fast exploration of action combinations.
 *  - MCTS: stochastic sequential decision search, escapes beam myopia.
 *  - Evolutionary refinement: local re-ordering / re-targeting of the best plans.
 *  - Branch-and-bound: exact search with an admissible bound → proof or gap.
 *
 * The optimizer never claims a global optimum unless branch-and-bound exhausted
 * the (stated, finite) search space.
 */

export interface OptimizerSettings {
  budgetMs: number;
  /**
   * Deterministic mode: budgets are counted in iterations/expansions instead of
   * wall-clock time, so the same seed and settings reproduce the same report.
   */
  deterministic: boolean;
  /** Branch-and-bound node budget in deterministic mode. */
  bnbExpansions: number;
  seed: number;
  beamWidths: number[];
  beamAlpha: number;
  mctsIterations: number;
  evolveGenerations: number;
  evolvePopulation: number;
  evolveOffspring: number;
  /** Fraction of the budget reserved for the branch-and-bound proof attempt. */
  bnbShare: number;
  robustnessTrials: number;
  robustnessCandidates: number;
  uncertainty: UncertaintyConfig;
  objectiveMode: 'theoretical' | 'expected';
  targetScore: number | null;
  explainAlternatives: number;
}

export const DEFAULT_SETTINGS: OptimizerSettings = {
  budgetMs: 20000,
  deterministic: false,
  bnbExpansions: 20000,
  seed: 1,
  beamWidths: [1, 16, 64, 200],
  beamAlpha: 0.3,
  mctsIterations: 4000,
  evolveGenerations: 60,
  evolvePopulation: 16,
  evolveOffspring: 24,
  bnbShare: 0.2,
  robustnessTrials: 120,
  robustnessCandidates: 5,
  uncertainty: DEFAULT_UNCERTAINTY,
  objectiveMode: 'theoretical',
  targetScore: null,
  explainAlternatives: 2,
};

export interface OptimizerProgress {
  phase: string;
  elapsedMs: number;
  best: number;
  bestMethod: string;
  upperBound: number;
}

export interface OptimizerHooks {
  onProgress?: (p: OptimizerProgress) => void;
  /** Awaited between work slices: implement pause/resume here; return false to stop. */
  checkpoint?: () => Promise<boolean>;
  /** Set cancelled=true to stop the current slice early. */
  signal?: { cancelled: boolean };
}

export interface PlanSummary {
  id: string;
  method: string;
  actions: Action[];
  steps: StepInfo[];
  value: number;
  finalReport: ScoreReport;
  autonomous?: { own: number; opp: number; awp: boolean };
  summary: RouteSummary;
  robustness?: RobustnessStats;
}

export interface OptimizationReport {
  createdAt: string;
  settings: OptimizerSettings;
  scenario: {
    matchType: string;
    alliance: string;
    robotId: string;
    window: [number, number];
    objective: string;
    awpWeight: number;
    includeAutonBonus: boolean;
    externalEvents: number;
  };
  searchSpace: string[];
  methods: SearchStats[];
  history: { ms: number; best: number; method: string }[];
  best: PlanSummary;
  practical: PlanSummary;
  recommended: 'best' | 'practical';
  candidates: PlanSummary[];
  optimality: {
    status: 'verified-optimum' | 'best-found';
    bestValue: number;
    upperBound: number;
    gap: number;
    explanation: string;
  };
  explanation: { steps: StepExplanation[]; versusRunnerUp: string[] };
  stoppedBy: 'completed' | 'budget' | 'cancelled';
  durationMs: number;
}

export function describeSearchSpace(w: PlanWorld): string[] {
  const c = w.cfg;
  return [
    `Macro-actions: pick (the ${isFinite(c.candidateK) ? c.candidateK : 'all'} nearest available objects of each kind), load (own Loaders, one per object type), place (every legal Goal × orientation), toggle (each non-owned Toggle), park (Midfield), wait (to Driver Control).`,
    `${w.objs.length} objects (${w.objs.filter((o) => o.kind === 'pin').length} Pins, ${w.objs.filter((o) => o.kind === 'cup').length} Cups), ${w.goals.length} Goals, ${w.toggles.length} Toggles, window ${c.tStart}–${c.tEnd} s.`,
    `Durations from the robot model (motor curves, traction, lift speed) over visibility-graph paths; approach headings discretized to 30°.`,
    `Legality: SG7 (Autonomous side), SG9 (opposing Alliance Goals), SG12 (Midfield Goal in Endgame), possession ≤ 1 Pin + 1 Cup, lift reach and the vertical limit.`,
    `Objective: ${c.objective === 'own' ? 'own alliance score' : 'score margin'}${c.includeAutonBonus ? ' + Autonomous Bonus' : ''}${c.awpWeight ? ` + ${c.awpWeight}-point value for the AWP` : ''}.`,
  ];
}

function summarize(w: PlanWorld, c: Candidate, id: string): PlanSummary {
  const rp = replay(w, c.actions, true);
  const fin = w.finalize(rp.state);
  return {
    id,
    method: c.method,
    actions: rp.actions,
    steps: rp.steps,
    value: w.value(fin),
    finalReport: w.score(fin, true),
    autonomous: fin.auto ? { own: fin.auto.own, opp: fin.auto.opp, awp: fin.auto.awp } : undefined,
    summary: summarizeSteps(rp.steps, w.value(fin)),
  };
}

export async function optimize(cfg: PlanConfig, settings: OptimizerSettings = DEFAULT_SETTINGS, hooks: OptimizerHooks = {}): Promise<OptimizationReport> {
  const t0 = performance.now();
  const w = new PlanWorld(cfg);
  const root = w.initialState();
  const rootUB = w.value(root) + upperBoundAdd(w, root);
  const pool: Candidate[] = [];
  const methods: SearchStats[] = [];
  const history: OptimizationReport['history'] = [];
  let best: Candidate = { actions: [], value: w.value(root), method: 'idle' };
  let upperBound = rootUB;
  let stoppedBy: OptimizationReport['stoppedBy'] = 'completed';
  const signal = hooks.signal ?? { cancelled: false };
  const elapsed = () => performance.now() - t0;
  const remaining = () => Math.max(0, settings.budgetMs - elapsed());
  const report = (phase: string) => hooks.onProgress?.({ phase, elapsedMs: elapsed(), best: best.value, bestMethod: best.method, upperBound });
  const consider = (c: Candidate) => {
    addToPool(pool, c, 24);
    if (c.value > best.value) {
      best = c;
      history.push({ ms: elapsed(), best: c.value, method: c.method });
    }
  };
  const gate = async (): Promise<boolean> => {
    if (signal.cancelled) {
      stoppedBy = 'cancelled';
      return false;
    }
    if (hooks.checkpoint && !(await hooks.checkpoint())) {
      stoppedBy = 'cancelled';
      return false;
    }
    if (!settings.deterministic && remaining() <= 0) {
      stoppedBy = 'budget';
      return false;
    }
    return true;
  };
  const D = settings.deterministic;
  const ms = (x: number) => (D ? Infinity : x);
  const searchBudget = settings.budgetMs * (1 - settings.bnbShare);
  report('start');

  // 1. Beam search at increasing widths
  for (const width of settings.beamWidths) {
    if (!(await gate())) break;
    const slice = Math.min(remaining(), Math.max(500, searchBudget * 0.2));
    const r = beamSearch(w, { width, alpha: settings.beamAlpha }, { maxMs: ms(slice), maxExpansions: Infinity, signal });
    methods.push(r.stats);
    for (const c of r.pool) consider(c);
    consider(r.best);
    report(`beam w=${width}`);
  }

  // 2. MCTS in slices
  let mctsDone = 0;
  const mctsSliceIters = 400;
  const mctsStart = elapsed();
  const mctsTotal = { expansions: 0, ms: 0, best: -Infinity };
  while (mctsDone < settings.mctsIterations && (D || elapsed() - mctsStart < searchBudget * 0.25)) {
    if (!(await gate())) break;
    const r = mcts(
      w,
      { iterations: mctsSliceIters, exploration: 0.7, rolloutEpsilon: 0.25, seed: settings.seed * 7919 + mctsDone, maxRolloutDepth: 80 },
      { maxMs: ms(Math.min(remaining(), 1500)), maxExpansions: Infinity, signal },
    );
    mctsDone += mctsSliceIters;
    mctsTotal.expansions += r.stats.expansions;
    mctsTotal.ms += r.stats.ms;
    mctsTotal.best = Math.max(mctsTotal.best, r.best.value);
    for (const c of r.pool) consider(c);
    report(`mcts ${mctsDone}`);
  }
  methods.push({ method: `mcts(${mctsDone} iterations in slices of ${mctsSliceIters})`, expansions: mctsTotal.expansions, evaluations: w.evaluations, ms: mctsTotal.ms, stoppedBy: 'completed', best: mctsTotal.best });

  // 3. Evolutionary refinement seeded by the pool
  let gens = 0;
  let seeds = pool.slice(0, 8);
  const evoStart = elapsed();
  const evoTotal = { expansions: 0, ms: 0, best: -Infinity };
  while (gens < settings.evolveGenerations && (D || elapsed() - evoStart < searchBudget * 0.25)) {
    if (!(await gate())) break;
    const r = evolve(
      w,
      seeds,
      { generations: 10, population: settings.evolvePopulation, offspring: settings.evolveOffspring, seed: settings.seed * 104729 + gens },
      { maxMs: ms(Math.min(remaining(), 1500)), maxExpansions: Infinity, signal },
    );
    gens += 10;
    evoTotal.expansions += r.stats.expansions;
    evoTotal.ms += r.stats.ms;
    evoTotal.best = Math.max(evoTotal.best, r.best.value);
    for (const c of r.pool) consider(c);
    seeds = pool.slice(0, 8);
    report(`evolve ${gens}`);
  }
  methods.push({ method: `evolutionary(${gens} generations)`, expansions: evoTotal.expansions, evaluations: w.evaluations, ms: evoTotal.ms, stoppedBy: 'completed', best: evoTotal.best });

  // 4. Branch-and-bound proof attempt with the incumbent
  let proven = false;
  if (await gate()) {
    const r = branchAndBound(
      w,
      { epsilon: 1e-6, incumbent: best },
      { maxMs: ms(Math.max(200, remaining() * 0.8)), maxExpansions: D ? settings.bnbExpansions : Infinity, signal },
    );
    methods.push(r.stats);
    for (const c of r.pool) consider(c);
    proven = !!r.stats.proven;
    upperBound = proven ? best.value : Math.min(upperBound, r.stats.rootBound ?? upperBound);
    report('branch&bound');
  }

  // 5. Robustness (Monte Carlo) on the top distinct candidates → practical best
  const distinct: Candidate[] = [];
  for (const c of [best, ...pool]) if (!distinct.some((d) => planKey(d.actions) === planKey(c.actions))) distinct.push(c);
  const top = distinct.slice(0, Math.max(1, settings.robustnessCandidates));
  const summaries = top.map((c, i) => summarize(w, c, `S${i + 1}`));
  if (settings.robustnessTrials > 0) {
    for (const sm of summaries) {
      sm.robustness = evaluateRobustness(cfg, sm.actions, settings.uncertainty, settings.robustnessTrials, settings.seed + 17, settings.targetScore, w);
    }
  }
  const bestSummary = summaries.reduce((a, b) => (b.value > a.value ? b : a));
  const practicalScore = (s: PlanSummary) => {
    const r = s.robustness;
    if (!r) return s.value;
    if (settings.targetScore !== null && r.pTarget !== null) return r.pTarget * 1000 + r.mean;
    return r.mean - 0.25 * r.sd;
  };
  const practical = summaries.reduce((a, b) => (practicalScore(b) > practicalScore(a) ? b : a));
  const recommended = settings.objectiveMode === 'expected' ? 'practical' : 'best';
  const chosen = recommended === 'best' ? bestSummary : practical;
  const runnerUp = summaries.filter((s) => s !== chosen).sort((a, b) => b.value - a.value)[0];
  const exp = explainPlan(w, chosen.actions, { alternatives: settings.explainAlternatives, maxAltSteps: 12 });

  const bestValue = bestSummary.value;
  const ub = proven ? bestValue : Math.max(bestValue, upperBound);
  return {
    createdAt: new Date().toISOString(),
    settings,
    scenario: {
      matchType: cfg.matchType,
      alliance: cfg.alliance,
      robotId: cfg.robotId,
      window: [cfg.tStart, cfg.tEnd],
      objective: cfg.objective,
      awpWeight: cfg.awpWeight,
      includeAutonBonus: cfg.includeAutonBonus,
      externalEvents: cfg.externalEvents.length,
    },
    searchSpace: describeSearchSpace(w),
    methods,
    history,
    best: bestSummary,
    practical,
    recommended,
    candidates: summaries,
    optimality: {
      status: proven ? 'verified-optimum' : 'best-found',
      bestValue,
      upperBound: ub,
      gap: ub - bestValue,
      explanation: proven
        ? 'Branch-and-bound exhausted the stated finite search space: no plan in this model scores higher.'
        : `Best found within the budget. The admissible bound says no plan in this model can exceed ${ub.toFixed(1)}; the true optimum lies in [${bestValue}, ${ub.toFixed(1)}].`,
    },
    explanation: { steps: exp.steps, versusRunnerUp: runnerUp ? compareRoutes(chosen.summary, runnerUp.summary) : [] },
    stoppedBy,
    durationMs: elapsed(),
  };
}
