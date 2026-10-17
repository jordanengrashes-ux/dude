import { describe, expect, it } from 'vitest';
import { buildGoals, buildToggles } from '../src/field/geometry';
import { buildLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { PlanWorld, ST_FIELD, type ExternalEvent } from '../src/planner/model';
import { beamSearch } from '../src/planner/search/beam';
import { upperBoundAdd } from '../src/planner/search/bounds';
import { replay } from '../src/planner/search/common';
import { planConfigFor, predictEvents, predictOthers, scriptedActions, type ScenarioConfig } from '../src/sim/scenario';

/**
 * Multi-robot planning: how the focus robot's optimizer models partners and
 * opponents (predicted events), and the scripted strategies.
 */

function h2h(): ScenarioConfig {
  return {
    params: cloneParams(OVERRIDE_DEFAULTS),
    layout: buildLayout('headToHead'),
    matchType: 'headToHead',
    seed: 1,
    aiBeamWidth: 6,
    slots: [
      { slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot: cloneRobot(DEFAULT_ROBOT) },
      { slot: 'red-2', alliance: 'red', enabled: true, strategy: 'midfield', robot: cloneRobot(DEFAULT_ROBOT) },
      { slot: 'blue-1', alliance: 'blue', enabled: true, strategy: 'idle', robot: cloneRobot(DEFAULT_ROBOT) },
      { slot: 'blue-2', alliance: 'blue', enabled: true, strategy: 'toggles', robot: cloneRobot(DEFAULT_ROBOT) },
    ],
  };
}

const goalIndex = (id: string) => buildGoals().findIndex((g) => g.id === id);

describe('Predicted events from other robots', () => {
  it('an object this robot already took is never also placed by a predicted opponent event', () => {
    const sc = h2h();
    const w0 = new PlanWorld(planConfigFor(sc, sc.slots[0], [], { candidateK: Infinity }));
    const s0 = w0.initialState();
    // the field Cup the red robot reaches first
    const pick = w0.legalActions(s0).find((a) => a.type === 'pick' && w0.objs[a.obj].kind === 'cup');
    expect(pick).toBeTruthy();
    const cup = (pick as { obj: number }).obj;
    // opponent is predicted to claim it at 30 s and stack it on a blue-side neutral Goal at 35 s
    const events: ExternalEvent[] = [
      { t: 30, kind: 'claim', obj: cup },
      { t: 35, kind: 'place', goal: goalIndex('G-B1n'), obj: cup, bit: 0 },
    ];
    const w = new PlanWorld(planConfigFor(sc, sc.slots[0], events, { candidateK: Infinity }));
    let s = w.initialState();
    const r1 = w.apply(s, { type: 'pick', obj: cup })!;
    expect(r1).toBeTruthy();
    s = r1.s;
    const place = w.legalActions(s).find((a) => a.type === 'place' && w.goals[a.goal].id === 'G-R1n');
    expect(place).toBeTruthy();
    s = w.apply(s, place!)!.s;
    const f = w.finalize(s);
    const appearances = f.stacks.flat().filter((code) => code >> 1 === cup).length;
    expect(appearances).toBe(1);
  });

  it('a predicted placement that no longer fits the Pin–Cup alternation is dropped', () => {
    const sc = h2h();
    const w0 = new PlanWorld(planConfigFor(sc, sc.slots[0]));
    // Neutral Goals start with a Pin, so the next element must be a Cup; a predicted Pin is dropped.
    const pin = w0.objs.findIndex((o) => o.kind === 'pin' && w0.initialState().status[o.idx] === ST_FIELD);
    const events: ExternalEvent[] = [{ t: 20, kind: 'place', goal: goalIndex('G-B1n'), obj: pin, bit: 0 }];
    const w = new PlanWorld(planConfigFor(sc, sc.slots[0], events));
    const f = w.finalize(w.initialState());
    const gi = w.goals.findIndex((g) => g.id === 'G-B1n');
    expect(f.stacks[gi].length).toBe(1);
  });

  it('the scripted Toggle patrol keeps re-asserting Toggles all match, own side only in Autonomous (SG7)', () => {
    const sc = h2h();
    const slot = sc.slots[3];
    const w = new PlanWorld(planConfigFor(sc, slot));
    const acts = scriptedActions(sc, slot, w)!;
    const ev = predictEvents(w, acts).filter((e) => e.kind === 'toggle');
    const ids = (e: ExternalEvent) => buildToggles()[e.toggle!].id;
    const auto = ev.filter((e) => e.t <= 15);
    expect(auto.length).toBeGreaterThan(0);
    for (const e of auto) expect(ids(e)).toMatch(/^T-B/);
    expect(ev.some((e) => e.t > 100)).toBe(true);
    expect(new Set(ev.filter((e) => e.t > 15).map(ids)).size).toBe(4);
    for (const e of ev) expect(e.position).toBe('blue');
  });

  it('predictOthers includes the partner parking and the opponent patrol', () => {
    const sc = h2h();
    const ev = predictOthers(sc, 'red-1');
    expect(ev.some((e) => e.kind === 'midfield' && e.robotId === 'red-2')).toBe(true);
    expect(ev.filter((e) => e.kind === 'toggle').length).toBeGreaterThan(10);
    for (let i = 1; i < ev.length; i++) expect(ev[i].t).toBeGreaterThanOrEqual(ev[i - 1].t);
  });
});

describe('Planner legality and search details', () => {
  it('apply() itself refuses an opposing-side Toggle during Autonomous (SG7), and allows it in Driver Control', () => {
    const sc = h2h();
    const w = new PlanWorld(planConfigFor(sc, sc.slots[0]));
    const tb = w.toggles.findIndex((t) => t.id === 'T-B1');
    const s0 = w.initialState();
    expect(w.apply(s0, { type: 'toggle', toggle: tb })).toBeNull();
    const s1 = w.apply(s0, { type: 'wait', until: 15 })!.s;
    expect(w.apply(s1, { type: 'toggle', toggle: tb })).not.toBeNull();
  });

  it('a parked robot has no remaining potential (the bound is 0)', () => {
    const sc = h2h();
    const w = new PlanWorld(planConfigFor(sc, sc.slots[0]));
    const s1 = w.apply(w.initialState(), { type: 'wait', until: 15 })!.s;
    expect(upperBoundAdd(w, s1)).toBeGreaterThan(0);
    const s2 = w.apply(s1, { type: 'park' })!.s;
    expect(s2.parked).toBe(true);
    expect(upperBoundAdd(w, s2)).toBe(0);
  });

  it('beam search uses Autonomous instead of idling through it (time has value in the ranking)', () => {
    const sc = h2h();
    const w = new PlanWorld(planConfigFor(sc, sc.slots[0], [], { candidateK: 5 }));
    const res = beamSearch(w, { width: 8, alpha: 0.3 }, { maxMs: Infinity, maxExpansions: Infinity });
    const rp = replay(w, res.best.actions, true);
    const autoWork = rp.steps.filter((st) => st.tStart < 15 && !st.label.startsWith('Wait'));
    expect(autoWork.length).toBeGreaterThan(0);
    // the ρ term only changes the ranking, never a plan's value: the result is a valid plan
    expect(rp.value).toBe(res.best.value);
  });
});
