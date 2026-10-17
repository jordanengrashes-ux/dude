/**
 * Reproducible sample report.
 *
 *   npm run report            → docs/sample-report.md and docs/sample-report.json
 *   npm run report -- --quick → fewer physics trials (smoke test)
 *
 * Every number comes from a real run of the optimizer (deterministic mode: budgets
 * are iteration counts, so the same code + seed + settings reproduce the same plans
 * and model statistics) and of the Rapier physics simulation. Wall-clock times
 * (ms columns) vary by machine; plan values and statistics do not.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dist } from '../src/core/vec';
import { buildLayout, type FieldLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { PlanWorld, type PlanConfig } from '../src/planner/model';
import { DEFAULT_SETTINGS, optimize, type OptimizationReport, type OptimizerSettings } from '../src/planner/optimizer';
import { DEFAULT_UNCERTAINTY } from '../src/planner/robustness';
import { exhaustive } from '../src/planner/search/branchAndBound';
import { physicsMonteCarlo, planConfigFor, predictOthers, type PhysicsTrialStats, type ScenarioConfig } from '../src/sim/scenario';

const quick = process.argv.includes('--quick');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 1;

const settings: OptimizerSettings = {
  ...DEFAULT_SETTINGS,
  deterministic: true,
  seed: SEED,
  beamWidths: [1, 16, 64],
  mctsIterations: 1200,
  evolveGenerations: 30,
  bnbExpansions: 20000,
  robustnessTrials: 100,
};

const robot = () => cloneRobot(DEFAULT_ROBOT);

interface Section {
  title: string;
  description: string;
  report: OptimizationReport;
  physics: PhysicsTrialStats | null;
  /** Physics of the practical (expected-score) plan when it differs from the recommended one. */
  physicsAlt: PhysicsTrialStats | null;
  physicsTrials: number;
  exhaustiveValue?: number;
  exhaustiveNodes?: number;
}

function skillsScenario(): ScenarioConfig {
  return {
    params: cloneParams(OVERRIDE_DEFAULTS),
    layout: buildLayout('skillsDriver'),
    matchType: 'skillsDriver',
    seed: SEED,
    slots: [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot: robot() }],
  };
}

function h2hScenario(): ScenarioConfig {
  return {
    params: cloneParams(OVERRIDE_DEFAULTS),
    layout: buildLayout('headToHead'),
    matchType: 'headToHead',
    seed: SEED,
    aiBeamWidth: 10,
    slots: [
      { slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot: robot() },
      { slot: 'red-2', alliance: 'red', enabled: true, strategy: 'midfield', robot: robot() },
      { slot: 'blue-1', alliance: 'blue', enabled: true, strategy: 'optimized', robot: robot() },
      { slot: 'blue-2', alliance: 'blue', enabled: true, strategy: 'toggles', robot: robot() },
    ],
  };
}

