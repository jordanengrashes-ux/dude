import { IN } from '../core/units';
import type { Vec2 } from '../core/vec';

/**
 * Conversions between the 2D game frame (inches; x right, y up in the overhead
 * diagram) and the 3D physics/render frame (meters; Y up; world Z = −game y).
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Game (x, y) inches and height z inches → world meters. */
export const toWorld = (x: number, y: number, z = 0): V3 => ({ x: x * IN, y: z * IN, z: -y * IN });

export const fromWorld = (v: V3): { x: number; y: number; z: number } => ({ x: v.x / IN, y: -v.z / IN, z: v.y / IN });

export const toWorld2 = (p: Vec2, z = 0): V3 => toWorld(p.x, p.y, z);

/** Rotation about +Y by game heading θ (maps local +X to game heading). */
export const yawQuat = (theta: number): Quat => ({ x: 0, y: Math.sin(theta / 2), z: 0, w: Math.cos(theta / 2) });

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function rotateV(q: Quat, v: V3): V3 {
  const p = quatMul(quatMul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), quatConj(q));
  return { x: p.x, y: p.y, z: p.z };
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export function slerp(a: Quat, b0: Quat, t: number): Quat {
  let b = b0;
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (cos < 0) {
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    cos = -cos;
  }
  if (cos > 0.9995) {
    return quatNormalize({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t });
  }
  const th = Math.acos(cos);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb, w: a.w * wa + b.w * wb };
}

/** Game heading of a body from its world rotation (projection of local +X). */
export function headingOf(q: Quat): number {
  const fx = rotateV(q, { x: 1, y: 0, z: 0 });
  return Math.atan2(-fx.z, fx.x);
}

/** World-space direction of the body's local +Y axis. */
export function upOf(q: Quat): V3 {
  return rotateV(q, { x: 0, y: 1, z: 0 });
}

/** Shortest-arc rotation taking unit vector a to unit vector b. */
export function quatFromTo(a: V3, b: V3): Quat {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -0.999999) {
    // 180°: pick any orthogonal axis
    const ax = Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const c = { x: a.y * ax.z - a.z * ax.y, y: a.z * ax.x - a.x * ax.z, z: a.x * ax.y - a.y * ax.x };
    return quatNormalize({ ...c, w: 0 });
  }
  const c = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  return quatNormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}

/** Collision groups (membership << 16 | filter). */
export const GROUP = {
  FIELD: 1 << 0,
  ROBOT: 1 << 1,
  FREE: 1 << 2,
  STACKED: 1 << 3,
  HELD: 1 << 4,
  POST: 1 << 5,
  TOGGLE: 1 << 6,
  WHEEL: 1 << 7,
  GHOST: 1 << 8,
};

export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const G = GROUP;
export const CG = {
  field: groups(G.FIELD, G.ROBOT | G.FREE | G.HELD | G.WHEEL),
  post: groups(G.POST, G.ROBOT | G.FREE | G.HELD),
  robot: groups(G.ROBOT, G.FIELD | G.ROBOT | G.FREE | G.STACKED | G.POST | G.TOGGLE),
  wheel: groups(G.WHEEL, G.FIELD),
  free: groups(G.FREE, G.FIELD | G.ROBOT | G.FREE | G.STACKED | G.POST | G.HELD | G.TOGGLE),
  stacked: groups(G.STACKED, G.ROBOT | G.FREE | G.HELD),
  held: groups(G.HELD, G.FIELD | G.FREE | G.STACKED | G.POST),
  toggle: groups(G.TOGGLE, G.ROBOT | G.FREE),
  ghost: groups(G.GHOST, 0),
};
