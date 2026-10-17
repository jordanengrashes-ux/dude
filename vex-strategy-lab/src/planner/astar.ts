import type { Vec2 } from '../core/vec';
import { dist } from '../core/vec';
import { Grid, MinHeap } from './grid';

const SQ2 = Math.SQRT2;
const NB: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQ2],
  [1, -1, SQ2],
  [-1, 1, SQ2],
  [-1, -1, SQ2],
];

export interface PathResult {
  /** Smoothed waypoints from start to goal (inches). */
  points: Vec2[];
  length: number;
  /** Raw grid expansions (diagnostics). */
  expanded: number;
}

/** A* over the configuration-space grid; returns a string-pulled path or null. */
export function astar(grid: Grid, start: Vec2, goal: Vec2): PathResult | null {
  const s = grid.nearestFree(start);
  const g = grid.nearestFree(goal);
  if (!s || !g) return null;
  if (grid.lineFree(s, g)) {
    const pts = dedupe([start, s, g, goal]);
    return { points: pts, length: polyLen(pts), expanded: 0 };
  }
  const n = grid.n;
  const [si, sj] = grid.cellOf(s);
  const [gi, gj] = grid.cellOf(g);
  const N = n * n;
  const gScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gi);
    const dy = Math.abs(j - gj);
    return (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)) * grid.cell;
  };
  const start0 = grid.idx(si, sj);
  gScore[start0] = 0;
  heap.push(h(si, sj), start0);
  let expanded = 0;
  const goalIdx = grid.idx(gi, gj);
  while (heap.size) {
    const [, cur] = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goalIdx) break;
    const ci = cur % n;
    const cj = (cur - ci) / n;
    for (const [di, dj, w] of NB) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nIdx = nj * n + ni;
      if (grid.blocked[nIdx] || closed[nIdx]) continue;
      if (di && dj && (grid.blocked[cj * n + ni] || grid.blocked[nj * n + ci])) continue; // no corner cutting
      const tentative = gScore[cur] + w * grid.cell;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        came[nIdx] = cur;
        heap.push(tentative + h(ni, nj), nIdx);
      }
    }
  }
  if (!closed[goalIdx]) return null;
  const cells: Vec2[] = [];
  for (let c = goalIdx; c !== -1; c = came[c]) {
    const ci = c % n;
    cells.push(grid.center(ci, (c - ci) / n));
  }
  cells.reverse();
  const raw = dedupe([start, s, ...cells.slice(1, -1), g, goal]);
  const pts = smooth(grid, raw);
  return { points: pts, length: polyLen(pts), expanded };
}

/** Greedy string pulling: keep only waypoints needed for line of sight. */
export function smooth(grid: Grid, pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !grid.lineFree(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

export function polyLen(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push(p);
  return out;
}

/**
 * Dijkstra distance field from a target point: dist(cell → target). Used by the
 * optimizer for O(1) travel-distance queries during search; the final plan is
 * re-routed with A* and smoothed.
 */
export class DistanceField {
  readonly field: Float32Array;
  readonly target: Vec2;
  constructor(readonly grid: Grid, target: Vec2) {
    this.target = target;
    const n = grid.n;
    const N = n * n;
    const f = new Float32Array(N).fill(Infinity);
    const t = grid.nearestFree(target) ?? target;
    const [ti, tj] = grid.cellOf(t);
    const heap = new MinHeap();
    const t0 = grid.idx(ti, tj);
    f[t0] = dist(t, target);
    heap.push(f[t0], t0);
    while (heap.size) {
      const [d, cur] = heap.pop()!;
      if (d > f[cur]) continue;
      const ci = cur % n;
      const cj = (cur - ci) / n;
      for (const [di, dj, w] of NB) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nIdx = nj * n + ni;
        if (grid.blocked[nIdx]) continue;
        if (di && dj && (grid.blocked[cj * n + ni] || grid.blocked[nj * n + ci])) continue;
        const nd = d + w * grid.cell;
        if (nd < f[nIdx]) {
          f[nIdx] = nd;
          heap.push(nd, nIdx);
        }
      }
    }
    this.field = f;
  }

  /** Shortest path p → target by steepest descent on the field, string-pulled. */
  pathFrom(p: Vec2): Vec2[] | null {
    const g = this.grid;
    if (g.lineFree(p, this.target)) return [p, this.target];
    const q = g.nearestFree(p) ?? p;
    let [i, j] = g.cellOf(q);
    let cur = g.idx(i, j);
    if (!isFinite(this.field[cur])) return null;
    const n = g.n;
    const pts: Vec2[] = [p, q];
    for (let guard = 0; guard < n * n; guard++) {
      let best = cur;
      let bestV = this.field[cur];
      for (const [di, dj] of NB) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const k = nj * n + ni;
        if (this.field[k] < bestV - 1e-9) {
          bestV = this.field[k];
          best = k;
        }
      }
      if (best === cur) break;
      cur = best;
      i = cur % n;
      j = (cur - i) / n;
      pts.push(g.center(i, j));
    }
    pts.push(this.target);
    return smooth(g, dedupe(pts));
  }

  /**
   * Travel distance from p to the target. Octile grid distances overestimate
   * Euclidean length by up to ~8%; we correct by taking the max of the straight
   * line (when visible) and 0.95 × the grid distance.
   */
  distanceFrom(p: Vec2): number {
    const g = this.grid;
    let [i, j] = g.cellOf(p);
    let extra = 0;
    if (g.blocked[g.idx(i, j)]) {
      const q = g.nearestFree(p) ?? p;
      extra = dist(p, q);
      [i, j] = g.cellOf(q);
    }
    const d = this.field[g.idx(i, j)];
    if (!isFinite(d)) return Infinity;
    return Math.max(dist(p, this.target), 0.95 * d + extra);
  }
}
