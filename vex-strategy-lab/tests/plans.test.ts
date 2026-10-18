import { describe, expect, it } from 'vitest';
import { planScenario, type PlanningStats } from '../src/sim/scenario';
import { scenarioKey, type StoredPlans } from '../src/sim/planCache';
import defaultPlans from '../src/sim/defaultPlans.json';
import { SimRunner } from '../src/ui/simRunner';
import { store } from '../src/ui/store';

/** Joint planning of every robot, the shipped default plans, and the default match. */

describe('Default scenario plans', () => {
  it('every robot of both alliances runs an optimized plan, and the shipped plans are current (npm run plans)', () => {
    const s = store.get();
    expect(s.slots.map((x) => x.strategy)).toEqual(['optimized', 'optimized', 'optimized', 'optimized']);
    const sc = new SimRunner().scenarioFrom(s);
    const shipped = defaultPlans as unknown as StoredPlans;
    expect(shipped.key).toBe(scenarioKey(sc, s.userSlot));
    const stats = {} as PlanningStats;
    const plans = planScenario(sc, s.userSlot, { stats });
    expect(stats.rounds).toBeGreaterThan(0);
    for (const slot of ['red-1', 'red-2', 'blue-1', 'blue-2']) {
      const p = plans.get(slot)!;
      expect(p.actions.length).toBeGreaterThanOrEqual(8); // a full match of work, not a stub
      expect(p.value).toBeGreaterThan(0);
      expect(shipped.plans[slot].actions).toEqual(p.actions);
      expect(shipped.plans[slot].value).toBe(p.value);
    }
  });
});

describe('Default Head-to-Head match', () => {
  it('no robot sits idle: all four keep moving and completing actions to the end', async () => {
    const runner = new SimRunner();
    await runner.rebuild(store.get());
    expect(runner.planning).toBe(false); // shipped plans: no planning at start-up
    const sim = runner.sim!;
    // distance driven (path length, sampled every 0.5 s) in each 20 s window
    const last = new Map(sim.robots.map((r) => [r.id, r.body.pose().pos]));
    const driven = new Map(sim.robots.map((r) => [r.id, 0]));
    for (let t = 0.5; t <= 100 + 1e-9; t += 0.5) {
      sim.runUntil(t);
      for (const r of sim.robots) {
        const p = r.body.pose().pos;
        const l = last.get(r.id)!;
        driven.set(r.id, driven.get(r.id)! + Math.hypot(p.x - l.x, p.y - l.y));
        last.set(r.id, p);
      }
      if (Math.abs(t % 20) < 1e-9) {
        for (const [id, d] of driven) expect(d, `${id} drove between ${t - 20} and ${t} s`).toBeGreaterThan(30);
        for (const id of driven.keys()) driven.set(id, 0);
      }
    }
    sim.runUntil(sim.clock.total + 0.05);
    for (const [id, ex] of runner.built!.executors) {
      expect(ex.history.some((h) => h.ok && h.tEnd > 80), `${id} still completes actions late in the match`).toBe(true);
    }
    sim.dispose();
  });
});
