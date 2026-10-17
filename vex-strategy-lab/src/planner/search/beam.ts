import type { PlanWorld } from '../model';
import { upperBoundAdd } from './bounds';
import { addToPool, configKey, pathOf, rolloutStep, stopReason, type Budget, type Candidate, type Node, type SearchResult } from './common';

/**
 * Beam search over action sequences. Each layer expands every node in the beam,
 * deduplicates by field configuration (keeping the earliest-time state), and keeps
 * the top `width` nodes ranked by
 *
 *   value + α·(admissible remaining potential) + τ·ρ·(time left in the window)
 *
 * where ρ is the scoring rate (points/second) a greedy rollout achieves from the
 * root. The admissible bound is loose and barely depends on time, so without the
 * ρ term a node that idles (e.g. waits out Autonomous) ranks the same as one that
 * spent that time productively. Every node is a valid stopping point (the robot
 * may idle), so the best value seen at any depth is a valid plan.
 */
export interface BeamOptions {
  width: number;
  /** Weight on the admissible bound in the ranking (0 = greedy on current value). */
  alpha: number;
  /** Weight τ on the value of remaining time (default 1; 0 disables). */
  timeWeight?: number;
}

/** Points per second a greedy rollout achieves from the initial state (≥ 0). */
export function greedyRate(w: PlanWorld): number {
  let s = w.initialState();
  const v0 = w.value(s);
  let best = v0;
  for (let k = 0; k < 120; k++) {
    const r = rolloutStep(w, s, null, 0);
    if (!r) break;
    s = r.s;
    best = Math.max(best, r.v);
  }
  const span = w.cfg.tEnd - w.cfg.tStart;
  return span > 0 ? Math.max(0, best - v0) / span : 0;
}

export function beamSearch(w: PlanWorld, opts: BeamOptions, budget: Budget): SearchResult {
  const start = performance.now();
  const root: Node = { s: w.initialState(), parent: null, action: null, value: 0 };
  root.value = w.value(root.s);
  let best: Node = root;
  const pool: Candidate[] = [];
  let beam: Node[] = [root];
  let expansions = 0;
  let stopped: ReturnType<typeof stopReason> = null;
  const rho = (opts.timeWeight ?? 1) > 0 ? (opts.timeWeight ?? 1) * greedyRate(w) : 0;
  const rank = (n: Node) => n.value + opts.alpha * upperBoundAdd(w, n.s) + (n.s.parked ? 0 : rho * (w.cfg.tEnd - n.s.t)) - 0.01 * n.s.t;

  outer: while (beam.length) {
    const children = new Map<string, Node>();
    for (const n of beam) {
      const acts = w.legalActions(n.s);
      expansions++;
      for (const a of acts) {
        const r = w.apply(n.s, a);
        if (!r) continue;
        const c: Node = { s: r.s, parent: n, action: a, value: w.value(r.s) };
        const key = configKey(w, c.s);
        const ex = children.get(key);
        if (!ex || c.s.t < ex.s.t - 1e-9 || (Math.abs(c.s.t - ex.s.t) < 1e-9 && c.value > ex.value)) children.set(key, c);
        if (c.value > best.value || (c.value === best.value && c.s.t < best.s.t)) best = c;
      }
      stopped = stopReason(start, expansions, budget);
      if (stopped) break outer;
    }
    const arr = [...children.values()];
    if (!arr.length) break;
    const scored = arr.map((n) => ({ n, f: rank(n) }));
    scored.sort((a, b) => b.f - a.f);
    beam = scored.slice(0, opts.width).map((x) => x.n);
    for (const n of beam.slice(0, 3)) addToPool(pool, { actions: pathOf(n), value: n.value, method: `beam(${opts.width})` });
  }
  addToPool(pool, { actions: pathOf(best), value: best.value, method: `beam(${opts.width})` });
  return {
    best: { actions: pathOf(best), value: best.value, method: `beam(${opts.width})` },
    pool,
    stats: {
      method: `beam(w=${opts.width}, α=${opts.alpha})`,
      expansions,
      evaluations: w.evaluations,
      ms: performance.now() - start,
      stoppedBy: stopped ?? 'completed',
      best: best.value,
    },
  };
}
