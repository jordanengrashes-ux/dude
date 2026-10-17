import { Rng } from '../../core/rng';
import type { Action, PlanState, PlanWorld } from '../model';
import { upperBoundAdd } from './bounds';
import { addToPool, rolloutStep, stopReason, type Budget, type Candidate, type SearchResult } from './common';

/**
 * Single-player Monte Carlo Tree Search (UCT). Rewards are the best value reached
 * along a rollout (the robot may stop at any point), normalized by the root bound.
 * Rollouts use an ε-greedy policy on value-gain-per-second so they resemble
 * plausible play. The best full sequence ever observed is returned.
 */
export interface MctsOptions {
  iterations: number;
  exploration: number;
  rolloutEpsilon: number;
  seed: number;
  maxRolloutDepth: number;
}

interface MNode {
  s: PlanState;
  action: Action | null;
  parent: MNode | null;
  children: MNode[];
  untried: Action[] | null;
  visits: number;
  total: number;
  value: number;
}

export function mcts(w: PlanWorld, opts: MctsOptions, budget: Budget): SearchResult {
  const start = performance.now();
  const rng = new Rng(opts.seed);
  const rootS = w.initialState();
  const root: MNode = { s: rootS, action: null, parent: null, children: [], untried: null, visits: 0, total: 0, value: w.value(rootS) };
  const norm = Math.max(1, root.value + upperBoundAdd(w, rootS));
  let best: Candidate = { actions: [], value: root.value, method: 'mcts' };
  const pool: Candidate[] = [];
  let expansions = 0;
  let stopped: ReturnType<typeof stopReason> = null;

  const pathTo = (n: MNode): Action[] => {
    const out: Action[] = [];
    for (let c: MNode | null = n; c && c.action; c = c.parent) out.push(c.action);
    return out.reverse();
  };

  for (let it = 0; it < opts.iterations; it++) {
    stopped = stopReason(start, expansions, budget);
    if (stopped) break;
    // selection
    let n = root;
    for (;;) {
      if (n.untried === null) {
        n.untried = w.legalActions(n.s);
        // shuffle deterministically
        for (let i = n.untried.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [n.untried[i], n.untried[j]] = [n.untried[j], n.untried[i]];
        }
      }
      if (n.untried.length > 0 || n.children.length === 0) break;
      let bestC = n.children[0];
      let bestU = -Infinity;
      const lnN = Math.log(n.visits + 1);
      for (const c of n.children) {
        const u = c.total / (c.visits + 1e-9) + opts.exploration * Math.sqrt(lnN / (c.visits + 1e-9));
        if (u > bestU) {
          bestU = u;
          bestC = c;
        }
      }
      n = bestC;
    }
    // expansion
    while (n.untried && n.untried.length) {
      const a = n.untried.pop()!;
      const r = w.apply(n.s, a);
      expansions++;
      if (!r) continue;
      const c: MNode = { s: r.s, action: a, parent: n, children: [], untried: null, visits: 0, total: 0, value: w.value(r.s) };
      n.children.push(c);
      n = c;
      break;
    }
    // rollout
    let s = n.s;
    let bestAlong = n.value;
    const roll: Action[] = [];
    let bestRollLen = 0;
    for (let d = 0; d < opts.maxRolloutDepth; d++) {
      const chosen = rolloutStep(w, s, rng, opts.rolloutEpsilon);
      expansions++;
      if (!chosen) break;
      s = chosen.s;
      roll.push(chosen.a);
      if (chosen.v > bestAlong) {
        bestAlong = chosen.v;
        bestRollLen = roll.length;
      }
    }
    if (bestAlong > best.value) {
      best = { actions: [...pathTo(n), ...roll.slice(0, bestRollLen)], value: bestAlong, method: 'mcts' };
      addToPool(pool, { ...best, actions: best.actions.slice() });
    }
    // backprop
    const reward = bestAlong / norm;
    for (let c: MNode | null = n; c; c = c.parent) {
      c.visits++;
      c.total += reward;
    }
  }
  addToPool(pool, best);
  return {
    best,
    pool,
    stats: {
      method: `mcts(iter≤${opts.iterations}, c=${opts.exploration})`,
      expansions,
      evaluations: w.evaluations,
      ms: performance.now() - start,
      stoppedBy: stopped ?? 'completed',
      best: best.value,
    },
  };
}
