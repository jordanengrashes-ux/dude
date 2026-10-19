import { describe, expect, it } from 'vitest';
import type { FieldState, GoalState, StackElement } from '../src/rules/fieldState';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { autonomousBonus, computeScore, evaluateAwp, evaluateMatch, evaluateSkills, validStackLength } from '../src/rules/scoring';

const P = OVERRIDE_DEFAULTS;
const pin = (id: string, bottom: 'red' | 'blue' | 'yellow', top: 'red' | 'blue' | 'yellow'): StackElement => ({ kind: 'pin', id, bottom, top });
const cup = (id: string, grayDown: boolean): StackElement => ({ kind: 'cup', id, grayDown });

function goal(id: string, quadrant: GoalState['quadrant'], stack: StackElement[], type: GoalState['type'] = 'neutral'): GoalState {
  return { id, type, quadrant, stack };
}

function state(goals: GoalState[], toggles: Partial<Record<'R1' | 'R2' | 'B1' | 'B2', 'red' | 'blue' | 'yellow'>> = {}, robots: FieldState['robots'] = []): FieldState {
  return {
    goals,
    toggles: (['R1', 'R2', 'B1', 'B2'] as const).map((q) => ({ quadrant: q, position: toggles[q] ?? 'yellow', robotContact: false })),
    robots,
  };
}

const H2H = { matchType: 'headToHead' as const, period: 'driver' as const };

describe('SC3 — Pin halves score individually', () => {
  it('a red/yellow Pin alone in a Goal: red half 5 to red, yellow half unowned with neutral Toggle', () => {
    const r = computeScore(state([goal('G', 'R1', [pin('p1', 'red', 'yellow')])]), P, H2H);
    expect(r.totals).toEqual({ red: 5, blue: 0 });
    expect(r.nonScoring).toHaveLength(1);
    expect(r.nonScoring[0].ruleId).toBe('SC5a');
  });

  it('a red/blue Pin scores 5 for each alliance', () => {
    const r = computeScore(state([goal('G', 'R2', [pin('p1', 'red', 'blue')])]), P, H2H);
    expect(r.totals).toEqual({ red: 5, blue: 5 });
  });

  it('every point line names the object, rule and alliance', () => {
    const r = computeScore(state([goal('G', 'R1', [pin('p1', 'red', 'yellow')])], { R1: 'red' }), P, H2H);
    expect(r.lines).toHaveLength(2);
    for (const l of r.lines) {
      expect(l.objectId).toBe('p1');
      expect(l.goalId).toBe('G');
      expect(l.ruleId).toMatch(/^SC/);
      expect(l.explanation.length).toBeGreaterThan(5);
    }
  });
});

describe('SC3 — Cups hide halves nested in their gray half', () => {
  it('gray-down Cup on a Pin hides that Pin\'s top half', () => {
    const r = computeScore(state([goal('G', 'R1', [pin('p1', 'red', 'blue'), cup('c1', true)])]), P, H2H);
    expect(r.totals).toEqual({ red: 5, blue: 0 });
    expect(r.nonScoring[0]).toMatchObject({ objectId: 'p1', half: 'top', ruleId: 'SC3' });
  });

  it('clear-down Cup keeps the Pin below visible; next Pin\'s bottom half sits in the gray half', () => {
    const s = state([goal('G', 'R1', [pin('p1', 'red', 'blue'), cup('c1', false), pin('p2', 'blue', 'red')])]);
    const r = computeScore(s, P, H2H);
    // p1: red 5 + blue 5 (visible). p2: bottom (blue) hidden, top red 5.
    expect(r.totals).toEqual({ red: 10, blue: 5 });
    expect(r.nonScoring).toEqual([expect.objectContaining({ objectId: 'p2', half: 'bottom' })]);
  });

  it('a stack of n Pins with n−1 Cups shows exactly n+1 halves', () => {
    const stack: StackElement[] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) stack.push(cup(`c${i}`, i % 2 === 0));
      stack.push(pin(`p${i}`, 'red', 'red'));
    }
    const r = computeScore(state([goal('G', 'R1', stack)]), P, H2H);
    expect(r.totals.red).toBe(5 * (4 + 1));
  });

  it('a trailing Cup gray-up on the top Pin hides nothing', () => {
    const r = computeScore(state([goal('G', 'R1', [pin('p1', 'red', 'red'), cup('c1', false)])]), P, H2H);
    expect(r.totals.red).toBe(10);
  });
});

describe('SC2 — Placement validity', () => {
  it('a Cup directly in a Goal is not a valid Placement; nothing above it is Placed', () => {
    const s = state([goal('G', 'R1', [cup('c1', true), pin('p1', 'red', 'red')])]);
    expect(validStackLength(s.goals[0].stack, P)).toBe(0);
    expect(computeScore(s, P, H2H).totals.red).toBe(0);
  });

  it('two Pins nested directly is invalid above the first Pin', () => {
    const s = state([goal('G', 'R1', [pin('p1', 'red', 'red'), pin('p2', 'red', 'red')])]);
    expect(computeScore(s, P, H2H).totals.red).toBe(10);
  });
});

