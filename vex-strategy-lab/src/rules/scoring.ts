import type { FieldState, GoalState, Period, QuadrantId, StackElement, Violation } from './fieldState';
import type { Alliance, AwpCriteria, HalfColor, MatchType, OverrideParams } from './ruleset';

/**
 * Override scoring engine. Pure function of (FieldState, params, context).
 * Produces an explainable report: every point is attached to an object, the rule
 * that awarded it, and the alliance that received it. Halves that do NOT score
 * are reported too, with the reason, so the UI can explain missed points.
 */

export interface ScoreLine {
  alliance: Alliance;
  points: number;
  ruleId: string;
  goalId?: string;
  objectId?: string;
  half?: 'bottom' | 'top';
  color?: HalfColor;
  robotId?: string;
  explanation: string;
}

export interface NonScoringHalf {
  goalId: string;
  objectId: string;
  half: 'bottom' | 'top';
  color: HalfColor;
  reason: string;
  ruleId: string;
}

export interface ScoreReport {
  totals: Record<Alliance, number>;
  lines: ScoreLine[];
  nonScoring: NonScoringHalf[];
  /** Pins that are Placed, per goal, for diagnostics. */
  placedPins: Record<string, string[]>;
  ownership: Record<QuadrantId | 'midfield', Alliance | null>;
}

export interface ScoreContext {
  matchType: MatchType;
  /** Which period's end is being evaluated. */
  period: Period;
  /**
   * Count what is decided by where Robots are at the end of the Match (Midfield Goal
   * ownership, Robots in the Midfield). Default true; a live score before the
   * Endgame leaves them out (they would come and go as robots drive through).
   */
  endOfMatch?: boolean;
}

const ALLIANCES: Alliance[] = ['red', 'blue'];

/** Index of the first stack element that breaks the Pin–Cup–Pin… alternation (SC2). */
export function validStackLength(stack: StackElement[], params: OverrideParams): number {
  let n = 0;
  for (let i = 0; i < stack.length; i++) {
    const expected = i % 2 === 0 ? 'pin' : 'cup';
    if (stack[i].kind !== expected) break;
    n++;
  }
  // maxPinHalvesPerSocket = 1 is enforced structurally: one Pin per Goal socket / Cup half.
  void params;
  return n;
}

function toggleOwner(state: FieldState, q: QuadrantId): Alliance | null {
  const t = state.toggles.find((x) => x.quadrant === q);
  if (!t) return null;
  if (t.robotContact) return null; // SC4: contacted Toggle is neutral
  if (t.position === 'red') return 'red';
  if (t.position === 'blue') return 'blue';
  return null; // yellow or unseated
}

export function midfieldOwner(state: FieldState, ctx: ScoreContext, params: OverrideParams): Alliance | null {
  if (ctx.endOfMatch === false) return null;
  if (ctx.period === 'autonomous' && !params.scoring.midfieldOwnershipInAutonomous) return null;
  const count = (a: Alliance) => state.robots.filter((r) => r.alliance === a && r.inMidfield && !r.disqualified).length;
  const red = count('red');
  const blue = count('blue');
  if (red > blue) return 'red';
  if (blue > red) return 'blue';
  return null;
}

/** Ownership map for yellow halves: quadrant Toggles + Midfield Goal (SC5a/SC5b). */
export function ownershipMap(state: FieldState, ctx: ScoreContext, params: OverrideParams): Record<QuadrantId | 'midfield', Alliance | null> {
  const isSkills = ctx.matchType !== 'headToHead';
  const quadOwner = (q: QuadrantId): Alliance | null => {
    const o = toggleOwner(state, q);
    if (isSkills) return o === params.skills.ownedToggleColor ? params.skills.robotAlliance : null;
    return o;
  };
  return {
    R1: quadOwner('R1'),
    R2: quadOwner('R2'),
    B1: quadOwner('B1'),
    B2: quadOwner('B2'),
    midfield: isSkills
      ? state.robots.some((r) => r.inMidfield) && ctx.period !== 'autonomous' && ctx.endOfMatch !== false
        ? params.skills.robotAlliance
        : null
      : midfieldOwner(state, ctx, params),
  };
}

interface HalfInfo {
  goal: GoalState;
  pinId: string;
  half: 'bottom' | 'top';
  color: HalfColor;
  visible: boolean;
  hiddenReason?: string;
  contact: boolean;
}

