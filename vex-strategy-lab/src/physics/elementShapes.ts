import type { ColliderDesc } from '@dimforge/rapier3d-deterministic-compat';
import { IN } from '../core/units';
import { CUP, GOAL_SOCKET, PIN, socketLift } from '../field/geometry';
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
 *  - Goal socket: the hollow top of a Goal post (the first Pin's lower half drops in).
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

export const SOCKET_SEGMENTS = 12;

/**
 * Hollow socket on top of a Goal post with its rim at `h` (in), at the origin: the
 * bore follows the first Pin's cone with `GOAL_SOCKET.clearance`, so a Pin dropped
 * near the axis slides down into it and comes to rest on its band. Returns the
 * socket walls (convex wedges) and the height of the bore's floor (the post's top).
 */
export function goalSocketColliders(R: Rapier, h: number, postR: number): { parts: ColliderDesc[]; floor: number } {
  const n = SOCKET_SEGMENTS;
  const k = 1 / Math.cos(Math.PI / n); // vertex radius for a given flat-to-flat radius
  const lift = socketLift();
  const prof = PIN.profile;
  const [rTip, dTip] = prof[prof.length - 1];
  const c = GOAL_SOCKET.clearance;
  const rTop = prof[2][0] + c; // where the band's underside meets the cone
  const yLow = h + lift - dTip; // the Pin's tip
  const rLow = rTip + c;
  const floor = Math.max(GOAL_SOCKET.plate, h + lift - PIN.half - 0.08);
  const rOut = rTop + GOAL_SOCKET.rimWidth;
  const parts: ColliderDesc[] = [];
  for (let s = 0; s < n; s++) {
    const pts: number[] = [];
    for (const a of [(s / n) * Math.PI * 2, ((s + 1) / n) * Math.PI * 2]) {
      for (const [r, y] of [
        [rTop, h],
        [rOut, h],
        [rLow, Math.max(floor, yLow)],
        [rLow, floor],
        [Math.max(postR, rLow + 0.2), floor],
      ]) {
        pts.push(r * k * Math.cos(a) * IN, y * IN, r * k * Math.sin(a) * IN);
      }
    }
    parts.push(R.ColliderDesc.convexHull(new Float32Array(pts))!);
  }
  return { parts, floor };
}