/** Small scenario where branch-and-bound can prove optimality (3 Pins, 1 Cup, 2 Goals, 1 Toggle, 20 s). */
function tinyConfig(): PlanConfig {
  const sc = skillsScenario();
  const layout: FieldLayout = sc.layout;
  const start = layout.robots[0].pos;
  const nearest = (list: typeof layout.pins | typeof layout.cups, n: number) =>
    list
      .filter((o) => o.start.where === 'field')
      .map((o) => ({ id: o.id, d: dist((o.start as { pos: { x: number; y: number } }).pos, start) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => x.id);
  const ids = new Set([...nearest(layout.pins, 3), ...nearest(layout.cups, 1)]);
  return planConfigFor(sc, sc.slots[0], [], {
    tEnd: 20,
    candidateK: Infinity,
    allowPark: false,
    objectFilter: (o) => ids.has(o.id),
    goalFilter: (g) => g.id === 'G-R1a' || g.id === 'G-R1n',
    toggleFilter: (t) => t.id === 'T-R1',
  });
}

/** Physics Monte Carlo of the recommended plan, and of the practical plan too when it is a different plan. */
async function validate(sc: ScenarioConfig, report: OptimizationReport, trials: number, tag: string): Promise<[PhysicsTrialStats, PhysicsTrialStats | null]> {
  const rec = report.recommended === 'best' ? report.best : report.practical;
  const alt = report.recommended === 'best' ? report.practical : report.best;
  const runPlan = async (plan: typeof rec, name: string) => {
    sc.slots[0].plan = plan.actions;
    return physicsMonteCarlo(sc, 'red-1', DEFAULT_UNCERTAINTY, trials, SEED, null, (k, s) => console.log(`  ${tag} ${name} physics trial ${k + 1}/${trials}: ${s}`));
  };
  const a = await runPlan(rec, rec.id);
  const b = alt.id !== rec.id ? await runPlan(alt, alt.id) : null;
  return [a, b];
}

async function run(): Promise<Section[]> {
  const out: Section[] = [];

  // 1. Exact small scenario: proof + exhaustive cross-check.
  {
    const cfg = tinyConfig();
    const report = await optimize(cfg, settings);
    const ex = exhaustive(new PlanWorld(cfg), 5_000_000);
    if (!ex.complete) throw new Error(`exhaustive enumeration did not finish (${ex.nodes} nodes)`);
    out.push({
      title: 'Exact small scenario (proof of optimality)',
      description: 'Driver Skills field, 20-second window, restricted to the 3 Pins and 1 Cup nearest the start, Goals G-R1a and G-R1n and Toggle T-R1. Small enough for branch-and-bound to finish, and cross-checked against exhaustive enumeration of every action sequence.',
      report,
      physics: null,
      physicsAlt: null,
      physicsTrials: 0,
      exhaustiveValue: ex.value,
      exhaustiveNodes: ex.nodes,
    });
    console.log('tiny', report.optimality.status, report.optimality.bestValue, 'exhaustive', ex.value, ex.nodes, 'nodes');
  }

  // 2. Driver Skills, full field.
  {
    const sc = skillsScenario();
    const cfg = planConfigFor(sc, sc.slots[0], [], { candidateK: 6 });
    const report = await optimize(cfg, settings);
    const trials = quick ? 2 : 8;
    const [physics, physicsAlt] = await validate(sc, report, trials, 'skills');
    out.push({
      title: 'Driver Skills — full field (60 s)',
      description: 'One robot, every Pin and Cup, the Skills Match Loads (3 red/yellow + 4 blue/yellow Pins, 7 Cups), the default robot (16 × 16 in, 4-motor 450 rpm drive on 3.25 in wheels, rack-and-pinion lift).',
      report,
      physics,
      physicsAlt,
      physicsTrials: trials,
    });
    console.log('skills', report.optimality.bestValue, 'physics mean', physics.mean);
  }

  // 3. Head-to-Head, red-1 planning around three other robots.
  {
    const sc = h2hScenario();
    const events = predictOthers(sc, 'red-1');
    const cfg = planConfigFor(sc, sc.slots[0], events, { candidateK: 6 });
    const report = await optimize(cfg, settings);
    const trials = quick ? 1 : 4;
    const [physics, physicsAlt] = await validate(sc, report, trials, 'h2h');
    out.push({
      title: 'Head-to-Head — red-1 with a Midfield partner vs. an optimized robot and a Toggle patrol (2 min)',
      description: `red-1 is optimized for its own alliance score including the Autonomous Bonus. Its planner models the other three robots through ${events.length} predicted events: red-2 parks in the Midfield, blue-1 runs its own beam-search plan, blue-2 patrols the four Toggles all match. In the physics runs all four robots drive simultaneously and red-1 replans online (MPC).`,
      report,
      physics,
      physicsAlt,
      physicsTrials: trials,
    });
    console.log('h2h', report.optimality.bestValue, 'physics mean', physics.mean);
  }
  return out;
}

function fmt(x: number, d = 1) {
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

function markdown(sections: Section[], meta: Record<string, string>): string {
  const L: string[] = [];
  L.push('# VEX V5 Strategy Lab — sample report (V5RC Override, manual v2.1)');
  L.push('');
  L.push('Generated by `npm run report` (`scripts/sample-report.ts`). Every value below comes from the optimizer and the physics simulation in this repository; nothing is hand-entered.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(meta)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('**How to read this.** *Model* values come from the planner\'s macro-action model (drive times from the motor/traction model over planned paths, calibrated mechanism overheads, scoring by the rules engine). *Physics* values come from running the plan in the Rapier simulation with sampled motor, traction, battery, sensor and object-placement noise; the robot follows the plan with real controllers and replans when something fails. "Verified optimum" is only claimed when branch-and-bound exhausted the stated search space; otherwise the report gives the best plan found and the admissible upper bound.');
  L.push('');
  for (const s of sections) {
    const r = s.report;
    const o = r.optimality;
    L.push(`## ${s.title}`);
    L.push('');
    L.push(s.description);
    L.push('');
    L.push(`- **Result:** ${o.status === 'verified-optimum' ? '**verified optimum** within the model' : '**best found** (not proven optimal)'} — ${o.bestValue} points (model).`);
    if (o.status !== 'verified-optimum') L.push(`- **Admissible upper bound:** ${fmt(o.upperBound)} points, gap ${fmt(o.gap)}. The true optimum of the model lies in [${o.bestValue}, ${fmt(o.upperBound)}].`);
    if (s.exhaustiveValue !== undefined) L.push(`- **Exhaustive enumeration** (${s.exhaustiveNodes} action sequences): ${s.exhaustiveValue} points — ${s.exhaustiveValue === o.bestValue ? 'matches' : 'DOES NOT match'} the optimizer.`);
    L.push(`- **Recommended plan:** ${r.recommended === 'best' ? `${r.best.id} (highest theoretical score)` : `${r.practical.id} (highest expected score)`}; search stopped: ${r.stoppedBy}.`);
    L.push('');
    L.push('Search methods:');
    L.push('');
    L.push('| Method | Best | Expansions | ms (varies) | Stopped by |');
    L.push('|---|---:|---:|---:|---|');
    for (const m of r.methods) L.push(`| ${m.method} | ${Number.isFinite(m.best) ? m.best : '—'} | ${m.expansions} | ${m.ms.toFixed(0)} | ${m.stoppedBy}${m.proven ? ' (proof)' : ''} |`);
    L.push('');
    const plan = r.recommended === 'best' ? r.best : r.practical;
    L.push(`Recommended plan (${plan.id}, ${plan.method}): ${plan.summary.placements} placements, ${plan.summary.toggles} Toggle actions, ${fmt(plan.summary.distance, 0)} in driven, ${plan.summary.parks ? 'ends in the Midfield' : 'does not park'}.`);
    L.push('');
    L.push('| # | Start (s) | End (s) | Action | Score after (model) |');
    L.push('|---:|---:|---:|---|---:|');
    plan.steps.forEach((st, i) => L.push(`| ${i + 1} | ${st.tStart.toFixed(2)} | ${st.tEnd.toFixed(2)} | ${st.label} | ${st.valueAfter} |`));
    L.push('');
    if (r.explanation.versusRunnerUp.length) {
      L.push('Why it beats the runner-up:');
      L.push('');
      for (const t of r.explanation.versusRunnerUp) L.push(`- ${t}`);
      L.push('');
    }
    const rb = plan.robustness;
    if (rb) {
      L.push(`Model Monte Carlo (${rb.trials} trials, seed ${rb.seed}): mean ${fmt(rb.mean)}, median ${rb.median}, worst ${rb.worst}, best ${rb.best}, SD ${fmt(rb.sd)}.`);
      L.push('');
    }
    const physicsLines = (p: PhysicsTrialStats, pl: typeof plan, what: string) => {
      L.push(`Physics validation of ${what} (${s.physicsTrials} full simulations, seed ${SEED}): scores ${p.scores.join(', ')} → mean ${fmt(p.mean)}, median ${p.median}, worst ${p.worst}, best ${p.best}, SD ${fmt(p.sd)}; ${fmt(p.meanReplans)} replans per match on average.`);
      if (p.failures.length) L.push(`Most common failed actions: ${p.failures.slice(0, 5).map((f) => `${f.label} (${f.count}×)`).join('; ')}.`);
      if (p.violations.length) L.push(`Rule violations by red-1: ${p.violations.map((v) => `${v.ruleId} ×${v.count}`).join(', ')}.`);
      else L.push('No rule violations by red-1.');
      L.push(`Physics vs. model: ${fmt(p.mean - pl.value)} points on average (${fmt((100 * (p.mean - pl.value)) / Math.max(1, pl.value), 0)}%).`);
      L.push('');
    };
    if (s.physics) physicsLines(s.physics, plan, `the recommended plan ${plan.id}`);
    if (s.physicsAlt) {
      const alt = r.recommended === 'best' ? r.practical : r.best;
      L.push(`For comparison, the ${r.recommended === 'best' ? 'practical-best' : 'theoretical-best'} plan ${alt.id} (${alt.method}) scores ${alt.value} in the model${alt.robustness ? ` (model Monte Carlo mean ${fmt(alt.robustness.mean)}, SD ${fmt(alt.robustness.sd)})` : ''}.`);
      L.push('');
      physicsLines(s.physicsAlt, alt, `${alt.id}`);
    }
  }
  L.push('## Limitations that affect these numbers');
  L.push('');
  L.push('- Rules were taken from search-engine extracts of the official manual (v2.1) and Q&A; the official sites could not be opened from the build environment. See the Rules tab / `src/rules/ruleset.ts` for per-rule provenance.');
  L.push('- Field element positions follow the published dimensions where found and a symmetric layout otherwise (marked as assumptions in `src/field/geometry.ts`).');
  L.push('- The robot is the default configuration (16 × 16 in, 4WD, rack-and-pinion); unknown dimensions, gearing, masses and friction are assumptions, editable in the Robot tab.');
  L.push('- Other robots are modeled in the planner as predicted events; in the physics runs they react only as their scripts allow. Interaction (blocking, pushing, contested objects) is simulated physically but not anticipated beyond the prediction.');
  L.push('- Physics clutter (plowed or wedged objects) is genuine simulation behavior and is the main source of the model-vs-physics gap.');
  L.push('');
  return L.join('\n');
}

const t0 = Date.now();
const sections = await run();
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {
  /* not a git checkout */
}
const meta = {
  'Ruleset': `${OVERRIDE_DEFAULTS.name} ${OVERRIDE_DEFAULTS.season}, manual v${OVERRIDE_DEFAULTS.manualVersion}`,
  'Code version': `git ${commit} (plus any uncommitted changes)`,
  'Optimizer settings': `deterministic, seed ${settings.seed}, beam widths ${settings.beamWidths.join('/')}, MCTS ${settings.mctsIterations} iterations, evolution ${settings.evolveGenerations} generations, B&B ${settings.bnbExpansions} expansions, model Monte Carlo ${settings.robustnessTrials} trials`,
  'Physics uncertainty': `motor SD ${DEFAULT_UNCERTAINTY.motorSd * 100}%, traction SD ${DEFAULT_UNCERTAINTY.tractionSd * 100}%, battery ${DEFAULT_UNCERTAINTY.batteryMin}–${DEFAULT_UNCERTAINTY.batteryMax} V, object placement SD ${DEFAULT_UNCERTAINTY.objectPosSd} in`,
  'Run time': `${((Date.now() - t0) / 1000).toFixed(0)} s on ${process.platform}/${process.arch}, Node ${process.version}`,
};
mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(resolve(root, 'docs/sample-report.md'), markdown(sections, meta));
const slim = sections.map((s) => ({
  title: s.title,
  optimality: s.report.optimality,
  exhaustiveValue: s.exhaustiveValue ?? null,
  settings: s.report.settings,
  scenario: s.report.scenario,
  methods: s.report.methods,
  recommended: s.report.recommended,
  plan: (s.report.recommended === 'best' ? s.report.best : s.report.practical).steps.map((st) => ({ label: st.label, tStart: st.tStart, tEnd: st.tEnd, valueAfter: st.valueAfter, risk: st.risk })),
  robustness: (s.report.recommended === 'best' ? s.report.best : s.report.practical).robustness ?? null,
  physics: s.physics,
  physicsAlt: s.physicsAlt,
}));
writeFileSync(resolve(root, 'docs/sample-report.json'), JSON.stringify({ meta, sections: slim }, null, 2));
console.log('wrote docs/sample-report.md and docs/sample-report.json');
