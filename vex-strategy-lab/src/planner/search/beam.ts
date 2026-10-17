import type { PlanWorld } from '../model';
import { upperBoundAdd } from './bounds';
import { addToPool, configKey, pathOf, stopReason, type Budget, type Candidate, type Node, type SearchResult } from './common';

/**
 * Beam search over action sequences. Each layer expands every node in the beam,
 * deduplicates by field configuration (keeping the earliest-time state), and keeps
 * the top `width` nodes ranked by value + α·(optimistic remaining potential).
 * Every node is a valid stopping point (the robot may idle), so the best value
 * seen at any depth is a valid plan.
 */
export interface BeamOptions {
  width: number;
  /** Weight on the admissible bound in the ranking (0 = greedy on current value). */
  alpha: number;
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
  const rank = (n: Node) => n.value + opts.alpha * upperBoundAdd(w, n.s) - 0.01 * n.s.t;

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
