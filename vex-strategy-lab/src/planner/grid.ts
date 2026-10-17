import type { Vec2 } from '../core/vec';
import { dist } from '../core/vec';
import { buildGoals, buildLoaders, HALF, loadZones, MIDFIELD_INNER_HALF } from '../field/geometry';
import type { Alliance } from '../rules/ruleset';

/**
 * Configuration-space obstacle model + occupancy grid for a robot of a given
 * clearance radius. A point is blocked if the robot CENTER cannot be there without
 * overlapping a Field Element, the perimeter, or (when constrained) a forbidden region:
 *   - SG7: the opposing side of the Autonomous Line during Autonomous
 *   - Load Zone protection: opposing Load Zones during Driver Control
 *
 * Obstacles are kept as analytic primitives so straight-line queries are exact and
 * cheap; the grid is derived from the same primitives for A* / Dijkstra.
 */

export interface GridOptions {
  /** Robot clearance from walls (≈ half-width + margin), inches. */
  clearance: number;
  /**
   * Clearance from posts / Loaders / Toggles. A square robot's corners sweep out to
   * its half-diagonal, so point obstacles are inflated by this (defaults to clearance).
   */
  cornerClearance?: number;
  /** Grid cell size (inches). */
  cell?: number;
  alliance?: Alliance;
  /** Forbid the opposing side of the Autonomous Line (Autonomous). */
  forbidOpposingSide?: boolean;
  /** Forbid opposing Load Zones (Driver Controlled Period). */
  forbidOpposingLoadZones?: boolean;
  /** Extra circular obstacles (e.g. stationary robots). */
  extraObstacles?: { pos: Vec2; r: number }[];
}

interface Circle {
  x: number;
  y: number;
  r2: number;
}

export class Grid {
  readonly cell: number;
  readonly n: number;
  readonly origin: number;
  readonly blocked: Uint8Array;
  readonly opts: GridOptions;
  private circles: Circle[] = [];
  private boxes: [number, number, number, number][] = [];
  private bound: number;
  private opp: Alliance | null = null;

