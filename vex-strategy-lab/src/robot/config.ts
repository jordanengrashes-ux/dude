import type { Alliance } from '../rules/ruleset';
import type { Vec2 } from '../core/vec';

/**
 * Robot configuration. Defaults describe the user's robot as given:
 *   16" × 16" chassis, four-wheel drive, rack-and-pinion mechanism.
 * Everything else (wheel size, gearing, mass, mechanism geometry) was NOT given,
 * so each such value is listed in ASSUMED_FIELDS and shown as "assumed" in the UI.
 *
 * Mechanism concept (assumed, editable): a U-shaped chassis whose open front slot
 * lets a Goal post enter the footprint; a vertical rack-and-pinion lift carries a
 * holder whose axis sits in that slot. The holder grips one Pin and (optionally)
 * one Cup in a secondary pocket, matching the 1 Pin + 1 Cup possession limit.
 */

export type CartridgeRpm = 100 | 200 | 600;

export interface MotorGroupConfig {
  cartridgeRpm: CartridgeRpm;
  /** Output speed ratio: driven rpm / motor rpm (e.g. 0.75 = 600 rpm motor → 450 rpm wheel). */
  gearRatio: number;
  motorCount: number;
  /** +1 / −1 wiring direction. */
  direction: 1 | -1;
}

export interface RobotConfig {
  name: string;
  alliance: Alliance;
  chassis: {
    lengthIn: number;
    widthIn: number;
    /** Height of the frame and lift tower when the lift is fully retracted. */
    towerHeightIn: number;
    frameHeightIn: number;
    groundClearanceIn: number;
    /** Open front slot (U-chassis) that admits a Goal post. */
    slotWidthIn: number;
    slotDepthIn: number;
  };
  drivetrain: {
    type: '4WD-tank';
    wheelDiameterIn: number;
    trackWidthIn: number;
    wheelBaseIn: number;
    left: MotorGroupConfig;
    right: MotorGroupConfig;
    /** Longitudinal (rolling-direction) tire–tile friction coefficient. */
    muLongitudinal: number;
    /** Lateral friction coefficient (omni rollers are low; traction wheels high). */
    muLateral: number;
    /** Kinetic/static friction ratio once a wheel breaks traction. */
    slipRatio: number;
    rollingResistance: number;
  };
  mass: {
    totalLb: number;
    comHeightIn: number;
    comOffsetXIn: number;
    comOffsetYIn: number;
  };
  battery: {
    voltage: number;
  };
  rack: {
    travelIn: number;
    pinionPitchDiameterIn: number;
    motor: MotorGroupConfig;
    carriageMassLb: number;
    /** Height of the held object's bottom when the lift is fully retracted. */
    holderMinHeightIn: number;
    /** Height of the carriage structure above the holder bottom. */
    carriageHeightIn: number;
  };
  intake: {
    /** Forward distance from chassis center to the holder axis (inside the slot). */
    holderOffsetIn: number;
    /** Forward capture window (in) in front of the holder axis while intaking. */
    captureDepthIn: number;
    captureHalfWidthIn: number;
    intakeTimeSec: number;
    releaseTimeSec: number;
    /** Two-pocket holder: one Pin + one Cup. 'single' carries one object. */
    capacity: 'single' | 'pinAndCup';
    indexTimeSec: number;
    canReorient: boolean;
    reorientTimeSec: number;
    /** Max lateral misalignment the holder/goal funnel tolerates when placing. */
    placeToleranceIn: number;
  };
  toggleArm: {
    actuateTimeSec: number;
    reachIn: number;
  };
  start: {
    pos: Vec2;
    heading: number;
  };
}

export const DEFAULT_ROBOT: RobotConfig = {
  name: 'User robot (16×16 4WD rack-and-pinion)',
  alliance: 'red',
  chassis: {
    lengthIn: 16,
    widthIn: 16,
    towerHeightIn: 17.5,
    frameHeightIn: 4,
    groundClearanceIn: 0.75,
    slotWidthIn: 6,
    slotDepthIn: 6.5,
  },
  drivetrain: {
    type: '4WD-tank',
    wheelDiameterIn: 3.25,
    trackWidthIn: 13.5,
    wheelBaseIn: 11,
    left: { cartridgeRpm: 600, gearRatio: 0.75, motorCount: 2, direction: 1 },
    right: { cartridgeRpm: 600, gearRatio: 0.75, motorCount: 2, direction: 1 },
    muLongitudinal: 0.9,
    muLateral: 0.35,
    slipRatio: 0.8,
    rollingResistance: 0.02,
  },
  mass: { totalLb: 15, comHeightIn: 4.5, comOffsetXIn: -0.5, comOffsetYIn: 0 },
  battery: { voltage: 12.8 },
  rack: {
    travelIn: 20,
    pinionPitchDiameterIn: 1.0,
    motor: { cartridgeRpm: 200, gearRatio: 1, motorCount: 1, direction: 1 },
    carriageMassLb: 1.2,
    holderMinHeightIn: 0.4,
    carriageHeightIn: 5,
  },
  intake: {
    holderOffsetIn: 4.5,
    captureDepthIn: 5,
    captureHalfWidthIn: 2.2,
    intakeTimeSec: 0.35,
    releaseTimeSec: 0.25,
    capacity: 'pinAndCup',
    indexTimeSec: 0.35,
    canReorient: true,
    reorientTimeSec: 0.4,
    placeToleranceIn: 0.6,
  },
  toggleArm: { actuateTimeSec: 0.6, reachIn: 1.5 },
  start: { pos: { x: -61, y: -36 }, heading: 0 },
};

/** Config paths that are user-given (everything else is an assumption). */
export const GIVEN_FIELDS = ['chassis.lengthIn', 'chassis.widthIn', 'drivetrain.type'];

/** Human-readable list of assumed parameters, displayed in the Robot panel. */
export const ASSUMED_FIELDS: { path: string; label: string; why: string }[] = [
  { path: 'drivetrain.wheelDiameterIn', label: 'Wheel diameter 3.25"', why: 'Common VEX omni wheel size; not specified.' },
  { path: 'drivetrain.left.cartridgeRpm', label: '600 rpm cartridges, 0.75 ratio (450 rpm)', why: 'Typical competition drivetrain; not specified.' },
  { path: 'drivetrain.muLateral', label: 'Lateral μ 0.35', why: 'Mixed omni/traction estimate.' },
  { path: 'mass.totalLb', label: 'Mass 15 lb', why: 'Typical V5 competition robot.' },
  { path: 'rack.travelIn', label: 'Rack travel 20"', why: 'Sized to stay under the 50" vertical limit.' },
  { path: 'rack.pinionPitchDiameterIn', label: 'Pinion pitch Ø 1.0"', why: 'Estimate for a 12-tooth pinion.' },
  { path: 'intake.capacity', label: 'Holds 1 Pin + 1 Cup', why: 'Matches the possession limit; mechanism design assumed.' },
  { path: 'chassis.slotWidthIn', label: 'U-chassis 6" front slot', why: 'Lets a Goal post enter the footprint so the robot stays 16" × 16".' },
];

export function cloneRobot(c: RobotConfig = DEFAULT_ROBOT): RobotConfig {
  return JSON.parse(JSON.stringify(c));
}
