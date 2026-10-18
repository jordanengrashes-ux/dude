import type { Alliance } from '../rules/ruleset';
import type { Vec2 } from '../core/vec';

/**
 * Robot configuration. Defaults describe the user's robot as given:
 *   16" × 16" chassis, four-wheel drive, double reverse four-bar (DR4B) lift.
 * Everything else (wheel size, gearing, mass, mechanism geometry) was NOT given,
 * so each such value is listed in ASSUMED_FIELDS and shown as "assumed" in the UI.
 *
 * Mechanism concept (assumed, editable): a U-shaped chassis whose open front slot
 * lets a Goal post enter the footprint; the lift (a DR4B by default, or a linear
 * rack and pinion) carries a holder whose axis sits in that slot and moves
 * straight up. The holder grips one Pin and (optionally) one Cup in a secondary
 * pocket, matching the 1 Pin + 1 Cup possession limit.
 */

export type LiftType = 'dr4b' | 'rackPinion';

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
  lift: {
    /**
     * 'dr4b': double reverse four-bar. Two four-bar stages of equal bar length,
     * the upper reversed, so the end effector rises straight up while the middle
     * "knee" swings backward. Holder height = h(θmin) + 2L(sin θ − sin θmin).
     * 'rackPinion': a carriage on a vertical rack driven by a pinion.
     */
    type: LiftType;
    /** Lift motors; for a DR4B the gear ratio is bar rpm / motor rpm. */
    motor: MotorGroupConfig;
    /** Moving end effector (carriage, holder) mass. */
    carriageMassLb: number;
    /** Height of the held object's bottom when the lift is fully retracted. */
    holderMinHeightIn: number;
    /** Height of the carriage structure above the holder bottom. */
    carriageHeightIn: number;
    /** Rack and pinion: carriage travel and pinion pitch diameter. */
    travelIn: number;
    pinionPitchDiameterIn: number;
    /** DR4B: bar length pivot to pivot (both stages), bar angle range from horizontal, mass of all bars. */
    barLengthIn: number;
    minAngleDeg: number;
    maxAngleDeg: number;
    barMassLb: number;
  };
  intake: {
    /** Forward distance from chassis center to the holder axis (inside the slot). */
    holderOffsetIn: number;
    /** Forward capture window (in) in front of the holder axis while intaking. */
    captureDepthIn: number;
    captureHalfWidthIn: number;
    intakeTimeSec: number;
    releaseTimeSec: number;
    /**
     * 'single': a claw that holds one piece (a Pin + Cup nested on it rides along and
     * is dropped with it). 'pinAndCup': a two-pocket holder, one Pin + one Cup.
     */
    capacity: 'single' | 'pinAndCup';
    /** The claw only grabs Pins within this many degrees of upright. */
    maxPinTiltDeg: number;
    indexTimeSec: number;
    canReorient: boolean;
    reorientTimeSec: number;
    /** Max lateral misalignment the holder/goal funnel tolerates when placing. */
    placeToleranceIn: number;
  };
  toggleArm: {
    actuateTimeSec: number;
    /** How far the arm reaches past the front bumper (in). */
    reachIn: number;
    /** Height of the arm paddle (in); must clear the 11.5" wall to reach a Toggle. */
    heightIn: number;
    /** Lateral position of the paddle from the robot centerline, + = left (in). Off the slot so it never meets a stack. */
    lateralIn: number;
  };
  /**
   * Execution overheads (s) the physical controller adds beyond the planner's
   * kinematic time model: final alignment, settling, backing off. Measured by
   * sim/calibrate.ts from physics runs; re-run "Calibrate" after changing the robot.
   */
  execution: {
    pickOverheadSec: number;
    placeOverheadSec: number;
    toggleOverheadSec: number;
    loadOverheadSec: number;
    parkOverheadSec: number;
    calibratedFrom: string;
  };
  start: {
    pos: Vec2;
    heading: number;
  };
}

