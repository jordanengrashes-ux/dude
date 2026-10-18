import type { ScoreLine, ScoreReport } from '../rules/scoring';
import type { Action, PlanState, PlanWorld, StepInfo } from './model';
import { replay, rolloutStep } from './search/common';

/**
 * Plain-English explanations of a plan, built from the rules-engine score lines
 * (so every claimed point is traceable to a rule) and from counterfactual
 * evaluation of rejected alternatives.
 */

export interface StepExplanation {
  index: number;
  label: string;
  tStart: number;
  tEnd: number;
  gain: number;
  valueAfter: number;
  why: string;
  timeBreakdown: string;
  alternatives: { label: string; finalValue: number; delta: number; reason: string }[];
  deadline?: string;
}

function lineKey(l: ScoreLine) {
  return `${l.alliance}|${l.ruleId}|${l.goalId ?? ''}|${l.objectId ?? ''}|${l.half ?? ''}|${l.robotId ?? ''}`;
}

export function diffLines(before: ScoreReport, after: ScoreReport, alliance: string) {
  const b = new Set(before.lines.filter((l) => l.alliance === alliance).map(lineKey));
  const a = new Set(after.lines.filter((l) => l.alliance === alliance).map(lineKey));
  const added = after.lines.filter((l) => l.alliance === alliance && !b.has(lineKey(l)));
  const removed = before.lines.filter((l) => l.alliance === alliance && !a.has(lineKey(l)));
  return { added, removed };
}

/** Greedy completion used to value alternatives (gain-per-second policy). */
export function greedyComplete(w: PlanWorld, s: PlanState, maxSteps = 80): number {
  let cur = s;
  let best = w.value(cur);
  for (let k = 0; k < maxSteps; k++) {
    const r = rolloutStep(w, cur, null, 0);
    if (!r) break;
    cur = r.s;
    best = Math.max(best, r.v);
  }
  return best;
}

