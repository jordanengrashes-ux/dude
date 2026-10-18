import { describe, expect, it } from 'vitest';
import { IN } from '../src/core/units';
import { HALF } from '../src/field/geometry';
import { buildLayout, type FieldLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { derivePerf, liftTime, maxHolderHeight, straightTime, turnTime } from '../src/robot/kinematics';
import { liftTravel } from '../src/robot/lift';
import { OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { computeScore } from '../src/rules/scoring';
import { togglePosition } from '../src/physics/field';
import { approach, pursue, turnTo, DEFAULT_TUNING } from '../src/sim/drive';
import { MatchSim, type Controller } from '../src/sim/match';
import { PlanWorld, type PlanConfig } from '../src/planner/model';
import { beamSearch } from '../src/planner/search/beam';
import { PlanExecutor } from '../src/sim/executor';

const skills = buildLayout('skillsDriver');
const empty: FieldLayout = { ...skills, pins: [], cups: [] };

function fn(f: Controller['update']): Controller {
  return { kind: 'test', update: f };
}

async function simWith(ctl: Controller, opts: { layout?: FieldLayout; start?: { pos: { x: number; y: number }; heading: number }; robot?: typeof DEFAULT_ROBOT; seed?: number } = {}) {
  return MatchSim.create({
    params: OVERRIDE_DEFAULTS,
    layout: opts.layout ?? empty,
    robots: [{ id: 'red-1', alliance: 'red', config: opts.robot ?? DEFAULT_ROBOT, controller: ctl, start: opts.start ?? { pos: { x: 0, y: 40 }, heading: 0 } }],
    seed: opts.seed ?? 1,
  });
}

describe('Collisions', () => {
  it('a robot driving full speed into the perimeter stays inside the field', async () => {
    const sim = await simWith(fn((_s, r) => (r.body.cmd = { left: 1, right: 1 })), { start: { pos: { x: 30, y: 0 }, heading: 0 } });
    sim.runUntil(3);
    const p = sim.robots[0].body.pose();
    expect(p.pos.x + DEFAULT_ROBOT.chassis.lengthIn / 2).toBeLessThanOrEqual(HALF + 0.3);
    expect(p.pos.x).toBeGreaterThan(HALF - DEFAULT_ROBOT.chassis.lengthIn / 2 - 2);
    sim.dispose();
  });

  it('a robot cannot drive through a Goal post', async () => {
    // Drive straight at the Midfield Goal from the side (post not aligned with the slot).
    const sim = await simWith(fn((_s, r) => (r.body.cmd = { left: 1, right: 1 })), { start: { pos: { x: -30, y: 6 }, heading: 0 } });
    let minDist = Infinity;
    sim.runUntil(2.5, () => {
      const p = sim.robots[0].body.pose();
      minDist = Math.min(minDist, Math.hypot(p.pos.x, p.pos.y));
    });
    const p = sim.robots[0].body.pose();
    // the robot is stopped or deflected by the post: it never ends up beyond the goal on the original line
    expect(p.pos.x).toBeLessThan(20);
    expect(minDist).toBeGreaterThan(3);
    sim.dispose();
  });

  it('two robots driving into each other do not interpenetrate', async () => {
    const ctl = fn((_s, r) => (r.body.cmd = { left: 0.8, right: 0.8 }));
    const sim = await MatchSim.create({
      params: OVERRIDE_DEFAULTS,
      layout: { ...buildLayout('headToHead'), pins: [], cups: [] },
      robots: [
        { id: 'red-1', alliance: 'red', config: DEFAULT_ROBOT, controller: ctl, start: { pos: { x: -24, y: 40 }, heading: 0 } },
        { id: 'blue-1', alliance: 'blue', config: DEFAULT_ROBOT, controller: ctl, start: { pos: { x: 24, y: 40 }, heading: Math.PI } },
      ],
      seed: 1,
    });
    let minD = Infinity;
    sim.runUntil(2.5, () => {
      const a = sim.robots[0].body.pose().pos;
      const b = sim.robots[1].body.pose().pos;
      minD = Math.min(minD, Math.hypot(a.x - b.x, a.y - b.y));
    });
    expect(minD).toBeGreaterThan(DEFAULT_ROBOT.chassis.lengthIn - 0.6);
    expect(sim.events.some((e) => e.type === 'collision')).toBe(true);
    sim.dispose();
  });
});

describe('Determinism and timestep independence', () => {
  const run = async (chunks: number[]) => {
    const layout = buildLayout('skillsDriver');
    let k = 0;
    const sim = await simWith(
      fn((s, r) => {
        k++;
        r.body.cmd = { left: Math.sin(s.t * 1.3), right: Math.cos(s.t * 0.9) };
        r.body.liftTarget = 6 + 5 * Math.sin(s.t);
      }),
      { layout, start: layout.robots[0] },
    );
    for (const c of chunks) for (let i = 0; i < c; i++) sim.step();
    const fp = sim.fingerprint();
    sim.dispose();
    return { fp, k };
  };
  it('identical inputs → bit-identical state; stepping in different batch sizes does not change results', async () => {
    const a = await run([600]);
    const b = await run([600]);
    const c = await run([1, 7, 92, 300, 200]);
    expect(a.fp).toBe(b.fp);
    expect(a.fp).toBe(c.fp);
    expect(a.k).toBe(600);
  });
});

describe('Robot model vs physics (calibration)', () => {
  const perf = derivePerf(DEFAULT_ROBOT);
  const tune = { ...DEFAULT_TUNING, trackWidth: DEFAULT_ROBOT.drivetrain.trackWidthIn };
  it('turn-in-place times agree with the planner model within 25%', async () => {
    for (const ang of [Math.PI / 2, Math.PI]) {
      let done = -1;
      const sim = await simWith(
        fn((s, r, sense) => {
          if (done >= 0) return;
          const out = turnTo(perf, sense, ang, tune);
          r.body.cmd = { left: out.left, right: out.right };
          if (out.done) done = s.t;
        }),
      );
      sim.runUntil(5, () => done < 0);
      expect(done).toBeGreaterThan(0);
      expect(Math.abs(done - turnTime(perf, ang)) / turnTime(perf, ang)).toBeLessThan(0.25);
      sim.dispose();
    }
  });
  it('straight-line drive times agree with the planner model within 25%', async () => {
    for (const d of [24, 40]) {
      let done = -1;
      const ps = { path: [{ x: -14, y: 0 }, { x: -14 - d, y: 0 }], seg: 0 };
      const sim = await simWith(
        fn((s, r, sense) => {
          if (done >= 0) return;
          const out = pursue(perf, sense, ps, DEFAULT_ROBOT.drivetrain.trackWidthIn, tune, 2);
          r.body.cmd = { left: out.left, right: out.right };
          if (out.done) done = s.t;
        }),
        { start: { pos: { x: -14, y: 0 }, heading: Math.PI } },
      );
      sim.runUntil(5, () => done < 0);
      expect(done).toBeGreaterThan(0);
      expect(Math.abs(done - straightTime(perf, d)) / straightTime(perf, d)).toBeLessThan(0.25);
      sim.dispose();
    }
  });
});

describe('Mechanisms, seating and scoring', () => {
  it('the DR4B and the rack-and-pinion lift each reach their travel limit and no further', async () => {
    const rack = cloneRobot();
    rack.lift.type = 'rackPinion';
    rack.lift.motor = { cartridgeRpm: 200, gearRatio: 1, motorCount: 1, direction: 1 };
    for (const robot of [DEFAULT_ROBOT, rack]) {
      const sim = await simWith(fn((_s, r) => (r.body.liftTarget = 40)), { robot });
      sim.runUntil(4);
      const h = sim.robots[0].body.holderHeight();
      const top = robot.lift.holderMinHeightIn + liftTravel(robot);
      expect(h).toBeGreaterThan(top - 0.5);
      expect(h).toBeLessThan(top + 0.5);
      sim.dispose();
    }
  });

  it('DR4B: physics lift time matches the model, and the lift is fastest with the bars level', async () => {
    const perf = derivePerf(DEFAULT_ROBOT);
    const h0 = DEFAULT_ROBOT.lift.holderMinHeightIn;
    // speed table: level bars (θ = 0) beat the top of travel (θ = 50°), as 2L·cos θ predicts
    const tab = perf.liftTable;
    const at = (h: number) => tab.up[Math.round((h - h0) / tab.step)];
    const hLevel = h0 + 2 * DEFAULT_ROBOT.lift.barLengthIn * Math.sin((25 * Math.PI) / 180);
    expect(at(hLevel)).toBeGreaterThan(at(maxHolderHeight(DEFAULT_ROBOT) - 0.5) * 1.3);
    for (const target of [8, 18]) {
      let reached = -1;
      const sim = await simWith(fn((s, r) => {
        r.body.liftTarget = target;
        if (reached < 0 && r.body.holderHeight() >= target - 0.25) reached = s.t;
      }));
      sim.runUntil(3, () => reached < 0);
      const model = liftTime(perf, h0, target);
      expect(reached).toBeGreaterThan(0);
      expect(Math.abs(reached - model) / model).toBeLessThan(0.3);
      sim.dispose();
    }
  });

  async function dropTest(offsetIn: number) {
    // Robot raises its preload, drives in until the holder is over the G-R1a axis
    // (offset laterally by `offsetIn`), stops, and releases.
    const goal = { x: -2 * (600 / 25.4), y: -600 / 25.4 };
    const L = DEFAULT_ROBOT.intake.holderOffsetIn;
    let phase: 'lift' | 'drive' | 'release' | 'done' = 'lift';
    const stopX = goal.x - L;
    const perf = derivePerf(DEFAULT_ROBOT);
    const tune = { ...DEFAULT_TUNING, trackWidth: DEFAULT_ROBOT.drivetrain.trackWidthIn };
    const sim = await MatchSim.create({
      params: OVERRIDE_DEFAULTS,
      layout: { ...skills, cups: [], pins: skills.pins.filter((p) => p.start.where === 'preload') },
      robots: [
        {
          id: 'red-1',
          alliance: 'red',
          config: DEFAULT_ROBOT,
          controller: fn((_s, r, sense) => {
            r.body.liftTarget = 4.2;
            if (phase === 'lift' && sense.holderHeight > 4.0) phase = 'drive';
            if (phase === 'drive') {
              // the executor's final-approach controller, aimed at a point offset from the Goal axis
              const out = approach(perf, sense, { x: goal.x, y: goal.y + offsetIn }, L, 8, DEFAULT_ROBOT.drivetrain.trackWidthIn, tune);
              r.body.cmd = { left: out.left, right: out.right };
              if (Math.abs(out.along) < 0.15 && Math.abs(sense.speed) < 1) phase = 'release';
            } else r.body.cmd = { left: 0, right: 0 };
            if (phase === 'release' && Math.abs(sense.speed) < 0.3) {
              r.req.release = true;
              phase = 'done';
            }
          }),
          start: { pos: { x: stopX - 6, y: goal.y }, heading: 0 },
        },
      ],
      seed: 1,
    });
    sim.runUntil(5);
    const fs = sim.extractFieldState();
    const g = fs.goals.find((x) => x.id === 'G-R1a')!;
    const score = sim.liveScore();
    sim.dispose();
    return { stack: g.stack.length, score: score.totals.red, phase };
  }

  it('an aligned release nests the Pin and the rules engine scores it', async () => {
    const r = await dropTest(0);
    expect(r.stack).toBe(1);
    expect(r.score).toBe(5); // red half visible; yellow half unowned (neutral Toggle)
  });

  it('a release 1.5" off-axis is NOT captured by the funnel and scores nothing', async () => {
    const r = await dropTest(1.5);
    expect(r.stack).toBe(0);
    expect(r.score).toBe(0);
  });

  it('a Toggle rotates only when actuated, seats in a detent, and robot contact neutralizes it (SC4)', async () => {
    const sim = await MatchSim.create({
      params: OVERRIDE_DEFAULTS,
      layout: empty,
      robots: [
        {
          id: 'red-1',
          alliance: 'red',
          config: DEFAULT_ROBOT,
          controller: fn((s, r) => {
            if (s.t < 1.2) {
              r.req.toggle = { toggleId: 'T-R1', target: 'red' };
              r.body.cmd = { left: 0, right: 0 };
            } else if (s.t < 1.45) r.body.cmd = { left: -0.3, right: -0.3 }; // back away
            else if (s.t < 1.9) r.body.cmd = { left: 0, right: 0 };
            else r.body.cmd = { left: 0.3, right: 0.3 }; // drive to the wall: the arm paddle presses on the bar
          }),
          // bumper 2.5" off the wall: within arm reach, arm tip still clear of the bar
          start: { pos: { x: -HALF + 10.5, y: 4 }, heading: Math.PI },
        },
      ],
      seed: 1,
    });
    const tb = sim.field.toggles.find((t) => t.geom.id === 'T-R1')!;
    expect(togglePosition(tb)).toBe('yellow');
    sim.runUntil(1.9);
    expect(togglePosition(tb)).toBe('red');
    let fs = sim.extractFieldState();
    expect(fs.toggles.find((x) => x.quadrant === 'R1')!).toMatchObject({ position: 'red', robotContact: false });
    sim.runUntil(3.6);
    fs = sim.extractFieldState();
    expect(fs.toggles.find((x) => x.quadrant === 'R1')!.robotContact).toBe(true);
    // a contacted Toggle is neutral for scoring: no owner for R1
    expect(computeScore(fs, OVERRIDE_DEFAULTS, { matchType: 'skillsDriver', period: 'skills' }).ownership.R1).toBeNull();
    sim.dispose();
  });

  it('objects never teleport: per-step displacement is bounded during a full executed plan', async () => {
    const layout = buildLayout('skillsDriver');
    const cfg: PlanConfig = {
      params: OVERRIDE_DEFAULTS,
      robot: DEFAULT_ROBOT,
      layout,
      matchType: 'skillsDriver',
      robotId: 'red-1',
      alliance: 'red',
      tStart: 0,
      tEnd: 25,
      objective: 'own',
      awpWeight: 0,
      includeAutonBonus: false,
      opponentAutoScore: 0,
      externalEvents: [],
      candidateK: 5,
      allowPark: false,
      cruiseFraction: 0.85,
      positionSigma: 0.3,
    };
    const w = new PlanWorld(cfg);
    const plan = beamSearch(w, { width: 8, alpha: 0.3 }, { maxMs: Infinity, maxExpansions: Infinity });
    const ex = new PlanExecutor(cfg, plan.best.actions, { enabled: true, periodicSec: 0, beamWidth: 6, candidateK: 4, maxExpansions: 800 }, w);
    const sim = await MatchSim.create({ params: OVERRIDE_DEFAULTS, layout, robots: [{ id: 'red-1', alliance: 'red', config: DEFAULT_ROBOT, controller: ex }], seed: 1 });
    const last = new Map<string, { x: number; y: number; z: number }>();
    let maxStep = 0;
    sim.runUntil(25, () => {
      for (const o of sim.objects.objects.values()) {
        if (!o.body) continue;
        const p = o.body.translation();
        const q = last.get(o.id);
        if (q && o.introducedAt !== sim.t) maxStep = Math.max(maxStep, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) / IN);
        last.set(o.id, { x: p.x, y: p.y, z: p.z });
      }
    });
    // 3 m/s would be 0.98"/step at 120 Hz; nothing in this game moves that fast
    expect(maxStep).toBeLessThan(1.0);
    // the displayed score is exactly the rules engine applied to the extracted state
    const rep = sim.liveScore();
    const direct = computeScore(sim.extractFieldState(), OVERRIDE_DEFAULTS, { matchType: 'skillsDriver', period: 'skills' });
    expect(rep.totals).toEqual(direct.totals);
    expect(rep.totals.red).toBeGreaterThan(0);
    // every score event corresponds to a rules-engine line
    for (const e of sim.events.filter((x) => x.type === 'score')) expect(e.ruleId).toMatch(/^SC/);
    sim.dispose();
  });

  it('a robot with a very high center of mass tips over under hard braking', async () => {
    const tall = cloneRobot();
    tall.mass.comHeightIn = 26;
    let t0 = -1;
    const sim = await simWith(
      fn((s, r) => {
        if (s.t < 0.9) r.body.cmd = { left: 1, right: 1 };
        else {
          if (t0 < 0) t0 = s.t;
          r.body.cmd = { left: -1, right: -1 };
        }
      }),
      { robot: tall, start: { pos: { x: -40, y: -36 }, heading: 0 } },
    );
    let maxTilt = 0;
    sim.runUntil(2.5, () => {
      maxTilt = Math.max(maxTilt, sim.robots[0].body.telemetry.tilt);
    });
    const normal = await simWith(
      fn((s, r) => (r.body.cmd = s.t < 0.9 ? { left: 1, right: 1 } : { left: -1, right: -1 })),
      { start: { pos: { x: -40, y: -36 }, heading: 0 } },
    );
    let normalTilt = 0;
    normal.runUntil(2.5, () => {
      normalTilt = Math.max(normalTilt, normal.robots[0].body.telemetry.tilt);
    });
    expect(maxTilt).toBeGreaterThan(normalTilt * 3);
    expect(maxTilt).toBeGreaterThan(0.2);
    expect(normalTilt).toBeLessThan(0.1);
    sim.dispose();
    normal.dispose();
  });
});

describe('Match clock in the simulator', () => {
  it('takes the Autonomous snapshot at 15 s and produces a full match result at 120 s', async () => {
    const L = { ...buildLayout('headToHead'), cups: [] };
    const idle = fn((_s, r) => (r.body.cmd = { left: 0, right: 0 }));
    const sim = await MatchSim.create({
      params: OVERRIDE_DEFAULTS,
      layout: L,
      robots: L.robots.map((r) => ({ id: r.slot, alliance: r.alliance, config: DEFAULT_ROBOT, controller: idle })),
      seed: 1,
    });
    sim.runUntil(16);
    expect(sim.autoState).not.toBeNull();
    sim.runUntil(121);
    expect(sim.result).not.toBeNull();
    // preplaced yellow/yellow Pins with neutral Toggles → no points; tie → 6 each
    expect(sim.result!.bonus).toMatchObject({ red: 6, blue: 6 });
    expect(sim.result!.totals).toEqual({ red: 6, blue: 6 });
    sim.dispose();
  });
});

describe('Full Head-to-Head match with four autonomous robots', () => {
  it('keeps every robot on the field and below its physical speed; every executor keeps working', async () => {
    // Regression: a free object trapped between a robot's carried object and its own
    // chassis used to close a push loop that launched the robot out of the field, and
    // a robot pinned against a wall used to idle for the rest of the match.
    const { buildMatch, planScenario } = await import('../src/sim/scenario');
    const sc = {
      params: OVERRIDE_DEFAULTS,
      layout: buildLayout('headToHead'),
      matchType: 'headToHead' as const,
      seed: 1,
      aiBeamWidth: 6,
      slots: [
        { slot: 'red-1', alliance: 'red' as const, enabled: true, strategy: 'optimized' as const, robot: cloneRobot(DEFAULT_ROBOT) },
        { slot: 'red-2', alliance: 'red' as const, enabled: true, strategy: 'midfield' as const, robot: cloneRobot(DEFAULT_ROBOT) },
        { slot: 'blue-1', alliance: 'blue' as const, enabled: true, strategy: 'optimized' as const, robot: cloneRobot(DEFAULT_ROBOT) },
        { slot: 'blue-2', alliance: 'blue' as const, enabled: true, strategy: 'toggles' as const, robot: cloneRobot(DEFAULT_ROBOT) },
      ],
    };
    const built = await buildMatch(sc, undefined, undefined, planScenario(sc, 'red-1'));
    const sim = built.sim;
    const vMax = derivePerf(DEFAULT_ROBOT).vFree;
    let maxSpeed = 0;
    let maxAbs = 0;
    while (sim.t < sim.clock.total) {
      sim.step();
      for (const r of sim.robots) {
        const v = r.body.chassis.linvel();
        maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z) / IN);
        const p = r.body.chassis.translation();
        maxAbs = Math.max(maxAbs, Math.abs(p.x) / IN, Math.abs(p.z) / IN);
      }
    }
    expect(sim.result).not.toBeNull();
    expect(maxAbs).toBeLessThan(HALF);
    expect(maxSpeed).toBeLessThan(vMax * 1.25);
    for (const id of ['red-1', 'blue-1']) {
      const ex = built.executors.get(id)!;
      // still completing actions in the last third of the match
      expect(ex.history.some((h) => h.ok && h.tEnd > 80)).toBe(true);
    }
    sim.dispose();
  });
});