export const DEFAULT_ROBOT: RobotConfig = {
  name: 'User robot (16×16 4WD, DR4B lift)',
  alliance: 'red',
  chassis: {
    lengthIn: 16,
    widthIn: 16,
    towerHeightIn: 10, // DR4B towers carry the lower pivots (a rack-and-pinion tower is taller)
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
  lift: {
    type: 'dr4b',
    // two 200 rpm motors, 12T → 84T (1:7) onto the lower bars
    motor: { cartridgeRpm: 200, gearRatio: 1 / 7, motorCount: 2, direction: 1 },
    carriageMassLb: 1.2,
    holderMinHeightIn: 0.4,
    carriageHeightIn: 5,
    travelIn: 20,
    pinionPitchDiameterIn: 1.0,
    barLengthIn: 8.5,
    minAngleDeg: -25,
    maxAngleDeg: 50,
    barMassLb: 0.8,
  },
  intake: {
    holderOffsetIn: 4.5,
    captureDepthIn: 5,
    captureHalfWidthIn: 2.2,
    intakeTimeSec: 0.35,
    releaseTimeSec: 0.25,
    capacity: 'single',
    maxPinTiltDeg: 20,
    indexTimeSec: 0.35,
    canReorient: true,
    reorientTimeSec: 0.4,
    placeToleranceIn: 0.6,
  },
  toggleArm: { actuateTimeSec: 0.6, reachIn: 1.5, heightIn: 12.5, lateralIn: 5.5 },
  execution: {
    pickOverheadSec: 0.08,
    placeOverheadSec: 1.7,
    toggleOverheadSec: 1.2,
    loadOverheadSec: 0.3,
    parkOverheadSec: 0.2,
    calibratedFrom:
      'Default DR4B robot, Skills plans, 4 jittered physics runs × 4 refinement passes (22–33 actions each): place 1.55–1.84 s, toggle 0.6–1.9 s (few toggle samples), pick ≈ 0.08 s; 2026-10-17',
  },
  start: { pos: { x: -61, y: -36 }, heading: 0 },
};

/** Config paths that are user-given (everything else is an assumption). */
export const GIVEN_FIELDS = ['chassis.lengthIn', 'chassis.widthIn', 'drivetrain.type', 'lift.type'];

/** Human-readable list of assumed parameters, displayed in the Robot panel. */
export const ASSUMED_FIELDS: { path: string; label: string; why: string }[] = [
  { path: 'drivetrain.wheelDiameterIn', label: 'Wheel diameter 3.25"', why: 'Common VEX omni wheel size; not specified.' },
  { path: 'drivetrain.left.cartridgeRpm', label: '600 rpm cartridges, 0.75 ratio (450 rpm)', why: 'Typical competition drivetrain; not specified.' },
  { path: 'drivetrain.muLateral', label: 'Lateral μ 0.35', why: 'Mixed omni/traction estimate.' },
  { path: 'mass.totalLb', label: 'Mass 15 lb', why: 'Typical V5 competition robot.' },
  { path: 'lift.barLengthIn', label: 'DR4B bars 8.5" (pivot to pivot)', why: 'Gives ~20" of travel over −25°…50° and keeps the knee inside the 16" footprint.' },
  { path: 'lift.minAngleDeg', label: 'DR4B bar angles −25° to 50°', why: 'Typical hard-stop range; not specified.' },
  { path: 'lift.motor.gearRatio', label: 'DR4B: 2 × 200 rpm motors, 1:7', why: 'Common 12T:84T DR4B gearing; not specified.' },
  { path: 'lift.barMassLb', label: 'Bar mass 0.8 lb', why: 'Eight aluminum bars plus knee brackets, estimated.' },
  { path: 'intake.capacity', label: 'Claw holds one piece', why: 'A claw grips one piece; a Pin + Cup nested on it rides along. The two-pocket holder (1 Pin + 1 Cup) is selectable.' },
  { path: 'intake.maxPinTiltDeg', label: 'Grabs Pins up to 20° from upright', why: 'The claw closes around a standing Pin; lying Pins slip out.' },
  { path: 'chassis.slotWidthIn', label: 'U-chassis 6" front slot', why: 'Lets a Goal post enter the footprint so the robot stays 16" × 16".' },
];

export function cloneRobot(c: RobotConfig = DEFAULT_ROBOT): RobotConfig {
  return JSON.parse(JSON.stringify(c));
}
