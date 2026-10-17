import type { Alliance, HalfColor } from './ruleset';

/**
 * Rules-engine input. This is a *description of the field* — the physics
 * simulation extracts it from body positions (see physics/extract.ts) and the
 * planner builds it from its abstract model. The scoring engine never sees
 * physics bodies or animation state, only this structure.
 */

export type QuadrantId = 'R1' | 'R2' | 'B1' | 'B2';
export type GoalType = 'alliance' | 'neutral' | 'midfield';
export type TogglePosition = 'red' | 'yellow' | 'blue' | 'unseated';
export type Period = 'autonomous' | 'driver' | 'skills';

export interface PinElement {
  kind: 'pin';
  id: string;
  /** Color of the half nested downward (into the Goal or the Cup below). */
  bottom: HalfColor;
  /** Color of the upward half. */
  top: HalfColor;
  /** Robot contact at evaluation time (only matters if robotContactInvalidates). */
  robotContact?: boolean;
}

export interface CupElement {
  kind: 'cup';
  id: string;
  /** True when the gray (opaque) half faces down, over the Pin below. */
  grayDown: boolean;
}

export type StackElement = PinElement | CupElement;

export interface GoalState {
  id: string;
  type: GoalType;
  allianceColor?: Alliance;
  /** Quadrant containing the Goal, or 'midfield' for the center Goal. */
  quadrant: QuadrantId | 'midfield';
  /** Bottom-to-top nesting order. */
  stack: StackElement[];
}

export interface ToggleStatus {
  quadrant: QuadrantId;
  position: TogglePosition;
  robotContact: boolean;
}

export interface RobotStatus {
  id: string;
  alliance: Alliance;
  inMidfield: boolean;
  contactingPerimeter: boolean;
  disqualified?: boolean;
}

export interface Violation {
  robotId: string;
  alliance: Alliance;
  ruleId: string;
  severity: 'minor' | 'major';
  period: Period;
  time: number;
  description: string;
}

export interface FieldState {
  goals: GoalState[];
  toggles: ToggleStatus[];
  robots: RobotStatus[];
}

export function cloneFieldState(s: FieldState): FieldState {
  return {
    goals: s.goals.map((g) => ({ ...g, stack: g.stack.map((e) => ({ ...e })) })),
    toggles: s.toggles.map((t) => ({ ...t })),
    robots: s.robots.map((r) => ({ ...r })),
  };
}
