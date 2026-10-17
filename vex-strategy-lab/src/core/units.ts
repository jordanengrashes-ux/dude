/**
 * Unit conventions
 * ----------------
 * Game data (field layout, robot dimensions, rule limits) is expressed in INCHES,
 * matching the official game manual. The physics engine runs in SI units
 * (meters, kilograms, seconds). Conversion happens only at the physics boundary.
 *
 * 2D game frame: origin at field center, +x toward the blue Alliance Station,
 * +y toward the "top" of the overhead diagram. Headings are radians CCW from +x.
 *
 * 3D world frame (Three.js + Rapier): Y is up. World X = game x, world Z = -game y.
 * A rotation about +Y by angle θ maps the chassis forward axis to game heading θ.
 */
export const IN = 0.0254; // meters per inch
export const LB = 0.45359237; // kilograms per pound
export const G = 9.80665; // m/s^2

export const inToM = (v: number) => v * IN;
export const mToIn = (v: number) => v / IN;
export const deg = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
