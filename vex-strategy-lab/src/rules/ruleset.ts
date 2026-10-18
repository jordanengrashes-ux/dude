import { LAST_CHECKED, type Verification } from './sources';

/**
 * VEX V5RC Override (2026–2027) ruleset — the single source of truth for every
 * game number the simulator uses. Nothing in physics, planning or UI may hardcode
 * a point value; everything reads from an OverrideParams object.
 *
 * Each parameter is backed by a RuleRecord (below) that names its rule ID, the
 * sources it was extracted from, the manual version, and how it was verified.
 */

export type Alliance = 'red' | 'blue';
export type HalfColor = 'red' | 'blue' | 'yellow';
export type MatchType = 'headToHead' | 'skillsDriver' | 'skillsAuton';
export type AwpVariant = 'standard' | 'qualifyingEvent';

export interface AwpCriteria {
  /** Minimum Pins Scored for the Alliance (only own-side Quadrants count when ownSideOnly). */
  minPinsScored: number;
  /** Minimum number of Goals that each contain at least `minPinsPerGoal` Pins Scored for the Alliance. */
  minGoals: number;
  minPinsPerGoal: number;
  /** Neither Alliance Robot may contact the Field Perimeter at the end of Autonomous. */
  noPerimeterContact: boolean;
  /** At least one Alliance Robot must be in the Midfield at the end of Autonomous. */
  requireMidfieldRobot: boolean;
}

export interface OverrideParams {
  name: 'V5RC Override';
  season: '2026-2027';
  manualVersion: string;
  timing: {
    autonomousSec: number;
    driverSec: number;
    /** Final N seconds of the Driver Controlled Period. */
    endgameSec: number;
    skillsSec: number;
  };
  points: {
    alliancePinHalf: number;
    ownedYellowPinHalf: number;
    robotInMidfield: number;
    autonomousBonus: number;
    autonomousBonusTieEach: number;
  };
  scoring: {
    /** Max Pin halves nested in one Goal or one Cup half (SC2). */
    maxPinHalvesPerSocket: number;
    /** If true, the bottom half of the first Pin nested in a Goal is not "fully visible". */
    goalObscuresNestedHalf: boolean;
    /** If true, a Pin contacted by a Robot at the end of the Match does not score. */
    robotContactInvalidates: boolean;
    /** Midfield Goal ownership is never active at the end of Autonomous (Q&A 3188). */
    midfieldOwnershipInAutonomous: boolean;
  };
  awp: {
    variant: AwpVariant;
    standard: AwpCriteria;
    qualifyingEvent: AwpCriteria;
    /** Count Owned yellow halves toward "Pins Scored for your Alliance". */
    ownedYellowCounts: boolean;
    /** Ignore Goals in Quadrants on the opposing side of the Autonomous Line. */
    ownSideOnly: boolean;
  };
  robot: {
    startMaxIn: { length: number; width: number; height: number };
    horizontalMaxPreEndgameIn: number;
    horizontalMaxEndgameIn: number;
    verticalMaxIn: number;
    verticalLimitAppliesInEndgame: boolean;
  };
  possession: { maxPins: number; maxCups: number };
  matchLoads: {
    allowedInAutonomous: boolean;
    /** Seconds for a Drive Team Member to introduce one object into a Loader (modeling estimate). */
    humanLoadSec: number;
  };
  skills: {
    robotAlliance: Alliance;
    /** In Skills, red and blue halves both score the alliance-half value. */
    bothColorHalvesScore: boolean;
    /** Toggle color that grants yellow ownership in Skills. */
    ownedToggleColor: Alliance;
    matchLoadPins: { redYellow: number; blueYellow: number };
    matchLoadCups: number;
  };
}

