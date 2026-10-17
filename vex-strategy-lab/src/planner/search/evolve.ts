import { Rng } from '../../core/rng';
import type { Action, PlanWorld } from '../model';
import { addToPool, planKey, replay, stopReason, type Budget, type Candidate, type SearchResult } from './common';

/**
 * Evolutionary refinement of action sequences ((μ+λ) strategy). Genomes are action
 * lists; infeasible actions are skipped on replay, so every genome decodes to a
 * valid plan. Mutations: swap, move, delete, change orientation, retarget a pickup,
 * and insert a random legal action at a random point (sampled from the replayed
 * prefix state). Seeded from other methods' best plans.
 */
export interface EvolveOptions {
  generations: number;
  population: number;
  offspring: number;
  seed: number;
}

export function evolve(w: PlanWorld, seeds: Candidate[], opts: EvolveOptions, budget: Budget): SearchResult {
  const start = performance.now();
  const rng = new Rng(opts.seed);
  let expansions = 0;
  let stopped: ReturnType<typeof stopReason> = null;
  type G = { actions: Action[]; value: number };
  const evalG = (actions: Action[]): G => {
    expansions++;
    const r = replay(w, actions);
    return { actions: r.actions, value: r.value };
  };
  let pop: G[] = seeds.length ? seeds.map((s) => evalG(s.actions)) : [evalG([])];
  const pool: Candidate[] = [];

  const mutate = (g: G): Action[] => {
    const a = g.actions.slice();
    const op = rng.int(6);
    if (op === 0 && a.length >= 2) {
      const i = rng.int(a.length - 1);
      [a[i], a[i + 1]] = [a[i + 1], a[i]];
    } else if (op === 1 && a.length >= 2) {
      const i = rng.int(a.length);
      const [x] = a.splice(i, 1);
      a.splice(rng.int(a.length + 1), 0, x);
    } else if (op === 2 && a.length >= 1) {
      a.splice(rng.int(a.length), 1);
    } else if (op === 3) {
      const idx = a.map((x, i) => (x.type === 'place' ? i : -1)).filter((i) => i >= 0);
      if (idx.length) {
        const i = rng.pick(idx);
        const x = a[i] as Extract<Action, { type: 'place' }>;
        a[i] = rng.next() < 0.5 ? { ...x, bit: 1 - x.bit } : { ...x, goal: rng.int(w.goals.length) };
      }
    } else if (op === 4) {
      const idx = a.map((x, i) => (x.type === 'pick' ? i : -1)).filter((i) => i >= 0);
      if (idx.length) {
        const i = rng.pick(idx);
        const x = a[i] as Extract<Action, { type: 'pick' }>;
        const kind = w.objs[x.obj].kind;
        const alts = w.objs.filter((o) => o.kind === kind && o.startPos && o.idx !== x.obj);
        if (alts.length) {
          const near = alts
            .map((o) => ({ o, d: Math.hypot(o.startPos!.x - w.objs[x.obj].startPos!.x, o.startPos!.y - w.objs[x.obj].startPos!.y) }))
            .sort((p, q) => p.d - q.d)
            .slice(0, 5);
          a[i] = { type: 'pick', obj: rng.pick(near).o.idx };
        }
      }
    } else {
      // insert a random legal action at a random point
      const cut = rng.int(a.length + 1);
      const pre = replay(w, a.slice(0, cut));
      const acts = w.legalActions(pre.state);
      if (acts.length) a.splice(cut, 0, rng.pick(acts));
    }
    return a;
  };

  for (let gen = 0; gen < opts.generations; gen++) {
    stopped = stopReason(start, expansions, budget);
    if (stopped) break;
    const kids: G[] = [];
    for (let k = 0; k < opts.offspring; k++) {
      const parent = pop[rng.int(pop.length)];
      let child = mutate(parent);
      if (rng.next() < 0.3) child = mutate({ actions: child, value: 0 });
      kids.push(evalG(child));
    }
    const all = [...pop, ...kids];
    const seen = new Set<string>();
    const uniq: G[] = [];
    for (const g of all.sort((x, y) => y.value - x.value || x.actions.length - y.actions.length)) {
      const k = planKey(g.actions);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(g);
    }
    pop = uniq.slice(0, opts.population);
  }
  for (const g of pop.slice(0, 5)) addToPool(pool, { actions: g.actions, value: g.value, method: 'evolutionary' });
  const best = pop[0];
  return {
    best: { actions: best.actions, value: best.value, method: 'evolutionary' },
    pool,
    stats: {
      method: `evolutionary(μ=${opts.population}, λ=${opts.offspring})`,
      expansions,
      evaluations: w.evaluations,
      ms: performance.now() - start,
      stoppedBy: stopped ?? 'completed',
      best: best.value,
    },
  };
}
