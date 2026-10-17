import type { CartridgeRpm, MotorGroupConfig } from './config';

/**
 * V5 Smart Motor (11 W) as a linear DC motor: τ(ω) = τ_stall · (V/V_nom − ω/ω_free).
 * Published figures (approximate): free speed 100/200/600 rpm; stall torque at the
 * cartridge output ≈ 2.1 / 1.05 / 0.35 N·m. The V5 motor caps its output voltage at
 * 12 V; a sagging battery lowers the effective cap.
 */
export const V_NOM = 12;

const STALL_NM: Record<CartridgeRpm, number> = { 100: 2.1, 200: 1.05, 600: 0.35 };

export interface MotorModel {
  stallTorqueNm: number;
  freeSpeedRadS: number;
}

export function cartridge(rpm: CartridgeRpm): MotorModel {
  return { stallTorqueNm: STALL_NM[rpm], freeSpeedRadS: (rpm * 2 * Math.PI) / 60 };
}

export function effectiveVoltage(battery: number): number {
  // V5 battery nominal 12.8 V; motors regulate to ≤ 12 V. Under load the pack sags ~0.8 V.
  return Math.max(0, Math.min(V_NOM, battery - 0.8));
}

/**
 * Torque at the motor-group OUTPUT shaft (after gearing), given command in [-1, 1]
 * and output angular speed ω_out (rad/s). Includes back-EMF and voltage limits.
 */
export function groupTorque(group: MotorGroupConfig, command: number, omegaOut: number, battery: number, perfScale = 1): number {
  const m = cartridge(group.cartridgeRpm);
  const vMax = effectiveVoltage(battery);
  const u = Math.max(-1, Math.min(1, command)) * (vMax / V_NOM);
  const omegaMotor = omegaOut / group.gearRatio; // rad/s at the cartridge output
  const tauMotor = m.stallTorqueNm * perfScale * (u - omegaMotor / m.freeSpeedRadS);
  // Current limit: torque cannot exceed stall magnitude.
  const lim = m.stallTorqueNm * perfScale;
  const tau = Math.max(-lim, Math.min(lim, tauMotor));
  return (tau * group.motorCount) / group.gearRatio;
}

/** Free speed of the group output (rad/s) at full command. */
export function groupFreeSpeed(group: MotorGroupConfig, battery: number): number {
  const m = cartridge(group.cartridgeRpm);
  return m.freeSpeedRadS * group.gearRatio * (effectiveVoltage(battery) / V_NOM);
}

/** Electrical utilization proxy |τ|/τ_stall per motor, for the analysis dashboard. */
export function utilization(group: MotorGroupConfig, outputTorque: number): number {
  const m = cartridge(group.cartridgeRpm);
  return Math.min(1, Math.abs(outputTorque * group.gearRatio) / (m.stallTorqueNm * group.motorCount));
}
