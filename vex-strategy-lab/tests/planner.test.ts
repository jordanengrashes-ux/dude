import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { dist, distToSegment } from '../src/core/vec';
import { buildLayout, type FieldLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { astar } from '../src/planner/astar';
import { Grid } from '../src/planner/grid';
import { PlanWorld, type PlanConfig, type StaticObj } from '../src/planner/model';
import { DEFAULT_SETTINGS, optimize } from '../src/planner/optimizer';
import { beamSearch } from '../src/planner/search/beam';
import { upperBoundAdd } from '../src/planner/search/bounds';
import { branchAndBound, exhaustive } from '../src/planner/search/branchAndBound';
import { replay } from '../src/planner/search/common';
import { mcts } from '../src/planner/search/mcts';
import { VisGraph } from '../src/planner/visgraph';

const skillsLayout = buildLayout('skillsDriver');
const h2hLayout = buildLayout('headToHead');

function baseCfg(over: Partial<PlanConfig> = {}): PlanConfig {
  return {
    params: OVERRIDE_DEFAULTS,
    robot: DEFAULT_ROBOT,
    layout: skillsLayout,
    matchType: 'skillsDriver',
    robotId: 'red-1',
    alliance: 'red',
    tStart: 0,
    tEnd: 60,
    objective: 'own',
    awpWeight: 0,
    includeAutonBonus: false,
    opponentAutoScore: 0,
    externalEvents: [],
    candidateK: Infinity,
    allowPark: true,
    cruiseFraction: 0.85,
    positionSigma: 0.3,
    ...over,
  };
}

/** Objects nearest a point, by kind. */
function nearestIds(layout: FieldLayout, at: { x: number; y: number }, pins: number, cups: number): Set<string> {
  const field = (k: 'pin' | 'cup') =>
    (k === 'pin' ? layout.pins : layout.cups)
      .filter((o) => o.start.where === 'field')
      .map((o) => ({ id: o.id, d: dist((o.start as { pos: { x: number; y: number } }).pos, at) }))
      .sort((a, b) => a.d - b.d);
  return new Set([...field('pin').slice(0, pins).map((x) => x.id), ...field('cup').slice(0, cups).map((x) => x.id)]);
}

function tinyCfg(seconds: number, pins = 3, cups = 1): PlanConfig {
  const start = skillsLayout.robots[0].pos;
  const ids = nearestIds(skillsLayout, start, pins, cups);
  return baseCfg({
    tEnd: seconds,
    objectFilter: (o: StaticObj) => ids.has(o.id),
    goalFilter: (g) => g.id === 'G-R1a' || g.id === 'G-R1n',
    toggleFilter: (t) => t.id === 'T-R1',
    allowPark: false,
  });
}

describe('Path planning', () => {
  const grid = new Grid({ clearance: 9.5 });
  const vg = new VisGraph(grid);

  it('a straight line through the Midfield Goal is rejected; the path goes around it', () => {
    const a = { x: -40, y: 0 };
    const b = { x: 40, y: 0 };
    expect(grid.segmentClear(a, b)).toBe(false);
    const p = vg.path(a, b)!;
    expect(p).not.toBeNull();
    let len = 0;
    for (let i = 1; i < p.length; i++) {
      len += dist(p[i - 1], p[i]);
      expect(grid.segmentClear(p[i - 1], p[i])).toBe(true);
      expect(distToSegment({ x: 0, y: 0 }, p[i - 1], p[i])).toBeGreaterThan(1.15 + 9.5 - 1e-6); // post radius + clearance
    }
    expect(len).toBeGreaterThan(80);
    expect(len).toBeLessThan(80 * 1.25);
  });

  it('A* on the grid agrees with the visibility graph within 10%', () => {
    const rng = new Rng(3);
    let checked = 0;
    for (let k = 0; k < 40; k++) {
      const a = { x: rng.range(-60, 60), y: rng.range(-60, 60) };
      const b = { x: rng.range(-60, 60), y: rng.range(-60, 60) };
      if (grid.pointBlocked(a) || grid.pointBlocked(b)) continue;
      const pa = astar(grid, a, b);
      const pv = vg.path(a, b);
      expect(!!pa).toBe(!!pv);
      if (!pa || !pv) continue;
      const lv = pv.reduce((s, q, i) => (i ? s + dist(pv[i - 1], q) : 0), 0);
      expect(Math.abs(pa.length - lv) / Math.max(lv, 1)).toBeLessThan(0.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('Autonomous grid forbids the opposing side (SG7) but allows the Midfield (SG8)', () => {
    const g = new Grid({ clearance: 9.5, alliance: 'red', forbidOpposingSide: true });
    expect(g.pointBlocked({ x: 40, y: 30 })).toBe(true);
    expect(g.pointBlocked({ x: -35, y: -35 })).toBe(false);
    expect(g.pointBlocked({ x: 10, y: 10 })).toBe(false);
  });
});

describe('Model legality and physical feasibility', () => {
  it('rejects a placement the lift cannot reach (stack too tall)', () => {
    const rack = cloneRobot();
    rack.lift.type = 'rackPinion';
    rack.lift.travelIn = 4; // max holder ≈ 4.4" — below a neutral Goal rim + clearance (6.3")
    const dr4b = cloneRobot();
    dr4b.lift.maxAngleDeg = -11; // DR4B travel 2·8.5·(sin −11° + sin 25°) ≈ 3.9"
    for (const r of [rack, dr4b]) {
      const w = new PlanWorld(baseCfg({ robot: r }));
      const s = w.initialState();
      const gi = w.goals.findIndex((g) => g.id === 'G-R1n');
      expect(w.apply(s, { type: 'place', goal: gi, bit: 0 })).toBeNull();
      // the 3.25" Alliance Goal is still reachable (needs 3.75")
      const ga = w.goals.findIndex((g) => g.id === 'G-R1a');
      expect(w.apply(s, { type: 'place', goal: ga, bit: 0 })).not.toBeNull();
    }
  });

  it('SG9: never offers placements in the opposing Alliance Goals', () => {
    const w = new PlanWorld(baseCfg({ matchType: 'headToHead', layout: h2hLayout, tStart: 15, tEnd: 120 }));
    const s = w.initialState();
    const bad = w.legalActions(s).filter((a) => a.type === 'place' && w.goals[a.goal].allianceColor === 'blue');
    expect(bad).toHaveLength(0);
  });

  it('SG7: in Autonomous, no pickups or placements on the opposing side', () => {
    const w = new PlanWorld(baseCfg({ matchType: 'headToHead', layout: h2hLayout, tStart: 0, tEnd: 15 }));
    const s = w.initialState();
    for (const a of w.legalActions(s)) {
      if (a.type === 'pick') {
        const p = w.objs[a.obj].startPos!;
        const mid = Math.abs(p.x) < 22.4 && Math.abs(p.y) < 22.4;
        expect(p.x + p.y < 0 || mid).toBe(true);
      }
      if (a.type === 'place') expect(w.goals[a.goal].type === 'midfield' || w.goals[a.goal].pos.x + w.goals[a.goal].pos.y < 0).toBe(true);
    }
  });

  it('SG12: no Midfield Goal placement that ends in the Endgame', () => {
    const w = new PlanWorld(baseCfg({ matchType: 'headToHead', layout: h2hLayout, tStart: 109, tEnd: 120, startPose: { pos: { x: -20, y: -20 }, heading: Math.PI / 4 } }));
    const s = w.initialState();
    const gi = w.goals.findIndex((g) => g.type === 'midfield');
    expect(w.apply(s, { type: 'place', goal: gi, bit: 0 })).toBeNull();
  });

  it('respects the possession limit (1 Pin + 1 Cup)', () => {
    const w = new PlanWorld(baseCfg());
    const s = w.initialState();
    expect(s.heldPin).toBeGreaterThanOrEqual(0); // preload
    expect(w.legalActions(s).some((a) => a.type === 'pick' && w.objs[a.obj].kind === 'pin')).toBe(false);
    expect(w.legalActions(s).some((a) => a.type === 'pick' && w.objs[a.obj].kind === 'cup')).toBe(true);
  });
});

describe('Optimizer correctness on small, exhaustively solvable scenarios', () => {
  for (const [secs, pins, cups] of [
    [6, 2, 1],
    [8, 3, 1],
    [9, 3, 2],
  ] as const) {
    it(`B&B proves the same optimum as brute force (${secs}s, ${pins} pins, ${cups} cups); beam/MCTS never exceed it`, () => {
      const w = new PlanWorld(tinyCfg(secs, pins, cups));
      const ex = exhaustive(w, 3_000_000);
      expect(ex.complete).toBe(true);
      const bb = branchAndBound(w, { epsilon: 1e-9 }, { maxMs: 60000, maxExpansions: Infinity });
      expect(bb.stats.proven).toBe(true);
      expect(bb.best.value).toBe(ex.value);
      expect(replay(w, bb.best.actions).value).toBe(ex.value);
      const bm = beamSearch(w, { width: 64, alpha: 0.3 }, { maxMs: 60000, maxExpansions: Infinity });
      expect(bm.best.value).toBeLessThanOrEqual(ex.value);
      const mc = mcts(w, { iterations: 800, exploration: 0.7, rolloutEpsilon: 0.3, seed: 5, maxRolloutDepth: 30 }, { maxMs: 60000, maxExpansions: Infinity });
      expect(mc.best.value).toBeLessThanOrEqual(ex.value);
      // the root bound must be admissible
      expect(w.value(w.initialState()) + upperBoundAdd(w, w.initialState())).toBeGreaterThanOrEqual(ex.value);
    });
  }

  it('the admissible bound holds at random intermediate states', () => {
    const w = new PlanWorld(tinyCfg(9, 3, 2));
    const rng = new Rng(11);
    let checked = 0;
    for (let trial = 0; trial < 25; trial++) {
      let s = w.initialState();
      const depth = rng.int(4);
      for (let d = 0; d < depth; d++) {
        const acts = w.legalActions(s);
        if (!acts.length) break;
        const r = w.apply(s, rng.pick(acts));
        if (r) s = r.s;
      }
      const ex = exhaustive(w, 1_000_000, s);
      expect(ex.complete).toBe(true);
      expect(w.value(s) + upperBoundAdd(w, s) + 1e-9).toBeGreaterThanOrEqual(ex.value);
      checked++;
    }
    expect(checked).toBe(25);
  });
});

describe('Strategy quality', () => {
  it('the shortest route loses to a better-scoring route', () => {
    // Skills: a near red/yellow Pin (yellow unowned → 5) vs a farther red/blue Pin (both halves → 10).
    const start = skillsLayout.robots[0];
    const pins = skillsLayout.pins.filter((p) => p.start.where === 'field');
    const ry = pins.filter((p) => p.type === 'RY').sort((a, b) => dist((a.start as any).pos, start.pos) - dist((b.start as any).pos, start.pos))[0];
    const rb = pins.filter((p) => p.type === 'RB').sort((a, b) => dist((a.start as any).pos, start.pos) - dist((b.start as any).pos, start.pos))[0];
    expect(dist((rb.start as any).pos, start.pos)).toBeGreaterThan(dist((ry.start as any).pos, start.pos));
    const cfg = baseCfg({
      tEnd: 9,
      objectFilter: (o) => o.id === ry.id || o.id === rb.id,
      goalFilter: (g) => g.id === 'G-R1a',
      toggleFilter: () => false,
      allowPark: false,
    });
    const w = new PlanWorld(cfg);
    const bb = branchAndBound(w, { epsilon: 1e-9 }, { maxMs: 60000, maxExpansions: Infinity });
    expect(bb.stats.proven).toBe(true);
    const picked = bb.best.actions.filter((a) => a.type === 'pick').map((a) => w.objs[(a as { obj: number }).obj].id);
    expect(picked).toContain(rb.id);
    const best = replay(w, bb.best.actions, true);
    const shortest = replay(w, [{ type: 'pick', obj: w.objs.find((o) => o.id === ry.id)!.idx }, { type: 'place', goal: 0, bit: 0 }], true);
    const dBest = best.steps.reduce((a, s) => a + s.travelDist, 0);
    const dShort = shortest.steps.reduce((a, s) => a + s.travelDist, 0);
    expect(dBest).toBeGreaterThan(dShort);
    expect(best.value).toBeGreaterThan(shortest.value);
  });

  it('chooses a lower raw-score Autonomous action when it improves the total match result', () => {
    // One yellow/yellow Pin, the R1 neutral Goal and the Midfield Goal. The opponent is predicted
    // to flip Toggle R1 to blue at 29 s, too late to answer. Putting the Pin in R1 and flipping the
    // Toggle scores 20 in Autonomous (Bonus 12) but is worth nothing at the end; putting it on the
    // Midfield Goal scores 0 in Autonomous (tie, 6 each) but 20 at the end when the robot parks.
    const L = h2hLayout;
    const robot = L.robots.find((r) => r.slot === 'red-1')!;
    const yy = L.pins
      .filter((p) => p.type === 'YY' && p.start.where === 'field')
      .sort((a, b) => dist((a.start as any).pos, robot.pos) - dist((b.start as any).pos, robot.pos))[0];
    const cfg = baseCfg({
      matchType: 'headToHead',
      layout: L,
      tStart: 0,
      tEnd: 30,
      includeAutonBonus: true,
      objectFilter: (o) => o.id === yy.id,
      goalFilter: (g) => g.id === 'G-R1n' || g.id === 'G-MID',
      toggleFilter: (t) => t.id === 'T-R1',
      externalEvents: [{ t: 29, kind: 'toggle', toggle: 0, position: 'blue' }],
      allowPark: true,
    });
    const w = new PlanWorld(cfg);
    const bb = branchAndBound(w, { epsilon: 1e-9 }, { maxMs: 120000, maxExpansions: Infinity });
    expect(bb.stats.proven).toBe(true);
    const chosen = replay(w, bb.best.actions);
    const fin = w.finalize(chosen.state);
    expect(fin.auto).toBeDefined();
    // Highest raw Autonomous score available (Autonomous-only window):
    const wa = new PlanWorld({ ...cfg, tEnd: 15, includeAutonBonus: false, externalEvents: [] });
    const autoOnly = branchAndBound(wa, { epsilon: 1e-9 }, { maxMs: 60000, maxExpansions: Infinity });
    expect(autoOnly.stats.proven).toBe(true);
    expect(fin.auto!.own).toBeLessThan(autoOnly.best.value);
    // and the raw-max Autonomous plan, continued optimally, totals less
    const rawMaxPrefix = autoOnly.best.actions;
    const contW = new PlanWorld(cfg);
    let s = contW.initialState();
    for (const a of rawMaxPrefix) s = contW.apply(s, a)!.s;
    // Compare by full-window objective: chosen plan vs any plan starting with the raw-max prefix
    let bestWithPrefix = -Infinity;
    const stack: { st: typeof s }[] = [{ st: s }];
    let nodes = 0;
    while (stack.length && nodes < 200000) {
      const { st } = stack.pop()!;
      nodes++;
      bestWithPrefix = Math.max(bestWithPrefix, contW.value(st));
      for (const a of contW.legalActions(st)) {
        const r = contW.apply(st, a);
        if (r) stack.push({ st: r.s });
      }
    }
    expect(bb.best.value).toBeGreaterThan(bestWithPrefix);
  });
});

describe('Optimizer orchestration', () => {
  const cfg = tinyCfg(12, 4, 2);
  const settings = { ...DEFAULT_SETTINGS, deterministic: true, mctsIterations: 400, evolveGenerations: 20, bnbExpansions: 200000, robustnessTrials: 20, robustnessCandidates: 3, explainAlternatives: 1 };

  it('is deterministic for a fixed seed and reports a proof on a small scenario', async () => {
    const a = await optimize(cfg, settings);
    const b = await optimize(cfg, settings);
    expect(JSON.stringify(a.best.actions)).toBe(JSON.stringify(b.best.actions));
    expect(a.best.value).toBe(b.best.value);
    expect(a.optimality.status).toBe('verified-optimum');
    expect(a.optimality.gap).toBe(0);
    const ex = exhaustive(new PlanWorld(cfg), 5_000_000);
    if (ex.complete) expect(a.best.value).toBe(ex.value);
    // every point of the reported score comes from the rules engine
    expect(a.best.finalReport.totals.red + 0).toBe(a.best.value);
  });

  it('stops promptly when cancelled and still returns the best plan so far; a fresh run recovers', async () => {
    const big = baseCfg({ candidateK: 6 });
    const signal = { cancelled: false };
    const r = await optimize(big, { ...DEFAULT_SETTINGS, budgetMs: 60000, robustnessTrials: 5, robustnessCandidates: 1, explainAlternatives: 0 }, {
      signal,
      onProgress: (p) => {
        if (p.phase.startsWith('beam w=16')) signal.cancelled = true;
      },
    });
    expect(r.stoppedBy).toBe('cancelled');
    expect(r.best.value).toBeGreaterThan(0);
    expect(r.durationMs).toBeLessThan(30000);
    const again = await optimize(big, { ...DEFAULT_SETTINGS, budgetMs: 4000, robustnessTrials: 5, robustnessCandidates: 1, explainAlternatives: 0 });
    expect(again.stoppedBy === 'completed' || again.stoppedBy === 'budget').toBe(true);
    expect(again.best.value).toBeGreaterThan(0);
  });
});
