import type { ColliderDesc } from '@dimforge/rapier3d-deterministic-compat';
import { IN } from '../core/units';
import { CUP, GOAL_SOCKET, PIN } from '../field/geometry';
import type { Rapier } from './rapier';

/**
 * Collision shapes that follow the Pin and Cup geometry (field/geometry.ts) instead
 * of plain cylinders, in body coordinates (meters, axis along local Y):
 *  - Pin: its band and the two cones as three convex hulls (one hull over the whole
 *    profile would fill in the step from band to cone and make the Pin too fat to
 *    sit in a Cup or a Goal socket).
 *  - Cup: a hollow hourglass — each half's conical wall as `CUP_SEGMENTS` convex
 *    wedges, plus the web at the waist — so a Pin can drop into a loose Cup and a
 *    Cup lying on its side rolls on its rims.
 *  - Goal socket: the flared top of a Goal post (solid; the first Pin seats in it).
 */

export const RING = 16;
export const CUP_SEGMENTS = 8; // 10+ keeps resting Cups awake and doubles the step cost

function ring(points: number[], r: number, y: number, n = RING, a0 = 0) {
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2;
    points.push(r * Math.cos(a) * IN, y * IN, r * Math.sin(a) * IN);
  }
}

export function pinColliders(R: Rapier): ColliderDesc[] {
  // convex runs of the profile: the band (constant radius), then each cone
  const prof = PIN.profile;
  const band = prof.filter(([r]) => r === prof[0][0]);
  const cone = prof.slice(band.length);
  const out: ColliderDesc[] = [];
  const hull = (rings: [number, number][], sign: 1 | -1 | 0) => {
    const pts: number[] = [];
    rings.forEach(([r, d], i) => {
      // the small end faces get 8 corners: a finer polygon makes a standing Pin rock
      // on its tip for seconds (the solver alternates between nearly coplanar contacts)
      const n = sign !== 0 && i === rings.length - 1 ? 8 : RING;
      if (sign === 0) {
        ring(pts, r, d, n);
        ring(pts, r, -d, n);
      } else ring(pts, r, sign * d, n);
    });
    out.push(R.ColliderDesc.convexHull(new Float32Array(pts))!);
  };
  hull(band, 0);
  hull(cone, 1);
  hull(cone, -1);
  return out;
}

export function cupColliders(R: Rapier): ColliderDesc[] {
  const ro = CUP.diameter / 2;
  const rw = CUP.waistDiameter / 2;
  const t = CUP.wall;
  const out: ColliderDesc[] = [];
  for (const s of [1, -1]) {
    for (let k = 0; k < CUP_SEGMENTS; k++) {
      const a0 = (k / CUP_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / CUP_SEGMENTS) * Math.PI * 2;
      const pts: number[] = [];
      for (const a of [a0, a1]) {
        for (const [r, y] of [
          [ro, s * CUP.half],
          [ro - t, s * CUP.half],
          [rw, s * CUP.web],
          [rw - t, s * CUP.web],
        ]) {
          pts.push(r * Math.cos(a) * IN, y * IN, r * Math.sin(a) * IN);
        }
      }
      out.push(R.ColliderDesc.convexHull(new Float32Array(pts))!);
    }
  }
  out.push(R.ColliderDesc.cylinder(CUP.web * IN, rw * IN));
  return out;
}

/** Flared socket on top of a Goal post of height `h` and radius `postR` (inches), at the origin. */
export function goalSocketCollider(R: Rapier, h: number, postR: number, floor: number): ColliderDesc {
  const pts: number[] = [];
  const y0 = Math.max(floor, h - GOAL_SOCKET.depth - 0.1);
  ring(pts, postR, y0);
  ring(pts, GOAL_SOCKET.topRadius, h);
  return R.ColliderDesc.convexHull(new Float32Array(pts))!;
}