export const OVERRIDE_DEFAULTS: OverrideParams = {
  name: 'V5RC Override',
  season: '2026-2027',
  manualVersion: '2.1',
  timing: { autonomousSec: 15, driverSec: 105, endgameSec: 10, skillsSec: 60 },
  points: {
    alliancePinHalf: 5,
    ownedYellowPinHalf: 10,
    robotInMidfield: 8,
    autonomousBonus: 12,
    autonomousBonusTieEach: 6,
  },
  scoring: {
    maxPinHalvesPerSocket: 1,
    goalObscuresNestedHalf: false,
    robotContactInvalidates: false,
    midfieldOwnershipInAutonomous: false,
  },
  awp: {
    variant: 'standard',
    standard: { minPinsScored: 6, minGoals: 2, minPinsPerGoal: 2, noPerimeterContact: true, requireMidfieldRobot: false },
    qualifyingEvent: { minPinsScored: 7, minGoals: 3, minPinsPerGoal: 2, noPerimeterContact: true, requireMidfieldRobot: true },
    ownedYellowCounts: true,
    ownSideOnly: true,
  },
  robot: {
    startMaxIn: { length: 18, width: 18, height: 18 },
    horizontalMaxPreEndgameIn: 18,
    horizontalMaxEndgameIn: 24,
    verticalMaxIn: 50,
    verticalLimitAppliesInEndgame: false,
  },
  possession: { maxPins: 1, maxCups: 1 },
  matchLoads: { allowedInAutonomous: false, humanLoadSec: 1.5 },
  skills: {
    robotAlliance: 'red',
    bothColorHalvesScore: true,
    ownedToggleColor: 'red',
    matchLoadPins: { redYellow: 3, blueYellow: 4 },
    matchLoadCups: 7,
  },
};

export function cloneParams(p: OverrideParams = OVERRIDE_DEFAULTS): OverrideParams {
  return JSON.parse(JSON.stringify(p));
}

export interface RuleRecord {
  /** Official rule identifier when known (e.g. "SC3"); descriptive key otherwise. */
  ruleId: string;
  title: string;
  /** What the simulator implements, in plain English. */
  implemented: string;
  /** Path into OverrideParams (dot notation) for numeric/boolean parameters, if any. */
  param?: string;
  sources: string[];
  manualVersion: string;
  lastChecked: string;
  verification: Verification;
  notes?: string;
}

const R = (r: Omit<RuleRecord, 'lastChecked' | 'manualVersion'> & { manualVersion?: string }): RuleRecord => ({
  manualVersion: r.manualVersion ?? '2.1 (online); text obtained via search extracts',
  lastChecked: LAST_CHECKED,
  ...r,
});