/** Enumerate every half of every Placed Pin with its SC3 visibility. */
export function enumerateHalves(goal: GoalState, params: OverrideParams): HalfInfo[] {
  const n = validStackLength(goal.stack, params);
  const out: HalfInfo[] = [];
  for (let i = 0; i < n; i += 2) {
    const pin = goal.stack[i];
    if (pin.kind !== 'pin') continue;
    const below = i > 0 ? goal.stack[i - 1] : undefined;
    const above = i + 1 < n ? goal.stack[i + 1] : undefined;
    let bottomVisible = true;
    let bottomReason: string | undefined;
    if (i === 0) {
      if (params.scoring.goalObscuresNestedHalf) {
        bottomVisible = false;
        bottomReason = 'Nested inside the Goal (goalObscuresNestedHalf = true)';
      }
    } else if (below && below.kind === 'cup' && !below.grayDown) {
      // Cup below has gray half facing UP → this Pin's bottom half sits in the gray half.
      bottomVisible = false;
      bottomReason = `Nested in the gray half of Cup ${below.id}`;
    }
    let topVisible = true;
    let topReason: string | undefined;
    if (above && above.kind === 'cup' && above.grayDown) {
      topVisible = false;
      topReason = `Covered by the gray half of Cup ${above.id}`;
    }
    const contact = !!pin.robotContact;
    out.push({ goal, pinId: pin.id, half: 'bottom', color: pin.bottom, visible: bottomVisible, hiddenReason: bottomReason, contact });
    out.push({ goal, pinId: pin.id, half: 'top', color: pin.top, visible: topVisible, hiddenReason: topReason, contact });
  }
  return out;
}

export function computeScore(state: FieldState, params: OverrideParams, ctx: ScoreContext): ScoreReport {
  const totals: Record<Alliance, number> = { red: 0, blue: 0 };
  const lines: ScoreLine[] = [];
  const nonScoring: NonScoringHalf[] = [];
  const placedPins: Record<string, string[]> = {};
  const own = ownershipMap(state, ctx, params);
  const isSkills = ctx.matchType !== 'headToHead';
  const P = params.points;

  for (const goal of state.goals) {
    const halves = enumerateHalves(goal, params);
    placedPins[goal.id] = [...new Set(halves.map((h) => h.pinId))];
    for (const h of halves) {
      const base = { goalId: goal.id, objectId: h.pinId, half: h.half, color: h.color };
      if (!h.visible) {
        nonScoring.push({ ...base, reason: h.hiddenReason ?? 'not visible', ruleId: 'SC3' });
        continue;
      }
      if (h.contact && params.scoring.robotContactInvalidates) {
        nonScoring.push({ ...base, reason: 'Robot contact at end of period', ruleId: 'SC3' });
        continue;
      }
      if (h.color === 'yellow') {
        const owner = own[goal.quadrant];
        if (!owner) {
          nonScoring.push({
            ...base,
            reason: goal.quadrant === 'midfield' ? (ctx.endOfMatch === false ? 'Midfield Goal ownership is decided at the end of the Match' : 'Midfield Goal not Owned (equal robot counts or Autonomous)') : `Toggle in ${goal.quadrant} is neutral or contacted`,
            ruleId: goal.quadrant === 'midfield' ? 'SC5b' : 'SC5a',
          });
          continue;
        }
        totals[owner] += P.ownedYellowPinHalf;
        lines.push({
          ...base,
          alliance: owner,
          points: P.ownedYellowPinHalf,
          ruleId: goal.quadrant === 'midfield' ? 'SC5b' : 'SC5a',
          explanation: `yellow ${h.half} half of ${h.pinId} in ${goal.id} Owned by ${owner}`,
        });
      } else {
        const alliance: Alliance = isSkills && params.skills.bothColorHalvesScore ? params.skills.robotAlliance : h.color;
        totals[alliance] += P.alliancePinHalf;
        lines.push({
          ...base,
          alliance,
          points: P.alliancePinHalf,
          ruleId: 'SC3',
          explanation: `${h.color} ${h.half} half of ${h.pinId} visible in ${goal.id}`,
        });
      }
    }
  }

  // SC6: Robots in the Midfield — end of Match only, never in Autonomous calculations.
  if (ctx.period !== 'autonomous' && ctx.endOfMatch !== false) {
    for (const r of state.robots) {
      if (!r.inMidfield || r.disqualified) continue;
      const alliance = isSkills ? params.skills.robotAlliance : r.alliance;
      totals[alliance] += P.robotInMidfield;
      lines.push({ alliance, points: P.robotInMidfield, ruleId: 'SC6', robotId: r.id, explanation: `${r.id} ends in the Midfield` });
    }
  }

  return { totals, lines, nonScoring, placedPins, ownership: own };
}

/** Autonomous Bonus (12 / tie 6 each / violations hand it to the opponent). */
export function autonomousBonus(
  autoReport: ScoreReport,
  violations: Violation[],
  params: OverrideParams,
): { red: number; blue: number; explanation: string } {
  const autoViol = (a: Alliance) => violations.some((v) => v.period === 'autonomous' && v.alliance === a);
  const rv = autoViol('red');
  const bv = autoViol('blue');
  const B = params.points.autonomousBonus;
  if (rv && bv) return { red: 0, blue: 0, explanation: 'Both Alliances violated during Autonomous — no Bonus' };
  if (rv) return { red: 0, blue: B, explanation: 'Red Autonomous violation — Bonus to blue' };
  if (bv) return { red: B, blue: 0, explanation: 'Blue Autonomous violation — Bonus to red' };
  const { red, blue } = autoReport.totals;
  if (red > blue) return { red: B, blue: 0, explanation: `Red led Autonomous ${red}–${blue}` };
  if (blue > red) return { red: 0, blue: B, explanation: `Blue led Autonomous ${blue}–${red}` };
  const T = params.points.autonomousBonusTieEach;
  return { red: T, blue: T, explanation: `Autonomous tied ${red}–${blue}` };
}

