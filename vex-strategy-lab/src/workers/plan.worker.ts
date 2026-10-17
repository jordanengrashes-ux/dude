/// <reference lib="webworker" />
import { planScenario, type PlanningStats, type ScenarioConfig } from '../sim/scenario';
import { serializePlans } from '../sim/planCache';

/** Plans every robot of a scenario (planScenario) off the UI thread. */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<{ id: number; sc: ScenarioConfig; focus?: string; key: string }>) => {
  const { id, sc, focus, key } = ev.data;
  try {
    const stats = {} as PlanningStats;
    const plans = planScenario(sc, focus, { stats });
    ctx.postMessage({ id, stored: serializePlans(key, plans, stats) });
  } catch (e) {
    ctx.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