  constructor(opts: GridOptions) {
    this.opts = opts;
    this.cell = opts.cell ?? 2;
    this.n = Math.ceil((2 * HALF) / this.cell);
    this.origin = -HALF;
    const c = opts.clearance;
    const cc = opts.cornerClearance ?? c;
    this.bound = HALF - c;
    // The chassis clears the low Goal base disc; the post is the obstacle.
    for (const g of buildGoals()) this.circles.push({ x: g.pos.x, y: g.pos.y, r2: (g.postRadius + cc) ** 2 });
    for (const l of buildLoaders()) this.circles.push({ x: l.corner.x, y: l.corner.y, r2: (l.footprint * Math.SQRT2 + cc) ** 2 });
    // Toggles sit on top of the walls, above the chassis: not an obstacle.
    for (const o of opts.extraObstacles ?? []) this.circles.push({ x: o.pos.x, y: o.pos.y, r2: (o.r + c) ** 2 });
    if (opts.alliance && opts.forbidOpposingLoadZones) {
      for (const z of loadZones()) {
        if (z.alliance === opts.alliance) continue;
        const [x0, y0, x1, y1] = z.aabb;
        // corner clearance: a robot turning in place sweeps its half-diagonal
        this.boxes.push([x0 - cc, y0 - cc, x1 + cc, y1 + cc]);
      }
    }
    if (opts.alliance && opts.forbidOpposingSide) this.opp = opts.alliance === 'red' ? 'blue' : 'red';
    this.blocked = new Uint8Array(this.n * this.n);
    for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) this.blocked[j * this.n + i] = this.pointBlocked(this.center(i, j)) ? 1 : 0;
  }

  /** Exact (analytic) configuration-space test for a robot center. */
  pointBlocked(p: Vec2): boolean {
    if (p.x > this.bound || p.x < -this.bound || p.y > this.bound || p.y < -this.bound) return true;
    for (const k of this.circles) {
      const dx = p.x - k.x;
      const dy = p.y - k.y;
      if (dx * dx + dy * dy < k.r2) return true;
    }
    for (const b of this.boxes) if (p.x > b[0] && p.x < b[2] && p.y > b[1] && p.y < b[3]) return true;
    if (this.opp) {
      // Robot body must stay off the opposing side; the Midfield is shared territory (SG8).
      if (this.oppSum(p) > this.sideLimit && !this.inMidCenter(p)) return true;
    }
    return false;
  }

  /** Signed coordinate across the Autonomous Line, positive toward the opposing side. */
  private oppSum(p: Vec2): number {
    return this.opp === 'blue' ? p.x + p.y : -(p.x + p.y);
  }
  /** The center stays a half-diagonal (+margin) off the line: a turning robot's corners sweep that far (SG7). */
  private get sideLimit(): number {
    return -(this.opts.cornerClearance ?? this.opts.clearance) * Math.SQRT2;
  }
  private inMidCenter(p: Vec2): boolean {
    return Math.abs(p.x) <= MIDFIELD_INNER_HALF && Math.abs(p.y) <= MIDFIELD_INNER_HALF;
  }

  /** Exact analytic segment test against every primitive (no sampling). */
  segmentClear(a: Vec2, b: Vec2): boolean {
    if (this.pointBlocked(a) || this.pointBlocked(b)) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    for (const k of this.circles) {
      let t = l2 > 1e-12 ? ((k.x - a.x) * dx + (k.y - a.y) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * t - k.x;
      const py = a.y + dy * t - k.y;
      if (px * px + py * py < k.r2) return false;
    }
    for (const bx of this.boxes) if (segBox(a, b, bx)) return false;
    if (this.opp) {
      // interval of the segment on the opposing side (half-plane), must lie in the Midfield square
      const sa = this.oppSum(a) - this.sideLimit;
      const sb = this.oppSum(b) - this.sideLimit;
      if (sa > 0 || sb > 0) {
        let t0 = 0;
        let t1 = 1;
        if (sa <= 0) t0 = sa / (sa - sb);
        if (sb <= 0) t1 = sa / (sa - sb);
        const q0 = { x: a.x + dx * t0, y: a.y + dy * t0 };
        const q1 = { x: a.x + dx * t1, y: a.y + dy * t1 };
        if (!this.inMidCenter(q0) || !this.inMidCenter(q1)) return false;
      }
    }
    return true;
  }

  center(i: number, j: number): Vec2 {
    return { x: this.origin + (i + 0.5) * this.cell, y: this.origin + (j + 0.5) * this.cell };
  }

  cellOf(p: Vec2): [number, number] {
    const i = Math.min(this.n - 1, Math.max(0, Math.floor((p.x - this.origin) / this.cell)));
    const j = Math.min(this.n - 1, Math.max(0, Math.floor((p.y - this.origin) / this.cell)));
    return [i, j];
  }

  isBlockedAt(p: Vec2): boolean {
    return this.pointBlocked(p);
  }

  idx(i: number, j: number): number {
    return j * this.n + i;
  }

  /** Straight-line clearance (exact). */
  lineFree(a: Vec2, b: Vec2): boolean {
    return this.segmentClear(a, b);
  }

  /** Primitive circles (inflated), exposed for the visibility graph. */
  get circlePrimitives(): { x: number; y: number; r: number }[] {
    return this.circles.map((c) => ({ x: c.x, y: c.y, r: Math.sqrt(c.r2) }));
  }
  get boxPrimitives(): [number, number, number, number][] {
    return this.boxes;
  }

  /**
   * p itself if p and its grid cell are free; otherwise the nearest unblocked cell
   * center (for starts/goals that fall inside inflation or in a blocked cell).
   */
  nearestFree(p: Vec2, maxR = 24): Vec2 | null {
    const [pi, pj] = this.cellOf(p);
    if (!this.pointBlocked(p) && !this.blocked[this.idx(pi, pj)]) return p;
    const [ci, cj] = this.cellOf(p);
    const R = Math.ceil(maxR / this.cell);
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
        if (this.blocked[this.idx(i, j)]) continue;
        const c = this.center(i, j);
        const d = dist(c, p);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    return best;
  }
}

/** Binary min-heap keyed by number. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p];
      k[p] = k[i];
      k[i] = tk;
      const tv = v[p];
      v[p] = v[i];
      v[i] = tv;
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const k = this.keys;
    const v = this.vals;
    if (!k.length) return undefined;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && k[l] < k[m]) m = l;
        if (r < n && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m];
        k[m] = k[i];
        k[i] = tk;
        const tv = v[m];
        v[m] = v[i];
        v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

/** Liang–Barsky: does segment ab intersect the open box [x0,y0,x1,y1]? */
function segBox(a: Vec2, b: Vec2, box: [number, number, number, number]): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box[0], box[2] - a.x, a.y - box[1], box[3] - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] <= 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 - t0 > 1e-9;
}
