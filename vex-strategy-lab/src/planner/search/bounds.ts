import { dist } from '../../core/vec';
import { MIDFIELD_REACH } from '../../field/geometry';
import type { Alliance, HalfColor } from '../../rules/ruleset';
import { enumerateHalves } from '../../rules/scoring';
import { ST_FIELD, ST_HELD, ST_MATCHLOAD, type PlanState, type PlanWorld } from '../model';

/**
 * Admissible upper bound on the additional objective value obtainable from state s
 * before the end of the planning window. Used by branch-and-bound to prune and to
 * report an optimality gap. Every term is an optimistic relaxation:
 *
 *  1. Future Pin placements — fractional knapsack over available Pins, where each
 *     Pin's value assumes both halves visible and every yellow half Owned, and its
 *     time cost is a lower bound (intake + release + straight-line travel at free
 *     speed, minus holder reach). Count is capped by remaining Goal slots the lift
 *     can reach.
 *  2. Ownership — every currently visible but un-Owned yellow half could become
 *     Owned (+ yellow value) if at least one Toggle action fits in the time left.
 *  3. Midfield — +robot points and Midfield-Goal ownership if a park could fit.
 *  4. Margin objective — every Cup could hide one opposing half; Toggle flips could
 *     remove opposing ownership.
 *  5. Autonomous Bonus / AWP — counted as obtainable if still undecided.
 *
 * Admissibility is checked by tests that compare against exhaustive search.
 */