export interface AwpResult {
  alliance: Alliance;
  earned: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

/** Which side of the Autonomous Line a Quadrant is on. */
export function quadrantSide(q: QuadrantId | 'midfield'): Alliance | null {
  if (q === 'R1' || q === 'R2') return 'red';
  if (q === 'B1' || q === 'B2') return 'blue';
  return null;
}

export function evaluateAwp(
  state: FieldState,
  autoReport: ScoreReport,
  violations: Violation[],
  alliance: Alliance,
  params: OverrideParams,
): AwpResult {
  const crit: AwpCriteria = params.awp[params.awp.variant];
  const pinsByGoal = new Map<string, Set<string>>();
  for (const line of autoReport.lines) {
    if (line.alliance !== alliance || !line.goalId || !line.objectId) continue;
    if (line.color === 'yellow' && !params.awp.ownedYellowCounts) continue;
    const goal = state.goals.find((g) => g.id === line.goalId);
    if (!goal) continue;
    if (params.awp.ownSideOnly && goal.quadrant !== 'midfield' && quadrantSide(goal.quadrant) !== alliance) continue;
    if (!pinsByGoal.has(goal.id)) pinsByGoal.set(goal.id, new Set());
    pinsByGoal.get(goal.id)!.add(line.objectId);
  }
  const totalPins = [...pinsByGoal.values()].reduce((s, x) => s + x.size, 0);
  const goalsMeeting = [...pinsByGoal.values()].filter((s) => s.size >= crit.minPinsPerGoal).length;
  const robots = state.robots.filter((r) => r.alliance === alliance);
  const perimeter = robots.some((r) => r.contactingPerimeter);
  const inMid = robots.some((r) => r.inMidfield);
  const viol = violations.filter((v) => v.period === 'autonomous' && v.alliance === alliance);
  const checks = [
    { label: `≥${crit.minPinsScored} Pins Scored`, ok: totalPins >= crit.minPinsScored, detail: `${totalPins} Pins` },
    {
      label: `≥${crit.minGoals} Goals with ≥${crit.minPinsPerGoal} Pins`,
      ok: goalsMeeting >= crit.minGoals,
      detail: `${goalsMeeting} Goals`,
    },
    { label: 'No Robot contacting the Field Perimeter', ok: !crit.noPerimeterContact || !perimeter, detail: perimeter ? 'contact' : 'clear' },
    { label: 'Robot in the Midfield', ok: !crit.requireMidfieldRobot || inMid, detail: inMid ? 'yes' : 'no' },
    { label: 'No Autonomous violations', ok: viol.length === 0, detail: `${viol.length} violations` },
  ];
  return { alliance, earned: checks.every((c) => c.ok), checks };
}

export interface MatchResult {
  autonomous: ScoreReport;
  final: ScoreReport;
  bonus: { red: number; blue: number; explanation: string };
  awp: Record<Alliance, AwpResult>;
  totals: Record<Alliance, number>;
  violations: Violation[];
  disqualified: Record<Alliance, boolean>;
}

/** Full Head-to-Head match evaluation from the two snapshots (end of Autonomous, end of Match). */
export function evaluateMatch(
  autoState: FieldState,
  finalState: FieldState,
  violations: Violation[],
  params: OverrideParams,
  opts: { endOfMatch?: boolean } = {},
): MatchResult {
  const autonomous = computeScore(autoState, params, { matchType: 'headToHead', period: 'autonomous' });
  const final = computeScore(finalState, params, { matchType: 'headToHead', period: 'driver', endOfMatch: opts.endOfMatch });
  const bonus = autonomousBonus(autonomous, violations, params);
  const awp = {
    red: evaluateAwp(autoState, autonomous, violations, 'red', params),
    blue: evaluateAwp(autoState, autonomous, violations, 'blue', params),
  };
  const dq: Record<Alliance, boolean> = { red: false, blue: false };
  for (const v of violations) if (v.severity === 'major') dq[v.alliance] = true;
  const totals = {
    red: final.totals.red + bonus.red,
    blue: final.totals.blue + bonus.blue,
  };
  return { autonomous, final, bonus, awp, totals, violations, disqualified: dq };
}

/** Skills evaluation (single robot; no Autonomous Bonus). */
export function evaluateSkills(finalState: FieldState, params: OverrideParams, matchType: Exclude<MatchType, 'headToHead'>): ScoreReport {
  return computeScore(finalState, params, { matchType, period: 'skills' });
}

export { ALLIANCES };
