import type { Rng } from '../../core/rng';
import type { Action, PlanState, PlanWorld } from '../model';

export interface Budget {
  maxMs: number;
  maxExpansions: number;
  /** Cooperative cancellation: set `cancelled = true` to stop the search. */
  signal?: { cancelled: boolean };
}

export interface Candidate {
  actions: Action[];
  value: number;
  /** Search method that found it. */
  method: string;
}

export interface SearchStats {
  method: string;
  expansions: number;
  evaluations: number;
  ms: number;
  stoppedBy: 'completed' | 'time' | 'expansions' | 'cancelled';
  best: number;
  /** Branch-and-bound only: true if the search space was exhausted. */
  proven?: boolean;
  rootBound?: number;
  notes?: string;
}

export interface SearchResult {
  best: Candidate;
  /** Distinct high-value candidates (for comparison / robustness). */
  pool: Candidate[];
  stats: SearchStats;
}

export interface Node {
  s: PlanState;
  parent: Node | null;
  action: Action | null;
  value: number;
}

export function pathOf(n: Node): Action[] {
  const out: Action[] = [];
  for (let c: Node | null = n; c && c.action; c = c.parent) out.push(c.action);
  return out.reverse();
}

export function stopReason(start: number, expansions: number, b: Budget): SearchStats['stoppedBy'] | null {
  if (b.signal?.cancelled) return 'cancelled';
  if (expansions >= b.maxExpansions) return 'expansions';
  if (performance.now() - start >= b.maxMs) return 'time';
  return null;
}

/** Field-configuration key (everything that affects future value except pose/time). */
export function configKey(w: PlanWorld, s: PlanState): string {
  let k = `${s.heldPin},${s.heldCup},${s.parked ? 1 : 0}|`;
  for (const st of s.stacks) k += st.join('.') + '/';
  k += '|' + s.toggles.join('');
  k += '|' + (s.auto ? `${s.auto.own}:${s.auto.opp}:${s.auto.awp ? 1 : 0}` : '-');
  // consumed objects (status changes from start) — compact bitmask over objects
  let bits = '';
  for (let i = 0; i < s.status.length; i += 1) bits += s.status[i];
  return k + '|' + bits + `|${w.cfg.robotId}`;
}

export function poseKey(s: PlanState): string {
  return `${s.pos.x.toFixed(2)},${s.pos.y.toFixed(2)},${s.heading.toFixed(3)},${s.holderH.toFixed(2)}`;
}

/** Replay an action list; infeasible actions are skipped (used by mutation/robustness). */
export function replay(w: PlanWorld, actions: Action[], detailed = false) {
  let s = w.initialState();
  const kept: Action[] = [];
  const steps = [];
  for (const a of actions) {
    const r = w.apply(s, a, detailed);
    if (!r) continue;
    s = r.s;
    kept.push(a);
    steps.push(r.step);
  }
  return { state: s, actions: kept, steps, value: w.value(s) };
}

export function actionKey(a: Action): string {
  switch (a.type) {
    case 'pick':
      return `k${a.obj}`;
    case 'load':
      return `l${a.obj}@${a.loader}`;
    case 'place':
      return `p${a.goal}:${a.bit}`;
    case 'toggle':
      return `t${a.toggle}`;
    case 'park':
      return 'park';
    case 'wait':
      return `w${a.until}`;
  }
}

export function planKey(actions: Action[]): string {
  return actions.map(actionKey).join(' ');
}

export function addToPool(pool: Candidate[], c: Candidate, max = 12) {
  const k = planKey(c.actions);
  const ex = pool.find((p) => planKey(p.actions) === k);
  if (ex) {
    if (c.value > ex.value) ex.value = c.value;
    return;
  }
  pool.push(c);
  pool.sort((a, b) => b.value - a.value || a.actions.length - b.actions.length);
  if (pool.length > max) pool.length = max;
}

/**
 * Rollout policy shared by MCTS, greedy completion and explanations:
 * ε-random, otherwise best value-gain per second. Parking is terminal, so it is
 * only taken near the end of the window (or when nothing else is possible).
 */
export function rolloutStep(w: PlanWorld, s: PlanState, rng: Rng | null, eps: number): { s: PlanState; a: Action; v: number } | null {
  const acts = w.legalActions(s);
  if (!acts.length) return null;
  const left = w.cfg.tEnd - s.t;
  const parkWindow = 6;
  const nonPark = acts.filter((a) => a.type !== 'park');
  if (left <= parkWindow || !nonPark.length) {
    const park = acts.find((a) => a.type === 'park');
    if (park) {
      const r = w.apply(s, park);
      if (r) return { s: r.s, a: park, v: w.value(r.s) };
    }
  }
  if (rng && rng.next() < eps) {
    for (let tries = 0; tries < 4; tries++) {
      const a = rng.pick(nonPark.length ? nonPark : acts);
      const r = w.apply(s, a);
      if (r) return { s: r.s, a, v: w.value(r.s) };
    }
  }
  const v0 = w.value(s);
  let best: { s: PlanState; a: Action; v: number } | null = null;
  let bestRate = -Infinity;
  for (const a of nonPark) {
    const r = w.apply(s, a);
    if (!r) continue;
    const v = w.value(r.s);
    const pickBonus = a.type === 'pick' || a.type === 'load' ? 2 : 0;
    const rate = (v - v0 + pickBonus) / Math.max(0.1, r.s.t - s.t) + (rng ? rng.next() * 0.01 : 0);
    if (rate > bestRate) {
      bestRate = rate;
      best = { s: r.s, a, v };
    }
  }
  return best;
}