describe('SC4/SC5a — Toggle ownership of yellow halves', () => {
  it('Toggle set to blue gives yellow halves in that Quadrant to blue, even in a red Alliance Goal', () => {
    const s = state([goal('G-R1a', 'R1', [pin('p1', 'yellow', 'yellow')], 'alliance')], { R1: 'blue' });
    expect(computeScore(s, P, H2H).totals).toEqual({ red: 0, blue: 20 });
  });

  it('a Toggle contacted by a Robot at the end is neutral', () => {
    const s = state([goal('G', 'R1', [pin('p1', 'yellow', 'yellow')])], { R1: 'red' });
    s.toggles[0].robotContact = true;
    expect(computeScore(s, P, H2H).totals).toEqual({ red: 0, blue: 0 });
  });

  it('an unseated Toggle is neutral', () => {
    const s = state([goal('G', 'R1', [pin('p1', 'yellow', 'yellow')])]);
    s.toggles[0].position = 'unseated';
    expect(computeScore(s, P, H2H).totals.red).toBe(0);
  });

  it('ownership applies per Quadrant only', () => {
    const s = state(
      [goal('A', 'R1', [pin('p1', 'yellow', 'red')]), goal('B', 'B2', [pin('p2', 'yellow', 'blue')])],
      { R1: 'red', B2: 'red' },
    );
    expect(computeScore(s, P, H2H).totals).toEqual({ red: 10 + 5 + 10, blue: 5 });
  });
});

describe('SC5b/SC6 — Midfield', () => {
  const mid = goal('G-MID', 'midfield', [pin('p1', 'yellow', 'yellow')], 'midfield');
  it('alliance with more Robots in the Midfield Owns its yellow halves and gets 8 per Robot', () => {
    const s = state([mid], {}, [
      { id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false },
      { id: 'r2', alliance: 'red', inMidfield: true, contactingPerimeter: false },
      { id: 'b1', alliance: 'blue', inMidfield: true, contactingPerimeter: false },
    ]);
    const r = computeScore(s, P, H2H);
    expect(r.totals).toEqual({ red: 20 + 16, blue: 8 });
    expect(r.ownership.midfield).toBe('red');
  });

  it('equal Robot counts → no owner, but each Robot still scores 8', () => {
    const s = state([mid], {}, [
      { id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false },
      { id: 'b1', alliance: 'blue', inMidfield: true, contactingPerimeter: false },
    ]);
    expect(computeScore(s, P, H2H).totals).toEqual({ red: 8, blue: 8 });
  });

  it('Q&A 3188: at the end of Autonomous neither alliance Owns the Midfield Goal and Midfield robots score nothing', () => {
    const s = state([mid], {}, [{ id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false }]);
    expect(computeScore(s, P, { matchType: 'headToHead', period: 'autonomous' }).totals).toEqual({ red: 0, blue: 0 });
  });

  it('a live score before the end leaves out what the end decides: driving through the Midfield scores nothing yet', () => {
    const s = state([mid], {}, [{ id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false }]);
    const live = computeScore(s, P, { ...H2H, endOfMatch: false });
    expect(live.totals).toEqual({ red: 0, blue: 0 });
    expect(live.ownership.midfield).toBeNull();
    expect(computeScore(s, P, H2H).totals).toEqual({ red: 20 + 8, blue: 0 }); // at the end it counts
  });
});

describe('Autonomous Bonus', () => {
  const mk = (red: number, blue: number) => ({ totals: { red, blue } }) as never;
  it('12 to the leader', () => expect(autonomousBonus(mk(10, 5), [], P)).toMatchObject({ red: 12, blue: 0 }));
  it('6 each on a tie', () => expect(autonomousBonus(mk(5, 5), [], P)).toMatchObject({ red: 6, blue: 6 }));
  it('a violation hands the Bonus to the opponent even when leading', () => {
    const v = [{ robotId: 'r1', alliance: 'red' as const, ruleId: 'SG7', severity: 'minor' as const, period: 'autonomous' as const, time: 3, description: '' }];
    expect(autonomousBonus(mk(30, 0), v, P)).toMatchObject({ red: 0, blue: 12 });
  });
  it('both violate → no Bonus', () => {
    const v = (['red', 'blue'] as const).map((a) => ({ robotId: a, alliance: a, ruleId: 'SG7', severity: 'minor' as const, period: 'autonomous' as const, time: 1, description: '' }));
    expect(autonomousBonus(mk(30, 0), v, P)).toMatchObject({ red: 0, blue: 0 });
  });
});

