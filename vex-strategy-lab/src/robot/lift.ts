import type { RobotConfig } from './config';

/**
 * Lift transmission shared by the planner's kinematic model, the physics engine
 * and the 3D view, so all three move the holder identically.
 *
 * DR4B (double reverse four-bar): the lower four-bar pivots on the towers and
 * rises at angle θ to the knee; the upper four-bar is reversed and rises at the
 * same angle back over the towers, so the end effector moves straight up:
 *
 *   holder height h(θ) = h(θmin) + 2L·(sin θ − sin θmin)
 *   dh/dθ = 2L·cos θ           (the "effective radius" the motor sees)
 *
 * A given motor torque therefore lifts hardest where cos θ is small (near the
 * top) and fastest where the bars are level. The knee swings backward by L·cos θ.
 *
 * Rack and pinion: dh/dθ = pinion pitch radius, constant.
 */

/** Vertical spacing of the two parallel bars in each four-bar stage (in). */
export const DR4B_PIVOT_SPACING = 1.5;
/** Height of the carriage's lower top-pivot above the holder bottom (in). */
export const DR4B_TOP_PIVOT_ABOVE_HOLDER = 1.5;

const rad = (d: number) => (d * Math.PI) / 180;

/** Total holder travel (in). */
export function liftTravel(cfg: RobotConfig): number {
  const l = cfg.lift;
  if (l.type === 'dr4b') return 2 * l.barLengthIn * (Math.sin(rad(l.maxAngleDeg)) - Math.sin(rad(l.minAngleDeg)));
  return l.travelIn;
}

/** DR4B bar angle (rad) for a lift displacement d (in) above the lowest position. */
export function dr4bAngle(cfg: RobotConfig, d: number): number {
  const l = cfg.lift;
  const s = Math.sin(rad(l.minAngleDeg)) + d / (2 * l.barLengthIn);
  return Math.asin(Math.max(-1, Math.min(1, s)));
}

/** Effective radius dh/dθ_output (in) at displacement d: the motor torque → lift force lever arm. */
export function liftRadius(cfg: RobotConfig, d: number): number {
  const l = cfg.lift;
  // keep away from the singular straight-up bar (no lift authority, infinite force)
  if (l.type === 'dr4b') return Math.max(0.25 * l.barLengthIn, 2 * l.barLengthIn * Math.cos(dr4bAngle(cfg, d)));
  return l.pinionPitchDiameterIn / 2;
}

/**
 * Mass the lift motor accelerates and holds up, as seen at the holder (lb). The bars'
 * centers rise at ¼ (lower stage) and ¾ (upper stage) of the holder's rate, so half
 * the bar mass is equivalent at the holder for both gravity and inertia.
 */
export function liftMovingMassLb(cfg: RobotConfig): number {
  return cfg.lift.carriageMassLb + (cfg.lift.type === 'dr4b' ? 0.5 * cfg.lift.barMassLb : 0);
}

export interface Dr4bLayout {
  theta: number;
  /** Height of the lower tower pivot (in). */
  baseY: number;
  /** Knee horizontal distance behind the tower pivots (in). */
  kneeBack: number;
  /** Lower knee pivot height (in). */
  kneeY: number;
  /** Lower carriage pivot height (in). */
  topY: number;
}

/** Linkage layout for a lift displacement d (in). */
export function dr4bLayout(cfg: RobotConfig, d: number): Dr4bLayout {
  const l = cfg.lift;
  const L = l.barLengthIn;
  const s = DR4B_PIVOT_SPACING;
  const baseY = l.holderMinHeightIn + DR4B_TOP_PIVOT_ABOVE_HOLDER - s - 2 * L * Math.sin(rad(l.minAngleDeg));
  const theta = dr4bAngle(cfg, d);
  const kneeY = baseY + L * Math.sin(theta);
  return { theta, baseY, kneeBack: L * Math.cos(theta), kneeY, topY: kneeY + s + L * Math.sin(theta) };
}

/** Largest backward knee swing over the lift's range (in): at the angle closest to level. */
export function dr4bMaxKneeBack(cfg: RobotConfig): number {
  const l = cfg.lift;
  const th = l.minAngleDeg <= 0 && l.maxAngleDeg >= 0 ? 0 : Math.min(Math.abs(rad(l.minAngleDeg)), Math.abs(rad(l.maxAngleDeg)));
  return l.barLengthIn * Math.cos(th);
}