export function explainPlan(w: PlanWorld, actions: Action[], opts: { alternatives?: number; maxAltSteps?: number } = {}): { steps: StepExplanation[]; detailed: StepInfo[]; final: PlanState } {
  const nAlt = opts.alternatives ?? 2;
  const maxAltSteps = opts.maxAltSteps ?? 12;
  const rp = replay(w, actions, true);
  const out: StepExplanation[] = [];
  let s = w.initialState();
  const finalValue = w.value(rp.state);
  rp.steps.forEach((st, i) => {
    const before = w.score(s);
    const r = w.apply(s, st.action, true)!;
    const after = w.score(r.s);
    const { added, removed } = diffLines(before, after, w.cfg.alliance);
    const gain = st.valueAfter - st.valueBefore;
    let why = '';
    const a = st.action;
    if (a.type === 'pick' || a.type === 'load') {
      const o = w.objs[a.obj];
      why = `Collects ${o.id}${o.colors ? ` (${o.colors.join('/')})` : ''} for a later placement; ${w.cfg.robot.intake.capacity === 'single' ? 'the claw holds one piece' : 'holding ≤ 1 Pin + 1 Cup (possession limit)'}.`;
    } else if (added.length || removed.length) {
      const parts = added.map((l) => `+${l.points} ${l.explanation} [${l.ruleId}]`);
      const lost = removed.map((l) => `−${l.points} ${l.explanation} [${l.ruleId}]`);
      why = [...parts, ...lost].join('; ');
    } else if (a.type === 'place') {
      why = `Structural placement: enables the next element on this stack (no immediate points).`;
    } else if (a.type === 'toggle') {
      why = `Claims Quadrant ownership for future yellow halves (SC5a).`;
    } else if (a.type === 'park') {
      why = `Ends in the Midfield (SC6).`;
    } else if (a.type === 'wait') {
      why = `Idle until the next period.`;
    }
    const tb = [
      st.travelTime > 0 ? `travel ${st.travelTime.toFixed(2)} s over ${st.travelDist.toFixed(0)}"` : '',
      st.liftTime > 0 ? `lift ${st.liftTime.toFixed(2)} s (overlapped)` : '',
      st.mechTime > 0 ? `mechanism ${st.mechTime.toFixed(2)} s` : '',
      st.waitTime > 0 ? `wait ${st.waitTime.toFixed(2)} s` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const alts: StepExplanation['alternatives'] = [];
    if (i < maxAltSteps && nAlt > 0) {
      const legal = w.legalActions(s).filter((x) => JSON.stringify(x) !== JSON.stringify(a));
      // Prefer like-for-like alternatives (another Pin, another Goal, …) — they explain the choice.
      const same = legal.filter((x) => x.type === a.type);
      const pool = same.length >= nAlt ? same : [...same, ...legal.filter((x) => x.type !== a.type)];
      const scored = pool
        .map((x) => {
          const rr = w.apply(s, x);
          return rr ? { x, s: rr.s, v: w.value(rr.s), dt: rr.s.t - s.t } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((p, q) => (q.v - w.value(s)) / Math.max(0.1, q.dt) - (p.v - w.value(s)) / Math.max(0.1, p.dt))
        .slice(0, nAlt);
      for (const c of scored) {
        const fv = greedyComplete(w, c.s);
        alts.push({
          label: w.actionLabel(c.x, s),
          finalValue: fv,
          delta: fv - finalValue,
          reason: fv < finalValue ? `a greedy continuation from here reaches ${fv} vs the plan's ${finalValue}` : `greedy continuation also reaches ${fv}; the search found this plan first or at equal value`,
        });
      }
    }
    let deadline: string | undefined;
    const ae = w.clock.autonomousEnd;
    if (ae !== null && st.tStart < ae && st.tEnd > ae - 2) deadline = `finishes ${(ae - st.tEnd).toFixed(2)} s before Autonomous ends`;
    if (st.tEnd > w.clock.endgameStart - 1 && st.tStart < w.clock.endgameStart) deadline = `Endgame begins at ${w.clock.endgameStart.toFixed(0)} s`;
    if (w.cfg.tEnd - st.tEnd < 2) deadline = `${(w.cfg.tEnd - st.tEnd).toFixed(2)} s left in the window`;
    out.push({ index: i, label: st.label, tStart: st.tStart, tEnd: st.tEnd, gain, valueAfter: st.valueAfter, why, timeBreakdown: tb, alternatives: alts, deadline });
    s = r.s;
  });
  return { steps: out, detailed: rp.steps, final: rp.state };
}

export interface RouteSummary {
  value: number;
  totalTime: number;
  activeTime: number;
  distance: number;
  placements: number;
  toggles: number;
  parks: boolean;
  meanRisk: number;
}

export function summarizeSteps(steps: StepInfo[], value: number): RouteSummary {
  return {
    value,
    totalTime: steps.length ? steps[steps.length - 1].tEnd - steps[0].tStart : 0,
    activeTime: steps.reduce((a, s) => a + (s.tEnd - s.tStart - s.waitTime), 0),
    distance: steps.reduce((a, s) => a + s.travelDist, 0),
    placements: steps.filter((s) => s.action.type === 'place').length,
    toggles: steps.filter((s) => s.action.type === 'toggle').length,
    parks: steps.some((s) => s.action.type === 'park'),
    meanRisk: steps.length ? steps.reduce((a, s) => a + s.risk, 0) / steps.length : 0,
  };
}

/** Sentences explaining why `best` beats `other`. */
export function compareRoutes(best: RouteSummary, other: RouteSummary): string[] {
  const out: string[] = [];
  const dv = best.value - other.value;
  out.push(dv > 0 ? `Scores ${dv} more (${best.value} vs ${other.value}).` : dv === 0 ? `Same score (${best.value}).` : `Scores ${-dv} less but was preferred for reliability.`);
  const dd = other.distance - best.distance;
  out.push(
    dd >= 0
      ? `Drives ${dd.toFixed(0)}" less (${best.distance.toFixed(0)}" vs ${other.distance.toFixed(0)}").`
      : `Drives ${(-dd).toFixed(0)}" more (${best.distance.toFixed(0)}" vs ${other.distance.toFixed(0)}") — the shorter route is not the higher-scoring one.`,
  );
  out.push(`Active time ${best.activeTime.toFixed(1)} s vs ${other.activeTime.toFixed(1)} s.`);
  if (best.placements !== other.placements) out.push(`${best.placements} placements vs ${other.placements}.`);
  if (best.toggles !== other.toggles) out.push(`${best.toggles} Toggle actions vs ${other.toggles}.`);
  if (best.parks !== other.parks) out.push(best.parks ? 'Ends in the Midfield; the alternative does not.' : 'The alternative parks; this route uses that time to score.');
  if (Math.abs(best.meanRisk - other.meanRisk) > 0.005) out.push(`Mean per-action failure risk ${(best.meanRisk * 100).toFixed(1)}% vs ${(other.meanRisk * 100).toFixed(1)}%.`);
  return out;
}
