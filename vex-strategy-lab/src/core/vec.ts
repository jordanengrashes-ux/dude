export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
export const rot = (a: Vec2, th: number): Vec2 => {
  const c = Math.cos(th);
  const s = Math.sin(th);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const fromAngle = (th: number, r = 1): Vec2 => ({ x: Math.cos(th) * r, y: Math.sin(th) * r });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Distance from point p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, scale(ab, t)));
}

/** Oriented rectangle (robot footprint) corners, CCW. */
export function obbCorners(c: Vec2, heading: number, length: number, width: number): Vec2[] {
  const hl = length / 2;
  const hw = width / 2;
  return [
    add(c, rot({ x: hl, y: hw }, heading)),
    add(c, rot({ x: -hl, y: hw }, heading)),
    add(c, rot({ x: -hl, y: -hw }, heading)),
    add(c, rot({ x: hl, y: -hw }, heading)),
  ];
}

/** Separating-axis test between a convex polygon and an axis-aligned rectangle. */
export function polyIntersectsAabb(poly: Vec2[], minX: number, minY: number, maxX: number, maxY: number): boolean {
  const rect = [v2(minX, minY), v2(maxX, minY), v2(maxX, maxY), v2(minX, maxY)];
  return convexPolysIntersect(poly, rect);
}

export function convexPolysIntersect(a: Vec2[], b: Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of a) { const d = dot(p, axis); minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const p of b) { const d = dot(p, axis); minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-300) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a convex polygon (0 if inside). */
export function distPointToPolygon(p: Vec2, poly: Vec2[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}
