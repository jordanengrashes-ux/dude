import type { Action, PlanState, PlanWorld } from '../model';
import { upperBoundAdd } from './bounds';
import { addToPool, configKey, poseKey, stopReason, type Budget, type Candidate, type SearchResult } from './common';

/**
 * Depth-first branch-and-bound with an admissible bound (bounds.ts).
 *
 * - Children are ordered by (value gain per second, then bound) so good incumbents
 *   appear early.
 * - A node is pruned when value + bound ≤ incumbent + ε.
 * - A transposition table prunes a state revisited with the same field configuration
 *   AND the same pose at an equal or later time (exact dominance).
 *
 * If the search finishes inside the budget, the incumbent is PROVEN optimal within
 * the model's finite action space (the macro-actions in model.ts, their candidate
 * filters, and the time model). Otherwise the result is "best found" and the
 * remaining optimality gap is reported from the open nodes' bounds.
 */
export interface BnbOptions {
  epsilon: number;
  /** Optional starting incumbent (e.g. from beam search). */
  incumbent?: Candidate;
}

export function branchAndBound(w: PlanWorld, opts: BnbOptions, budget: Budget): SearchResult {
  const start = performance.now();
  const root = w.initialState();
  const rootValue = w.value(root);
  const rootBound = rootValue + upperBoundAdd(w, root);
  let bestValue = rootValue;
  let bestPath: Action[] = [];
  if (opts.incumbent && opts.incumbent.value > bestValue) {
    bestValue = opts.incumbent.value;
    bestPath = opts.incumbent.actions.slice();
  }
  const pool: Candidate[] = [];
  const tt = new Map<string, number>();
  let expansions = 0;
  let stopped: ReturnType<typeof stopReason> = null;
  /** Max bound among nodes pruned only because the budget ran out (for the gap). */
  let openBound = -Infinity;
  const path: Action[] = [];

  const dfs = (s: PlanState, value: number): void => {
    if (stopped) return;
    expansions++;
    if ((expansions & 255) === 0) {
      stopped = stopReason(start, expansions, budget);
      if (stopped) return;
    }
    const key = configKey(w, s) + '#' + poseKey(s) + '#' + s.loaderFreeAt.map((x) => x.toFixed(2)).join(',');
    const seen = tt.get(key);
    if (seen !== undefined && seen <= s.t + 1e-9) return;
    tt.set(key, s.t);
    const acts = w.legalActions(s);
    const kids: { s: PlanState; a: Action; v: number; ub: number; rate: number }[] = [];
    for (const a of acts) {
      const r = w.apply(s, a);
      if (!r) continue;
      const v = w.value(r.s);
      const ub = v + upperBoundAdd(w, r.s);
      const rate = (v - value) / Math.max(0.05, r.s.t - s.t);
      kids.push({ s: r.s, a, v, ub, rate });
    }
    kids.sort((x, y) => y.rate - x.rate || y.ub - x.ub);
    for (const k of kids) {
      if (k.v > bestValue + 1e-9) {
        bestValue = k.v;
        bestPath = [...path, k.a];
        addToPool(pool, { actions: bestPath.slice(), value: bestValue, method: 'branch&bound' });
      }
      if (k.ub <= bestValue + opts.epsilon) continue;
      if (stopped) {
        openBound = Math.max(openBound, k.ub);
        continue;
      }
      path.push(k.a);
      dfs(k.s, k.v);
      path.pop();
      if (stopped) openBound = Math.max(openBound, k.ub);
    }
  };
  dfs(root, rootValue);
  const proven = !stopped;
  addToPool(pool, { actions: bestPath.slice(), value: bestValue, method: 'branch&bound' });
  return {
    best: { actions: bestPath, value: bestValue, method: 'branch&bound' },
    pool,
    stats: {
      method: 'branch&bound',
      expansions,
      evaluations: w.evaluations,
      ms: performance.now() - start,
      stoppedBy: stopped ?? 'completed',
      best: bestValue,
      proven,
      rootBound: proven ? bestValue : Math.max(bestValue, Math.min(rootBound, isFinite(openBound) ? Math.max(openBound, bestValue) : rootBound)),
      notes: proven ? 'Search space exhausted: incumbent is optimal within the model.' : 'Budget exhausted; bound reported from open nodes.',
    },
  };
}

/**
 * Brute-force enumeration of every feasible action sequence (no pruning, no
 * transposition table). Exponential — only for tiny verification scenarios.
 */
export function exhaustive(w: PlanWorld, maxNodes = 2_000_000, from?: PlanState): { value: number; actions: Action[]; nodes: number; complete: boolean } {
  let best = { value: -Infinity, actions: [] as Action[] };
  let nodes = 0;
  const path: Action[] = [];
  const rec = (s: PlanState) => {
    nodes++;
    if (nodes > maxNodes) return;
    const v = w.value(s);
    if (v > best.value) best = { value: v, actions: path.slice() };
    for (const a of w.legalActions(s)) {
      const r = w.apply(s, a);
      if (!r) continue;
      path.push(a);
      rec(r.s);
      path.pop();
    }
  };
  rec(from ?? w.initialState());
  return { ...best, nodes, complete: nodes <= maxNodes };
}
