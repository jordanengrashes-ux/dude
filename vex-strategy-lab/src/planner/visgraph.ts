import type { Vec2 } from '../core/vec';
import { dist } from '../core/vec';
import { HALF, MIDFIELD_INNER_HALF } from '../field/geometry';
import type { Grid } from './grid';

/**
 * Visibility-graph shortest paths over the Grid's analytic obstacles.
 *
 * Nodes: octagons around every inflated circular obstacle, corners of forbidden
 * boxes, corners of the Midfield square, and a coarse lattice of free points (to
 * guarantee connectivity). All-pairs shortest paths are precomputed once per grid
 * (Floyd–Warshall). A query A→B is the direct segment when clear, otherwise
 * min over visible node pairs |A−i| + D[i][j] + |j−B|.
 *
 * Paths are exact for the polygonal approximation of the obstacles (octagons
 * circumscribe the circles, so returned paths are always collision-free).
 */
export class VisGraph {
  readonly nodes: Vec2[] = [];
  private D: Float64Array;
  private next: Int32Array;
  private n: number;

  constructor(readonly grid: Grid) {
    const add = (p: Vec2) => {
      if (Math.abs(p.x) >= HALF || Math.abs(p.y) >= HALF) return;
      if (grid.pointBlocked(p)) return;
      if (this.nodes.some((q) => dist(q, p) < 1.5)) return;
      this.nodes.push(p);
    };
    for (const c of grid.circlePrimitives) {
      const R = c.r / Math.cos(Math.PI / 8) + 0.6;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI + Math.PI / 8;
        add({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
      }
    }
    for (const b of grid.boxPrimitives) {
      const e = 0.6;
      add({ x: b[0] - e, y: b[1] - e });
      add({ x: b[2] + e, y: b[1] - e });
      add({ x: b[0] - e, y: b[3] + e });
      add({ x: b[2] + e, y: b[3] + e });
    }
    const M = MIDFIELD_INNER_HALF - 0.5;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) add({ x: sx * M, y: sy * M });
    for (let x = -60; x <= 60; x += 12) for (let y = -60; y <= 60; y += 12) add({ x, y });

    const n = (this.n = this.nodes.length);
    this.D = new Float64Array(n * n).fill(Infinity);
    this.next = new Int32Array(n * n).fill(-1);
    for (let i = 0; i < n; i++) {
      this.D[i * n + i] = 0;
      this.next[i * n + i] = i;
      for (let j = i + 1; j < n; j++) {
        if (grid.segmentClear(this.nodes[i], this.nodes[j])) {
          const d = dist(this.nodes[i], this.nodes[j]);
          this.D[i * n + j] = this.D[j * n + i] = d;
          this.next[i * n + j] = j;
          this.next[j * n + i] = i;
        }
      }
    }
    const D = this.D;
    const nx = this.next;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const dik = D[i * n + k];
        if (!isFinite(dik)) continue;
        for (let j = 0; j < n; j++) {
          const v = dik + D[k * n + j];
          if (v < D[i * n + j]) {
            D[i * n + j] = v;
            nx[i * n + j] = nx[i * n + k];
          }
        }
      }
    }
  }

  private visible(p: Vec2): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.grid.segmentClear(p, this.nodes[i])) out.push(i);
    return out;
  }

  /** Shortest collision-free polyline from a to b, or null if unreachable. */
  path(a: Vec2, b: Vec2): Vec2[] | null {
    if (this.grid.segmentClear(a, b)) return [a, b];
    if (this.grid.pointBlocked(a) || this.grid.pointBlocked(b)) return null;
    const va = this.visible(a);
    const vb = this.visible(b);
    const dbs = vb.map((j) => dist(this.nodes[j], b));
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    const n = this.n;
    const D = this.D;
    for (const i of va) {
      const da = dist(a, this.nodes[i]);
      if (da >= best) continue;
      const row = i * n;
      for (let k = 0; k < vb.length; k++) {
        const v = da + D[row + vb[k]] + dbs[k];
        if (v < best) {
          best = v;
          bi = i;
          bj = vb[k];
        }
      }
    }
    if (bi < 0) return null;
    const pts: Vec2[] = [a];
    let c = bi;
    pts.push(this.nodes[c]);
    while (c !== bj) {
      c = this.next[c * n + bj];
      if (c < 0) return null;
      pts.push(this.nodes[c]);
    }
    pts.push(b);
    // string-pull
    const out: Vec2[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.grid.segmentClear(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}
