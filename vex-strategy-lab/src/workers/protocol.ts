import type { FieldLayout } from '../field/layout';
import type { RobotConfig } from '../robot/config';
import type { MatchType, OverrideParams } from '../rules/ruleset';
import type { OptimizationReport, OptimizerProgress, OptimizerSettings } from '../planner/optimizer';
import type { ExternalEvent } from '../planner/model';
import type { UncertaintyConfig } from '../planner/robustness';
import type { PhysicsTrialStats, ScenarioConfig } from '../sim/scenario';
import type { CalibrationResult } from '../sim/calibrate';

/** Serializable planning request (no functions — filters are not sent to workers). */
export interface PlanRequest {
  params: OverrideParams;
  robot: RobotConfig;
  layout: FieldLayout;
  matchType: MatchType;
  robotId: string;
  alliance: 'red' | 'blue';
  tStart: number;
  tEnd: number;
  objective: 'own' | 'margin';
  awpWeight: number;
  includeAutonBonus: boolean;
  opponentAutoScore: number;
  externalEvents: ExternalEvent[];
  candidateK: number;
  allowPark: boolean;
  cruiseFraction: number;
  positionSigma: number;
}

export type ToWorker =
  | { type: 'optimize'; id: number; request: PlanRequest; settings: OptimizerSettings }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'physicsTrials'; id: number; scenario: ScenarioConfig; focusSlot: string; uncertainty: UncertaintyConfig; trials: number; seed: number; target: number | null }
  | { type: 'calibrate'; id: number; robot: RobotConfig; params: OverrideParams };

export type FromWorker =
  | { type: 'progress'; id: number; progress: OptimizerProgress }
  | { type: 'report'; id: number; report: OptimizationReport }
  | { type: 'trial'; id: number; k: number; score: number }
  | { type: 'trials'; id: number; stats: PhysicsTrialStats }
  | { type: 'calibrated'; id: number; result: CalibrationResult }
  | { type: 'error'; id: number; message: string };