export function upperBoundAdd(w: PlanWorld, s: PlanState): number {
  const cfg = w.cfg;
  const P = cfg.params.points;
  const R = cfg.robot;
  const tEnd = cfg.tEnd;
  const remaining = tEnd - s.t;
  // Parking is terminal: no further robot actions, and value() already applies pending external events.
  if (remaining <= 0 || s.parked) return 0;
  const vmax = w.perf.vFree * 1.15; // allow for performance uncertainty
  const reach = R.intake.holderOffsetIn * 2;
  const minMech = R.intake.intakeTimeSec + R.intake.releaseTimeSec + Math.min(R.execution.pickOverheadSec, R.execution.loadOverheadSec) + R.execution.placeOverheadSec;
  const alliance = cfg.alliance;
  const opp: Alliance = alliance === 'red' ? 'blue' : 'red';
  const isSkills = cfg.matchType !== 'headToHead';
  const margin = cfg.objective === 'margin';

  const halfVal = (c: HalfColor) => {
    if (c === 'yellow') return P.ownedYellowPinHalf;
    if (isSkills && cfg.params.skills.bothColorHalvesScore) return P.alliancePinHalf;
    return c === alliance ? P.alliancePinHalf : 0;
  };

  // Goal positions usable for placement (ignoring period legality — optimistic).
  const goalPos = w.goals.map((g) => g.pos);
  const holder = w.holderPoint(s.pos, s.heading);
  const dMinGoal = (p: { x: number; y: number }) => {
    let m = Infinity;
    for (const g of goalPos) {
      const d = dist(g, p);
      if (d < m) m = d;
    }
    return m;
  };
  const staticDMin = w.objDMinGoal;

  // Slots: how many more Pins the lift can still place across all goals.
  let slots = 0;
  for (let gi = 0; gi < w.goals.length; gi++) {
    const g = w.goals[gi];
    const n = s.stacks[gi].length;
    // pins currently in stack
    const pinsNow = Math.ceil(n / 2);
    // max pins: k such that required height for pin k ≤ maxHolder
    let k = pinsNow;
    while (true) {
      const nextPinIndex = k + 1; // 1-based
      const req = g.height + (nextPinIndex - 1) * 6.5 + 0.5;
      if (req > w.maxHolder) break;
      k++;
      if (k > 20) break;
    }
    slots += k - pinsNow;
  }

  // Rest-to-rest straight-line time lower bound (the model stops at every pickup/placement).
  const aLB = Math.max(w.perf.aTraction, w.perf.aBrake, w.perf.aMax);
  const legLB = (d: number) => (d <= 0 ? 0 : d < (vmax * vmax) / aLB ? 2 * Math.sqrt(d / aLB) : d / vmax + vmax / aLB);

  // Free sockets: Goals whose next element is a Pin (empty, or topped by a Cup) take a Pin without a Cup first.
  let freeSockets = 0;
  for (let gi = 0; gi < w.goals.length; gi++) if (s.stacks[gi].length % 2 === 0) freeSockets++;
  // Cheapest possible Cup cycle (needed before every additional Pin in a Goal).
  let cupCycle = Infinity;
  let cupsAvail = 0;
  for (const o of w.objs) {
    if (o.kind !== 'cup') continue;
    const st = s.status[o.idx];
    if (st === ST_HELD) {
      cupsAvail++;
      cupCycle = Math.min(cupCycle, R.intake.releaseTimeSec + R.execution.placeOverheadSec);
    } else if (st === ST_FIELD && o.startPos) {
      cupsAvail++;
      const dm = w.objDMinGoal[o.idx];
      cupCycle = Math.min(cupCycle, minMech + 2 * legLB(Math.max(0, dm - reach)));
    } else if (st === ST_MATCHLOAD) {
      cupsAvail++;
      cupCycle = Math.min(cupCycle, minMech);
    }
  }
  // A Cup between two Pins always hides exactly one adjacent Pin half; the hidden half
  // is worth at least the cheapest half value in play.
  let minHalf = Infinity;

  // Candidate pins with (value, time)
  const items: { v: number; c: number; lo: number; paired: boolean }[] = [];
  const heldPair = w.heldPair(s);
  for (const o of w.objs) {
    if (o.kind !== 'pin') continue;
    const st = s.status[o.idx];
    let pos: { x: number; y: number } | null = null;
    let extra = 0;
    // a Pin in a Cup goes onto a Goal with its Cup in one trip (no separate Cup cycle)
    const paired = (st === ST_FIELD && o.nest !== undefined && s.status[o.nest] === ST_FIELD) || (st === ST_HELD && heldPair);
    if (st === ST_FIELD && o.startPos) {
      if (o.lying && R.intake.maxPinTiltDeg < 90) continue; // the claw can't take it
      pos = o.startPos;
    }
    else if (st === ST_MATCHLOAD) {
      if (w.isAutonomous(s.t) && !cfg.params.matchLoads.allowedInAutonomous && cfg.tEnd <= (w.clock.autonomousEnd ?? 0)) continue;
      const ls = w.loaders.filter((l) => isSkills || l.alliance === alliance);
      pos = ls.reduce((a, b) => (dist(a.dispense, holder) < dist(b.dispense, holder) ? a : b)).dispense;
    } else if (st === ST_HELD) {
      pos = holder;
      extra = -(R.intake.intakeTimeSec + Math.min(R.execution.pickOverheadSec, R.execution.loadOverheadSec));
    } else continue;
    const h0 = halfVal(o.colors![0]);
    const h1 = halfVal(o.colors![1]);
    const v = h0 + h1;
    minHalf = Math.min(minHalf, h0, h1);
    if (v <= 0) continue;
    const dm = st === ST_FIELD ? staticDMin[o.idx] : dMinGoal(pos);
    const d1 = Math.max(0, Math.min(dist(holder, pos), dm) - reach);
    const d2 = Math.max(0, dm - reach);
    const c = Math.max(0.05, minMech + extra + (st === ST_HELD ? legLB(d2) : legLB(d1) + legLB(d2)));
    items.push({ v, c, lo: Math.min(h0, h1), paired });
  }
  if (!isFinite(minHalf)) minHalf = 0;
  // Fractional knapsack. The first `freeSockets` Pins need no Cup; every further Pin
  // also needs a Cup cycle and loses at least `minHalf` to the Cup's gray half.
  // Both sub-problems are solved greedily by ratio and the larger total is taken
  // per position, which keeps the bound admissible (see tests/planner.test.ts).
  const extraCost = isFinite(cupCycle) ? cupCycle : Infinity;
  const ranked = items
    .map((it) => ({ ...it }))
    .sort((a, b) => b.v / b.c - a.v / a.c);
  let budget = remaining;
  let gain = 0;
  let used = 0;
  let single = 0;
  let cupsLeft = cupsAvail;
  for (const it of ranked) {
    if (used >= slots) break;
    let v = it.v;
    let c = it.c;
    // optimistic for a pair: full value, no Cup cycle, no free socket used
    if (!it.paired && single++ >= freeSockets) {
      if (cupsLeft <= 0 || !isFinite(extraCost)) continue; // pairs further down still fit
      v = Math.max(0, it.v - minHalf);
      c = it.c + extraCost;
      cupsLeft--;
    }
    if (c <= budget) {
      gain += v;
      budget -= c;
      used++;
    } else {
      gain += (v * budget) / c;
      break;
    }
  }

  // Ownership upgrades of currently placed yellow halves. Toggles are judged both now
  // and after the remaining external events (an opponent flip could be answered).
  const minToggle = R.toggleArm.actuateTimeSec + R.execution.toggleOverheadSec;
  const fin = s.eventsApplied < cfg.externalEvents.length ? w.finalize(s) : s;
  if (remaining >= minToggle && w.toggles.length) {
    for (let gi = 0; gi < w.goals.length; gi++) {
      const g = w.goals[gi];
      if (g.type === 'midfield') continue;
      const ti = w.toggles.findIndex((t) => t.quadrant === g.quadrant);
      if (ti < 0) continue;
      const own = s.toggles[ti] === w.toggleTarget() && fin.toggles[ti] === w.toggleTarget();
      if (own) continue;
      const goal = { id: g.id, type: g.type, quadrant: g.quadrant, stack: s.stacks[gi].map((c) => w.element(c)) };
      for (const h of enumerateHalves(goal, cfg.params)) {
        if (h.visible && h.color === 'yellow') gain += P.ownedYellowPinHalf * (margin && s.toggles[ti] === opp ? 2 : 1);
      }
    }
  }

  // Midfield
  if (cfg.allowPark && !s.parked) {
    const dMid = Math.max(0, (Math.abs(s.pos.x) + Math.abs(s.pos.y) - MIDFIELD_REACH) / Math.SQRT2 - Math.hypot(R.chassis.lengthIn, R.chassis.widthIn) / 2);
    if (dMid / vmax <= remaining) {
      gain += P.robotInMidfield;
      const mi = w.goals.findIndex((g) => g.type === 'midfield');
      if (mi >= 0) {
        const goal = { id: 'm', type: 'midfield' as const, quadrant: 'midfield' as const, stack: s.stacks[mi].map((c) => w.element(c)) };
        for (const h of enumerateHalves(goal, cfg.params)) if (h.visible && h.color === 'yellow') gain += P.ownedYellowPinHalf * (margin ? 2 : 1);
      }
    }
  }

  // Margin: each reachable cup could hide one opposing half (≤ yellow value)
  if (margin) {
    let cups = 0;
    for (const o of w.objs) if (o.kind === 'cup' && (s.status[o.idx] === ST_FIELD || s.status[o.idx] === ST_MATCHLOAD || s.status[o.idx] === ST_HELD)) cups++;
    const maxCupActions = Math.floor(remaining / Math.max(0.05, minMech));
    gain += Math.min(cups, maxCupActions) * P.ownedYellowPinHalf;
  }

  // Autonomous terms still undecided
  if (cfg.matchType === 'headToHead' && w.clock.autonomousEnd !== null && !s.auto && cfg.tStart < w.clock.autonomousEnd) {
    if (cfg.includeAutonBonus) gain += P.autonomousBonus * (margin ? 2 : 1);
    gain += cfg.awpWeight;
  }
  return gain;
}
