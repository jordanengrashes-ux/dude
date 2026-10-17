import { writeFileSync } from 'node:fs';
import { planScenario, type PlanningStats } from '../src/sim/scenario';
import { scenarioKey, serializePlans } from '../src/sim/planCache';
import { SimRunner } from '../src/ui/simRunner';
import { store } from '../src/ui/store';

/**
 * Precompute the default scenario's plans (every robot, both alliances) so the app
 * starts without planning. Run after changing the planner, the robot defaults or
 * the default scenario: npm run plans. tests/plans.test.ts checks they are current.
 */
const s = store.get();
const sc = new SimRunner().scenarioFrom(s);
const stats = {} as PlanningStats;
const t0 = Date.now();
const plans = planScenario(sc, s.userSlot, { stats });
const stored = serializePlans(scenarioKey(sc, s.userSlot), plans, stats);
writeFileSync(new URL('../src/sim/defaultPlans.json', import.meta.url), JSON.stringify(stored) + '\n');
console.log(`planned in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(stats)}`);
