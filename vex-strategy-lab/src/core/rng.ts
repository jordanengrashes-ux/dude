/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Every stochastic element of the simulator (uncertainty sampling, MCTS rollouts,
 * evolutionary mutation) draws from an Rng seeded explicitly, so identical seeds
 * reproduce identical results.
 */
export class Rng {
  private s: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = this.seed || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal via Box–Muller. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  fork(salt: number): Rng {
    return new Rng((this.seed * 2654435761 + salt * 40503 + 1) >>> 0);
  }
}

/** FNV-1a hash of a string; used for state fingerprints in determinism tests. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