/** Every rule the simulator implements, with provenance. Rendered in the Rules panel. */
export const OVERRIDE_RULES: RuleRecord[] = [
  R({ ruleId: 'Match timing', title: 'Autonomous 0:15, Driver Controlled 1:45', implemented: '15 s Autonomous Period followed by a 105 s Driver Controlled Period.', param: 'timing', sources: ['gamePage', 'atlantaHobby'], verification: 'official-extract' }),
  R({ ruleId: 'Endgame', title: 'Endgame = final 10 s of the Match', implemented: 'Endgame begins with 10 s remaining in the Driver Controlled Period.', param: 'timing.endgameSec', sources: ['atlantaHobby', 'qa'], verification: 'secondary', notes: 'Q&A references the Endgame period; exact length seen only in secondary summaries.' }),
  R({ ruleId: 'Field', title: '140.41" field: 6 × 6 foam tiles inside an 11.5" wall', implemented: 'Inside 140.41" wall to wall (1.27" thick, 11.5" tall), tile seams 23.545" apart (the outer tiles are trimmed).', sources: ['manualPdf11'], verification: 'official-extract', notes: 'Measured on the Appendix A field drawing; the perimeter sheet rounds to ~140.5".' }),
  R({ ruleId: 'Game objects', title: '63 Pins, 56 Cups, 9 Goals, 4 Toggles, 4 Loaders', implemented: 'Exact counts; see field layout for color split.', sources: ['gamePage', 'manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'Pin colors', title: 'Pin color split', implemented: '4 red/blue (field), 20 red/yellow (2 preload, 10 match load, 8 field), 20 blue/yellow (2 preload, 10 match load, 8 field), 19 yellow/yellow (2 match load, 17 field).', sources: ['manualOnline'], verification: 'official-extract', notes: 'Blue/yellow and yellow/yellow splits seen in a manual extract; red/yellow split assumed symmetric.' }),
  R({ ruleId: 'Cup split', title: 'Cup split', implemented: '20 match loads (10 per Alliance), 24 start gray-side-up, 12 start clear-side-up.', sources: ['manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'Goals', title: 'Goal types and heights', implemented: '4 Alliance Goals (2 red, 2 blue) 3.25", 4 short neutral Goals 5.77", 1 tall Midfield Goal 8.77"; octagonal columns on Field Element Plates, Ø2.37" socket opening.', sources: ['manualPdf11', 'forumDims'], verification: 'official-extract', notes: 'Heights and opening from the Appendix A Goal sheets. Column and plate widths are assumptions sized to the robot slot.' }),
  R({ ruleId: 'Field perimeter', title: 'Wall height', implemented: 'Walls 11.5" tall (nominal).', sources: ['perimeterQA'], verification: 'official-extract', notes: 'GDC Q&A: wall height must be 11.5"–12.5"; older VEX field drawings give 11.50".' }),
  R({ ruleId: 'Toggle geometry', title: 'Toggle shape and mount', implemented: 'Triangular bar 25.8" long with 2.05" faces (red, yellow, blue), lying on top of the middle of each wall and rotating about its long axis; three detents 120° apart.', sources: ['forumDims', 'manualOnline'], verification: 'secondary', notes: 'Dimensions from a forum transcription of Appendix A. The exact mount position (axis above the inner wall edge) is an assumption.' }),
  R({ ruleId: 'Goal positions', title: '8 Goals 1 tile from one wall and 2 tiles from another', implemented: 'Goals at (±2, ±1) and (±1, ±2) tiles from center; Midfield Goal at center.', sources: ['appendixA', 'manualOnline'], verification: 'official-extract', notes: 'Which of those positions hold Alliance vs neutral Goals follows the Appendix A callouts (red lower-left, blue upper-right) under 180° symmetry — exact assignment is an inference.' }),
  R({ ruleId: 'Quadrants', title: 'Four triangular Quadrants', implemented: 'Quadrants are the four triangles formed by the diagonal Autonomous Line tape; each contains 2 Goals and 1 Toggle. Red 1 is adjacent to the red Alliance Station.', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'Autonomous Line', title: 'Diagonal white tape lines', implemented: 'Pair of diagonal tape lines (an X) around the Midfield; the red side is the two red Quadrants.', sources: ['manualOnline'], verification: 'official-extract', notes: 'Which diagonal separates the alliance sides is inferred from Quadrant naming.' }),
  R({ ruleId: 'Midfield', title: 'Midfield volume', implemented: 'Infinitely tall volume inside the inner edges of the white tape diamond whose centerline runs through the four-tile corners (±1 tile on the axes).', sources: ['manualPdf11'], verification: 'official-extract', notes: 'Tape strips measured at 0.75" on the tape sheet; the manual\'s glossary calls it a square (it is turned 45°).' }),
  R({ ruleId: 'SC2', title: 'Placed Pin', implemented: 'A Pin is Placed if nested with a Goal, or with a Cup nested with another Placed Pin; at most one Pin half per Goal or Cup half.', param: 'scoring.maxPinHalvesPerSocket', sources: ['qa'], verification: 'official-extract' }),
  R({ ruleId: 'SC3', title: 'Scored Pin half', implemented: 'Each half of a Placed Pin is Scored only if fully visible — i.e. not nested (even partially) inside the gray (opaque) half of a Cup.', sources: ['qa', 'manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'SC3 / goal nesting', title: 'Half nested in a Goal', implemented: 'The half nested in a Goal remains visible (Scored).', param: 'scoring.goalObscuresNestedHalf', sources: ['forumDims'], verification: 'assumption', notes: 'Only a forum statement supports this. Toggle the parameter to test the alternative.' }),
  R({ ruleId: 'RSC3.a.iv (removed)', title: 'Robot contact does not affect Scoring', implemented: 'Robot contact with Pins/Cups has no effect on Scoring.', param: 'scoring.robotContactInvalidates', sources: ['qa'], verification: 'official-extract', notes: 'Q&A says the clause was removed in the September update.' }),
  R({ ruleId: 'SC4', title: 'Toggle set to a color', implemented: 'A Toggle counts for a color only if fully seated in that position and not contacted by any Robot at the end of the period; otherwise neutral.', sources: ['manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'SC5a', title: 'Quadrant yellow ownership', implemented: 'Yellow halves Placed in a Quadrant are Owned by the Alliance whose color that Quadrant\'s Toggle is set to; a neutral Toggle means no owner.', sources: ['manualOnline', 'atlantaHobby'], verification: 'official-extract' }),
  R({ ruleId: 'SC5b', title: 'Midfield Goal yellow ownership', implemented: 'Yellow halves in the Midfield Goal are Owned by the Alliance with more Robots in the Midfield at the end of the Match; equal counts → no owner. Not active at the end of Autonomous.', param: 'scoring.midfieldOwnershipInAutonomous', sources: ['manualOnline', 'qa3188'], verification: 'official-extract' }),
  R({ ruleId: 'SC6', title: 'Robot in the Midfield', implemented: 'A Robot is in the Midfield if any part of it is within the Midfield volume at the end of the Match.', sources: ['manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'Points', title: 'Point values', implemented: 'Alliance-colored Pin half 5; Owned yellow Pin half 10; Robot in Midfield 8; Autonomous Bonus 12.', param: 'points', sources: ['gamePage', 'atlantaHobby'], verification: 'official-extract' }),
  R({ ruleId: 'Autonomous Bonus', title: 'Bonus, ties and violations', implemented: '12 pts to the Alliance with more Autonomous points; 6 each on a tie; any Autonomous violation awards it to the opponent; both violate → none.', param: 'points.autonomousBonus', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'Autonomous scoring', title: 'Midfield excluded in Autonomous', implemented: 'Midfield robot points are not part of Autonomous score calculations.', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'AWP', title: 'Autonomous Win Point', implemented: 'Standard: ≥6 Pins Scored, ≥2 Goals with ≥2 Pins each, no Perimeter contact, no violations. Qualifying-event variant: ≥7 Pins, ≥3 Goals × 2 Pins, plus a Robot in the Midfield.', param: 'awp', sources: ['atlantaHobby', 'qa'], verification: 'conflicting', notes: 'Sources disagree (6 vs 7 Pins; 2 vs 3 Goals). Both variants are selectable. June 4 update: Pins must be Scored, not just Placed.' }),
  R({ ruleId: 'SG (start size)', title: 'Starting size 18" × 18" × 18"', implemented: 'Robot must start within an 18" cube.', param: 'robot.startMaxIn', sources: ['manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'SG (horizontal)', title: 'Horizontal expansion', implemented: 'Never larger than 24" × 24"; expansion beyond 18" × 18" before the Endgame is a violation.', param: 'robot', sources: ['manualOnline', 'qa'], verification: 'conflicting', notes: 'The 24" limit is in a manual extract; the 18" pre-Endgame limit comes from a Q&A answer that may predate the current version.' }),
  R({ ruleId: 'SG (vertical)', title: 'Vertical expansion 50"', implemented: 'No part of the Robot above 50" before the Endgame.', param: 'robot.verticalMaxIn', sources: ['manualOnline', 'atlantaHobby'], verification: 'conflicting', notes: 'One copy says the limit applies only until the Endgame begins.' }),
  R({ ruleId: 'SG (possession)', title: 'Possession limit', implemented: 'At most one Pin and one Cup in Possession at a time. A claw carrying a bigger nested stack in a match is flagged (minor); bots never take more than the limit.', param: 'possession', sources: ['manualOnline'], verification: 'official-extract' }),
  R({ ruleId: 'SG7', title: 'Autonomous Line', implemented: 'During Autonomous, Robots may not contact tiles, Scoring Objects or Field Elements on the opposing side of the Autonomous Line.', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'SG8', title: 'Midfield/Autonomous Line interaction risk', implemented: 'Contact between robots engaging the Midfield or Autonomous Line is legal (accepted risk).', sources: ['qa'], verification: 'official-extract' }),
  R({ ruleId: 'SG9', title: 'Alliance Goals are protected', implemented: 'Robots may not Place in or remove from opposing Alliance-colored Goals.', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'SG10', title: 'No removal from neutral/opposing Goals', implemented: 'Scoring Objects may not be removed from neutral or opposing Alliance Goals; removal from your own Alliance Goals is allowed.', sources: ['manualOnline', 'qa'], verification: 'official-extract', notes: 'Q&A: each removed Pin is valued at 10 points when judging match-affecting severity.' }),
  R({ ruleId: 'SG11', title: 'Match Loads', implemented: 'A Match Load is introduced when a Drive Team Member releases it into a Loader; Robots may not contact it before then.', sources: ['qa'], verification: 'official-extract' }),
  R({ ruleId: 'Match loads in Autonomous', title: 'Loading during Autonomous', implemented: 'Disabled by default.', param: 'matchLoads.allowedInAutonomous', sources: ['qa'], verification: 'conflicting', notes: 'A forum answer says no; a VEX U Q&A says Pins may be loaded. V5RC answer not found.' }),
  R({ ruleId: 'SG12', title: 'No Placing on the Midfield Goal in the Endgame', implemented: 'Placing on the Midfield Goal during the Endgame is a violation.', sources: ['manualOnline', 'qa'], verification: 'official-extract' }),
  R({ ruleId: 'Load Zones', title: 'Load Zones protected', implemented: 'Opposing Robots may not enter a Load Zone during the Driver Controlled Period. Each Load Zone runs 24.47" along the Alliance Station wall from the corner and 11.56" out, to the outer edge of its colored tape.', sources: ['manualOnline', 'manualPdf11'], verification: 'official-extract' }),
  R({ ruleId: 'Robot Skills timing', title: 'Skills Matches are 60 s', implemented: 'Driver Skills and Autonomous Coding Skills are each 60 s with one Robot.', param: 'timing.skillsSec', sources: ['atlantaHobby'], verification: 'secondary' }),
  R({ ruleId: 'RSC4', title: 'Skills field setup', implemented: 'All Goals start empty; Match Loads are 3 red/yellow Pins, 4 blue/yellow Pins and 7 Cups.', param: 'skills', sources: ['manualOnline', 'manualsPlus'], verification: 'secondary', notes: '"Goals begin empty" is in a manual extract; Match Load counts are from an aggregator copy.' }),
  R({ ruleId: 'Skills scoring', title: 'Skills point values', implemented: '5 per red or blue Pin half, 10 per Owned yellow half (Toggle set to the robot\'s color), 8 for ending in the Midfield.', param: 'skills', sources: ['atlantaHobby', 'manualOnline'], verification: 'secondary', notes: 'Which Toggle color grants ownership in Skills is an assumption (robot\'s alliance color).' }),
  R({ ruleId: 'Object dimensions', title: 'Pin and Cup shape', implemented: 'Pin: 6.5" long, a Ø3.16" band (0.64" tall) between two cones from Ø2.35" to Ø1.40" tips. Cup: 6.48" hourglass shell, Ø3.16" rims, Ø2.32" waist with a middle web; each half takes one Pin half (band on the rim). Goal tops are conical sockets for the first Pin.', sources: ['manualPdf11'], verification: 'official-extract', notes: 'From the Appendix A Pin and Cup sheets; wall thickness and web are assumptions. Load the official CAD to replace these shapes.' }),
  R({ ruleId: 'Object masses', title: 'Pin and Cup masses', implemented: 'Pin 0.072 kg, Cup 0.077 kg.', sources: ['forumDims'], verification: 'secondary', notes: 'A forum member weighed them; the spare-parts kit lists 0.15 kg for one Cup and one Pin.' }),
  R({ ruleId: 'Starting positions', title: 'Object and robot starting locations', implemented: 'Official placement: four crosses on the Autonomous Line, red/blue Pins in Cups at the Midfield corners, yellow Pins in Cups on the diagonal, eight wall rows, yellow Pins on the neutral and Midfield Goals; one robot per Quadrant against its wall (Figure SG-1). Editable in the Field Setup panel.', sources: ['manualPdf11'], verification: 'official-extract', notes: 'Coordinates measured on the Appendix A object-placement sheet; the counts match the manual (36 Cups, 33 Pins on the tiles). Robot starts follow Figure SG-1 for a 16" robot.' }),
];

export function rulesByVerification(v: Verification): RuleRecord[] {
  return OVERRIDE_RULES.filter((r) => r.verification === v);
}
