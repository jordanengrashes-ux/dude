import type { Action, ExternalEvent } from '../planner/model';
import { PlanWorld } from '../planner/model';
import { planConfigFor, planScenario, type PlanningStats, type ScenarioConfig, type ScenarioPlans } from './scenario';
import defaultPlans from './defaultPlans.json';

/**
 * Where the live match's plans come from, fastest first:
 *  1. this session's cache (same scenario planned before: Reset match, checkpoints),
 *  2. the plans shipped with the app for the default scenario (`npm run plans`
 *     regenerates them; a test checks they match what the planner computes),
 *  3. a Web Worker running planScenario, so the page stays responsive,
 *  4. planScenario on this thread (Node: tests and scripts).
 * Planning is deterministic, so all four give the same plans.
 */

export interface StoredPlans {
  key: string;
  stats: PlanningStats;
  plans: Record<string, { actions: Action[]; events: ExternalEvent[]; value: number }>;
}

/** FNV-1a over the scenario JSON (and focus slot): identifies a planning problem. */
export function scenarioKey(sc: ScenarioConfig, focus?: string): string {
  const s = JSON.stringify(sc) + '|' + (focus ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${s.length}`;
}

export function serializePlans(key: string, plans: ScenarioPlans, stats: PlanningStats): StoredPlans {
  const out: StoredPlans = { key, stats, plans: {} };
  for (const [slot, p] of plans) out.plans[slot] = { actions: p.actions, events: p.events, value: p.value };
  return out;
}

/** Rebuild the planning worlds (the executors' models) from stored plans. */
export function restorePlans(sc: ScenarioConfig, stored: StoredPlans): ScenarioPlans {
  const out: ScenarioPlans = new Map();
  for (const slot of sc.slots) {
    const p = stored.plans[slot.slot];
    if (!p || !slot.enabled || slot.strategy !== 'optimized') continue;
    out.set(slot.slot, { actions: p.actions, events: p.events, value: p.value, world: new PlanWorld(planConfigFor(sc, slot, p.events)) });
  }
  return out;
}

const cache = new Map<string, StoredPlans>();
const shipped = defaultPlans as unknown as StoredPlans;

/** Plans available without computing (session cache or the shipped default). */
export function cachedPlans(sc: ScenarioConfig, focus?: string): { plans: ScenarioPlans; stats: PlanningStats } | null {
  const key = scenarioKey(sc, focus);
  const hit = cache.get(key) ?? (shipped.key === key ? shipped : null);
  return hit ? { plans: restorePlans(sc, hit), stats: hit.stats } : null;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (m: { stored?: StoredPlans; error?: string }) => void>();

function planWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('../workers/plan.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; stored?: StoredPlans; error?: string }>) => {
      pending.get(ev.data.id)?.(ev.data);
      pending.delete(ev.data.id);
    };
  }
  return worker;
}

/** Plan a scenario: cached, shipped, in the worker, or here. */
export async function planScenarioAsync(sc: ScenarioConfig, focus?: string): Promise<{ plans: ScenarioPlans; stats: PlanningStats }> {
  const hit = cachedPlans(sc, focus);
  if (hit) return hit;
  const key = scenarioKey(sc, focus);
  const w = planWorker();
  let stored: StoredPlans;
  if (w) {
    const id = nextId++;
    stored = await new Promise<StoredPlans>((resolve, reject) => {
      pending.set(id, (m) => (m.stored ? resolve(m.stored) : reject(new Error(m.error ?? 'planning failed'))));
      w.postMessage({ id, sc, focus, key });
    });
  } else {
    const stats = {} as PlanningStats;
    stored = serializePlans(key, planScenario(sc, focus, { stats }), stats);
  }
  cache.set(key, stored);
  return { plans: restorePlans(sc, stored), stats: stored.stats };
}
