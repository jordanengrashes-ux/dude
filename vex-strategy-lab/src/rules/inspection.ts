import type { RobotConfig } from '../robot/config';
import { maxHolderHeight, robotTopHeight } from '../robot/kinematics';
import type { OverrideParams } from './ruleset';

/**
 * Robot inspection against the size rules. Scoring Objects in Possession are not
 * part of the Robot and are excluded from size checks (modeling assumption, consistent
 * with typical VEX definitions).
 */

export interface InspectionItem {
  ruleId: string;
  label: string;
  ok: boolean;
  value: string;
  limit: string;
  severity: 'error' | 'warning';
}

export interface InspectionResult {
  passed: boolean;
  items: InspectionItem[];
  /** Highest legal holder height before / during the Endgame. */
  maxLegalHolderHeight: { preEndgame: number; endgame: number };
}

export function inspectRobot(cfg: RobotConfig, params: OverrideParams): InspectionResult {
  const R = params.robot;
  const items: InspectionItem[] = [];
  const L = cfg.chassis.lengthIn;
  const W = cfg.chassis.widthIn;
  const startH = robotTopHeight(cfg, cfg.rack.holderMinHeightIn);
  items.push({
    ruleId: 'SG (start size)',
    label: 'Starting length',
    ok: L <= R.startMaxIn.length,
    value: `${L.toFixed(2)}"`,
    limit: `≤ ${R.startMaxIn.length}"`,
    severity: 'error',
  });
  items.push({ ruleId: 'SG (start size)', label: 'Starting width', ok: W <= R.startMaxIn.width, value: `${W.toFixed(2)}"`, limit: `≤ ${R.startMaxIn.width}"`, severity: 'error' });
  items.push({
    ruleId: 'SG (start size)',
    label: 'Starting height (lift retracted)',
    ok: startH <= R.startMaxIn.height,
    value: `${startH.toFixed(2)}"`,
    limit: `≤ ${R.startMaxIn.height}"`,
    severity: 'error',
  });
  // The mechanism stays inside the chassis footprint (U-slot), so match footprint = chassis.
  const footprint = Math.max(L, W);
  items.push({
    ruleId: 'SG (horizontal)',
    label: 'Footprint before Endgame',
    ok: footprint <= R.horizontalMaxPreEndgameIn,
    value: `${footprint.toFixed(2)}"`,
    limit: `≤ ${R.horizontalMaxPreEndgameIn}"`,
    severity: 'error',
  });
  items.push({
    ruleId: 'SG (horizontal)',
    label: 'Footprint during Endgame',
    ok: footprint <= R.horizontalMaxEndgameIn,
    value: `${footprint.toFixed(2)}"`,
    limit: `≤ ${R.horizontalMaxEndgameIn}"`,
    severity: 'error',
  });
  const maxH = maxHolderHeight(cfg);
  const topAtMax = robotTopHeight(cfg, maxH);
  const tooTall = topAtMax > R.verticalMaxIn;
  items.push({
    ruleId: 'SG (vertical)',
    label: 'Height with lift fully extended',
    ok: !tooTall,
    value: `${topAtMax.toFixed(2)}"`,
    limit: `≤ ${R.verticalMaxIn}" ${R.verticalLimitAppliesInEndgame ? '' : '(before Endgame)'}`,
    severity: tooTall ? 'warning' : 'error',
  });
  const capPins = 1;
  const capCups = cfg.intake.capacity === 'pinAndCup' ? 1 : 0;
  items.push({
    ruleId: 'SG (possession)',
    label: 'Mechanism capacity vs possession limit',
    ok: capPins <= params.possession.maxPins && capCups <= params.possession.maxCups,
    value: `${capPins} Pin + ${capCups} Cup`,
    limit: `≤ ${params.possession.maxPins} Pin + ${params.possession.maxCups} Cup`,
    severity: 'error',
  });
  const legalPre = Math.min(maxH, R.verticalMaxIn - cfg.rack.carriageHeightIn);
  const legalEnd = R.verticalLimitAppliesInEndgame ? legalPre : maxH;
  return {
    passed: items.every((i) => i.ok || i.severity === 'warning'),
    items,
    maxLegalHolderHeight: { preEndgame: legalPre, endgame: legalEnd },
  };
}