describe('Autonomous Win Point', () => {
  const robots = [
    { id: 'r1', alliance: 'red' as const, inMidfield: false, contactingPerimeter: false },
    { id: 'r2', alliance: 'red' as const, inMidfield: false, contactingPerimeter: false },
  ];
  const redGoal = (id: string, q: 'R1' | 'R2' | 'B1' | 'B2', n: number) => {
    const st: StackElement[] = [];
    for (let i = 0; i < n; i++) {
      if (i) st.push(cup(`${id}c${i}`, true));
      st.push(pin(`${id}p${i}`, 'red', 'red'));
    }
    return goal(id, q, st);
  };

  it('standard AWP: 6 Pins over 3 own-side Goals passes', () => {
    const s = state([redGoal('A', 'R1', 2), redGoal('B', 'R2', 2), redGoal('C', 'R1', 2)], {}, robots);
    const auto = computeScore(s, P, { matchType: 'headToHead', period: 'autonomous' });
    const r = evaluateAwp(s, auto, [], 'red', P);
    expect(r.earned).toBe(true);
  });

  it('Pins in Goals on the opposing side of the Autonomous Line do not count', () => {
    const s = state([redGoal('A', 'R1', 2), redGoal('B', 'B1', 2), redGoal('C', 'B2', 2)], {}, robots);
    const auto = computeScore(s, P, { matchType: 'headToHead', period: 'autonomous' });
    expect(evaluateAwp(s, auto, [], 'red', P).earned).toBe(false);
  });

  it('a covered (unscored) Pin does not count — June 4 update: Scored, not just Placed', () => {
    // 6 Pins placed, but the gray halves hide the red top halves; a red/blue pin with red covered = blue only.
    const stack: StackElement[] = [pin('p1', 'blue', 'red'), cup('c1', true), pin('p2', 'blue', 'red'), cup('c2', true)];
    const s = state([goal('A', 'R1', stack), redGoal('B', 'R2', 2), redGoal('C', 'R1', 2)], {}, robots);
    const auto = computeScore(s, P, { matchType: 'headToHead', period: 'autonomous' });
    const r = evaluateAwp(s, auto, [], 'red', P);
    expect(r.checks[0].detail).toBe('4 Pins');
    expect(r.earned).toBe(false);
  });

  it('perimeter contact fails AWP', () => {
    const rb = robots.map((r, i) => ({ ...r, contactingPerimeter: i === 0 }));
    const s = state([redGoal('A', 'R1', 2), redGoal('B', 'R2', 2), redGoal('C', 'R1', 2)], {}, rb);
    const auto = computeScore(s, P, { matchType: 'headToHead', period: 'autonomous' });
    expect(evaluateAwp(s, auto, [], 'red', P).earned).toBe(false);
  });

  it('qualifying-event variant requires 7 Pins and 3 Goals', () => {
    const p = cloneParams();
    p.awp.variant = 'qualifyingEvent';
    const rb = robots.map((r) => ({ ...r, inMidfield: true }));
    const s = state([redGoal('A', 'R1', 2), redGoal('B', 'R2', 2), redGoal('C', 'R1', 2)], {}, rb);
    const auto = computeScore(s, p, { matchType: 'headToHead', period: 'autonomous' });
    expect(evaluateAwp(s, auto, [], 'red', p).earned).toBe(false);
    const s2 = state([redGoal('A', 'R1', 3), redGoal('B', 'R2', 2), redGoal('C', 'R1', 2)], {}, rb);
    const auto2 = computeScore(s2, p, { matchType: 'headToHead', period: 'autonomous' });
    expect(evaluateAwp(s2, auto2, [], 'red', p).earned).toBe(true);
  });
});

describe('Full match and Skills evaluation', () => {
  it('match total = final field score + Autonomous Bonus', () => {
    const autoS = state([goal('A', 'R1', [pin('p1', 'red', 'red')])]);
    const finalS = state([goal('A', 'R1', [pin('p1', 'red', 'red'), cup('c1', false), pin('p2', 'yellow', 'yellow')])], { R1: 'red' }, [
      { id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false },
    ]);
    const m = evaluateMatch(autoS, finalS, [], P);
    // final: p1 red 5+5, p2 bottom yellow hidden (gray up), top yellow 10 owned; midfield 8 → 28; bonus 12
    expect(m.final.totals.red).toBe(28);
    expect(m.totals.red).toBe(40);
    expect(m.totals.blue).toBe(0);
  });

  it('Skills: blue halves also score for the skills robot; yellow owned via red Toggle', () => {
    const s = state([goal('A', 'B1', [pin('p1', 'blue', 'yellow')])], { B1: 'red' }, [{ id: 'r1', alliance: 'red', inMidfield: true, contactingPerimeter: false }]);
    const r = evaluateSkills(s, P, 'skillsDriver');
    expect(r.totals.red).toBe(5 + 10 + 8);
  });

  it('point values come from params, not constants', () => {
    const p = cloneParams();
    p.points.alliancePinHalf = 7;
    const r = computeScore(state([goal('G', 'R1', [pin('p1', 'red', 'red')])]), p, H2H);
    expect(r.totals.red).toBe(14);
  });
});
