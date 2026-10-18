import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../src/core/units';
import { buildLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { buildMatch, type ScenarioConfig } from '../src/sim/scenario';
import { headingToTheta, liftHeightFromDegrees, liftMotorDegrees, previewPath, thetaToHeading, type AutonProgram, type AutonStep } from '../src/auton/program';

/** Autonomous programs: frames, the runner on physics, PROS code import / export. */

const lm = (x: number, y: number, extra: Partial<Extract<AutonStep, { kind: 'moveToPoint' }>> = {}): AutonStep => ({ kind: 'moveToPoint', x, y, forwards: true, maxSpeed: 127, timeout: 3000, queue: true, async: true, ...extra });
const turn = (theta: number): AutonStep => ({ kind: 'turnToHeading', theta, maxSpeed: 127, timeout: 2000, queue: true, async: true });

/** Start for these tests: against the red wall, facing +x, clear of the Goals on straight runs. */
const X0 = -62.2;
const Y0 = -36;

/** A field without Pins and Cups (Goals, Toggles and Loaders stay), so motions are measured cleanly. */
function scenario(program: AutonProgram, matchType: 'headToHead' | 'skillsAuton' = 'skillsAuton', pieces = false): ScenarioConfig {
  const full = buildLayout(matchType);
  const layout = { ...full, robots: full.robots.map((r) => (r.slot === 'red-1' ? { ...r, pos: { x: X0, y: Y0 }, heading: 0 } : r)) };
  return {
    params: cloneParams(OVERRIDE_DEFAULTS),
    layout: pieces ? layout : { ...layout, pins: layout.pins.filter((p) => p.start.where === 'preload'), cups: [] },
    matchType,
    seed: 1,
    slots: [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'script', robot: cloneRobot(DEFAULT_ROBOT), program }],
  };
}

async function run(program: AutonProgram, until: number, matchType: 'headToHead' | 'skillsAuton' = 'skillsAuton', pieces = false) {
  const built = await buildMatch(scenario(program, matchType, pieces), undefined, undefined, new Map());
  built.sim.runUntil(until);
  return { sim: built.sim, auton: built.autons.get('red-1')!, r: built.sim.robots[0] };
}

describe('Program frames', () => {
  it("LemLib headings: 0° = +y, clockwise; the field's 0 rad = +x, counter-clockwise", () => {
    expect(thetaToHeading(90)).toBeCloseTo(0, 9);
    expect(thetaToHeading(0)).toBeCloseTo(Math.PI / 2, 9);
    expect(headingToTheta(Math.PI)).toBeCloseTo(-90, 9);
    expect(headingToTheta(-Math.PI / 2)).toBeCloseTo(180, 9);
  });

  it('a relative program starts at (0, 0, 0) facing forward; setPose makes it field-centric', () => {
    const start = { pos: { x: X0, y: Y0 }, heading: 0 };
    const rel = previewPath([lm(0, 24)], start);
    expect(rel[1].pos.x).toBeCloseTo(X0 + 24, 6); // 24" straight ahead (+x)
    expect(rel[1].pos.y).toBeCloseTo(-36, 6);
    const abs = previewPath([{ kind: 'setPose', x: X0, y: Y0, theta: 90 }, lm(-30, -12)], start);
    const end = abs[abs.length - 1];
    expect(end.pos.x).toBeCloseTo(-30, 6);
    expect(end.pos.y).toBeCloseTo(-12, 6);
  });

  it('lift motor degrees and holder heights convert both ways through the DR4B', () => {
    for (const h of [0.4, 4, 6.5, 9.4, 15]) expect(liftHeightFromDegrees(DEFAULT_ROBOT, liftMotorDegrees(DEFAULT_ROBOT, h))).toBeCloseTo(h, 6);
    expect(liftMotorDegrees(DEFAULT_ROBOT, DEFAULT_ROBOT.lift.holderMinHeightIn)).toBeCloseTo(0, 6);
  });
});

describe('Running a program on the physics robot', () => {
  it('drives to field points and turns to headings (LemLib, field-centric)', async () => {
    const program: AutonProgram = {
      name: 'square',
      slot: 'red-1',
      mode: 'skills',
      steps: [{ kind: 'setPose', x: X0, y: Y0, theta: 90 }, lm(-36, -36), turn(0), lm(-36, -12), { kind: 'waitUntilDone' }],
    };
    const { auton, r, sim } = await run(program, 12);
    const p = r.body.pose();
    expect(Math.hypot(p.pos.x + 36, p.pos.y + 12)).toBeLessThan(2.5);
    expect(auton.finishedAt).not.toBeNull();
    expect(auton.records.filter((x) => x.timedOut)).toEqual([]);
    expect(Math.abs(wrapAngle(p.heading - Math.PI / 2))).toBeLessThan(0.25); // drove toward +y
    sim.dispose();
  });

  it('a relative program (no setPose) drives from where the robot starts, backwards too', async () => {
    const { r, sim } = await run({ name: 'rel', slot: 'red-1', mode: 'skills', steps: [lm(0, 20), lm(0, 6, { forwards: false })] }, 8);
    const p = r.body.pose();
    expect(Math.hypot(p.pos.x - (X0 + 6), p.pos.y - Y0)).toBeLessThan(2.5);
    expect(Math.abs(wrapAngle(p.heading))).toBeLessThan(0.2); // backed up without turning around
    sim.dispose();
  });

  it('EZ-Template style: relative drive and absolute turns, pid_wait between', async () => {
    const steps: AutonStep[] = [
      { kind: 'drive', inches: 18, maxSpeed: 110, timeout: 4000, queue: false, async: true },
      { kind: 'waitUntilDone' },
      { kind: 'turnToHeading', theta: 90, maxSpeed: 90, timeout: 4000, queue: false, async: true },
      { kind: 'waitUntilDone' },
      { kind: 'drive', inches: 12, maxSpeed: 110, timeout: 4000, queue: false, async: true },
      { kind: 'waitUntilDone' },
    ];
    const { r, sim, auton } = await run({ name: 'ez', slot: 'red-1', mode: 'skills', steps }, 10);
    const p = r.body.pose();
    // 18" ahead (+x), turn right 90° (to −y), 12" more
    expect(Math.hypot(p.pos.x - (X0 + 18), p.pos.y - (Y0 - 12))).toBeLessThan(2.5);
    expect(auton.finishedAt).not.toBeNull();
    sim.dispose();
  });

  it('stops when Autonomous ends in a match', async () => {
    const { r, sim, auton } = await run({ name: 'long', slot: 'red-1', mode: 'match', steps: [{ kind: 'wait', ms: 14500 }, lm(0, 60), lm(0, 0)] }, 16, 'headToHead');
    expect(r.body.cmd).toEqual({ left: 0, right: 0 }); // disabled after Autonomous
    const drive = auton.records.find((x) => x.label.startsWith('Drive'))!;
    expect(drive.tEnd).toBeLessThanOrEqual(15.05); // cut off at 15 s
    expect(auton.records.some((x) => x.index === 2)).toBe(false); // never got to the next motion
    expect(auton.finishedAt).toBeNull();
    sim.dispose();
  });
});

const LEMLIB_SRC = `#include "main.h"
#include "lemlib/api.hpp"

pros::MotorGroup left_mg({-1, -2}, pros::MotorGearset::blue);
pros::MotorGroup right_mg({3, 4}, pros::MotorGearset::blue);
pros::MotorGroup lift({5, -6});
pros::adi::DigitalOut claw('A');
pros::Motor intake(7);
const int LIFT_UP = 300;

/* helper, called from autonomous() */
void scoreFirst() {
  chassis.moveToPoint(-36, -36, 2000);
  lift.move_absolute(LIFT_UP, 100);
  chassis.waitUntilDone();
  claw.set_value(false); // open
}

void autonomous() {
  chassis.setPose(-61, -36, 90);
  scoreFirst();
  pros::delay(250);
  chassis.turnToHeading(0, 1000, {.maxSpeed = 80});
  chassis.moveToPoint(-36, -12, 2000, {.forwards = false}, false);
  for (int i = 0; i < 2; i++) {
    chassis.turnToHeading(90, 800);
    pros::delay(100);
  }
  if (sensor.get_value()) {
    claw.set_value(true);
  }
  intake.move(127);
}

void opcontrol() {
  while (true) { chassis.arcade(0, 0); pros::delay(10); }
}
`;

const EZ_SRC = `const int DRIVE_SPEED = 110;
const int TURN_SPEED = 90;
const int SWING_SPEED = 110;

void drive_example() {
  chassis.pid_drive_set(24_in, DRIVE_SPEED, true);
  chassis.pid_wait();
  chassis.pid_turn_set(90_deg, TURN_SPEED);
  chassis.pid_wait();
  chassis.pid_swing_set(ez::LEFT_SWING, 45_deg, SWING_SPEED, 45);
  chassis.pid_wait();
  chassis.pid_drive_set(-12_in, DRIVE_SPEED);
  chassis.pid_wait_until(6_in);
  clamp.set_value(true);
  chassis.pid_wait();
}
`;

describe('PROS code import', () => {
  it('reads a LemLib routine: helpers, constants, options, async, loops; warns about the rest', async () => {
    const { parseProsAuton } = await import('../src/auton/pros');
    const r = parseProsAuton(LEMLIB_SRC, { robot: DEFAULT_ROBOT });
    expect(r.entry).toBe('autonomous');
    expect(r.dialect).toBe('lemlib');
    expect(r.steps.map((s) => s.kind)).toEqual([
      'setPose',
      'moveToPoint',
      'lift',
      'waitUntilDone',
      'claw',
      'wait',
      'turnToHeading',
      'moveToPoint',
      'turnToHeading',
      'wait',
      'turnToHeading',
      'wait',
    ]);
    const lift = r.steps[2] as Extract<AutonStep, { kind: 'lift' }>;
    expect(liftMotorDegrees(DEFAULT_ROBOT, lift.height)).toBeCloseTo(300, 6);
    expect(r.steps[4]).toEqual({ kind: 'claw', closed: false });
    expect(r.steps[6]).toMatchObject({ theta: 0, maxSpeed: 80, timeout: 1000, async: true });
    expect(r.steps[7]).toMatchObject({ x: -36, y: -12, forwards: false, async: false });
    expect(r.warnings.map((w) => w.line)).toEqual([29, 32]); // the if, and intake (no mechanism)
    expect(r.devices.find((d) => d.name === 'claw')?.role).toBe('claw');
    expect(r.devices.find((d) => d.name === 'lift')?.role).toBe('lift');
    expect(r.functions).toEqual(['scoreFirst', 'autonomous']);
  });

  it('reads an EZ-Template routine (relative drives and turns, units, constants, swings)', async () => {
    const { parseProsAuton } = await import('../src/auton/pros');
    const r = parseProsAuton(EZ_SRC, { robot: DEFAULT_ROBOT, roles: { clamp: 'claw' } });
    expect(r.entry).toBe('drive_example');
    expect(r.dialect).toBe('ez');
    expect(r.steps).toEqual([
      { kind: 'drive', inches: 24, maxSpeed: 110, timeout: 5000, queue: false, async: true },
      { kind: 'waitUntilDone' },
      { kind: 'turnToHeading', theta: 90, maxSpeed: 90, timeout: 5000, queue: false, async: true },
      { kind: 'waitUntilDone' },
      { kind: 'swing', side: 'left', theta: 45, maxSpeed: 110, timeout: 5000, queue: false, async: true },
      { kind: 'waitUntilDone' },
      { kind: 'drive', inches: -12, maxSpeed: 110, timeout: 5000, queue: false, async: true },
      { kind: 'waitUntil', inches: 6 },
      { kind: 'claw', closed: true },
      { kind: 'waitUntilDone' },
    ]);
    expect(r.warnings).toEqual([]);
  });
});

describe('PROS code export', () => {
  const program: AutonProgram = {
    name: 'Score the preload',
    slot: 'red-1',
    mode: 'match',
    steps: [
      { kind: 'setPose', x: X0, y: Y0, theta: 90 },
      lm(-30, -36),
      { kind: 'lift', height: 6.5 },
      turn(0),
      lm(-30, -20, { maxSpeed: 90 }),
      { kind: 'waitUntilDone' },
      { kind: 'claw', closed: false },
      { kind: 'wait', ms: 300 },
      lm(-30, -30, { forwards: false }),
    ],
  };

  it('LemLib code imports back to the same program', async () => {
    const { exportPros, parseProsAuton } = await import('../src/auton/pros');
    for (const full of [false, true]) {
      const code = exportPros(program, { flavor: 'lemlib', full, robot: DEFAULT_ROBOT });
      expect(code).toContain('void autonomous() {');
      if (full) expect(code).toContain('lemlib::Chassis chassis(');
      const back = parseProsAuton(code, { robot: DEFAULT_ROBOT });
      expect(back.warnings).toEqual([]);
      const steps = back.steps.slice(0, program.steps.length);
      expect(steps.map((s) => s.kind)).toEqual(program.steps.map((s) => s.kind));
      const lift = steps[2] as Extract<AutonStep, { kind: 'lift' }>;
      expect(lift.height).toBeCloseTo(6.5, 1);
      expect(steps[4]).toMatchObject({ x: -30, y: -20, maxSpeed: 90 });
      expect(steps[8]).toMatchObject({ forwards: false });
      expect(back.steps[back.steps.length - 1].kind).toBe('waitUntilDone');
    }
  });

  it('EZ-Template code drives the robot to the same place as the LemLib program', async () => {
    const { exportPros, parseProsAuton } = await import('../src/auton/pros');
    const code = exportPros(program, { flavor: 'ez', full: true, robot: DEFAULT_ROBOT });
    expect(code).toContain('ez::Drive chassis(');
    const back = parseProsAuton(code, { robot: DEFAULT_ROBOT });
    expect(back.warnings).toEqual([]);
    expect(back.dialect).toBe('ez');
    const a = await run(program, 12, 'skillsAuton');
    const b = await run({ ...program, steps: back.steps }, 12, 'skillsAuton');
    const pa = a.r.body.pose().pos;
    const pb = b.r.body.pose().pos;
    expect(Math.hypot(pa.x + 30, pa.y + 30)).toBeLessThan(2.5);
    expect(Math.hypot(pb.x + 30, pb.y + 30)).toBeLessThan(3);
    a.sim.dispose();
    b.sim.dispose();
  });
});

describe('Scoring with an imported program', () => {
  it('places the preloaded Pin on the red Alliance Goal in Autonomous', async () => {
    const { parseProsAuton } = await import('../src/auton/pros');
    const { buildGoals } = await import('../src/field/geometry');
    const g = buildGoals().find((x) => x.id === 'G-R1a')!;
    const ahead = DEFAULT_ROBOT.intake.holderOffsetIn;
    const src = `void autonomous() {
      chassis.setPose(${X0}, ${Y0}, 90);
      chassis.moveToPoint(${g.pos.x}, -40, 2000);
      chassis.turnToHeading(0, 1000);
      lift.move_absolute(${Math.round(liftMotorDegrees(DEFAULT_ROBOT, g.height + 1.5))}, 100);
      chassis.moveToPoint(${g.pos.x}, ${g.pos.y - ahead}, 2000, {.maxSpeed = 50});
      chassis.waitUntilDone();
      pros::delay(300);
      claw.set_value(false);
      pros::delay(500);
      chassis.moveToPoint(${g.pos.x}, -36, 1500, {.forwards = false});
    }`;
    const parsed = parseProsAuton(src, { robot: DEFAULT_ROBOT });
    expect(parsed.warnings).toEqual([]);
    const { sim, auton } = await run({ name: 'score', slot: 'red-1', mode: 'match', steps: parsed.steps }, 15, 'headToHead');
    expect(auton.finishedAt).not.toBeNull();
    expect(sim.objects.stacks.get('G-R1a')!.elements.length).toBe(1);
    expect(sim.liveScore().totals.red).toBeGreaterThan(0);
    sim.dispose();
  });
});

describe('Plan mode routes', () => {
  it('go around Pins and Cups on the tiles instead of through them', async () => {
    const { routeVia } = await import('../src/auton/plan');
    const { distToSegment } = await import('../src/core/vec');
    const from = { x: -58, y: 0 };
    const to = { x: -20, y: 0 };
    const piece = { pos: { x: -39, y: -1 }, r: 1.58 };
    expect(routeVia(from, to, DEFAULT_ROBOT, { alliance: 'red', ownSideOnly: false })).toEqual([]); // nothing else in the way
    const via = routeVia(from, to, DEFAULT_ROBOT, { alliance: 'red', ownSideOnly: false, pieces: [piece] });
    expect(via.length).toBeGreaterThan(0);
    const pts = [from, ...via, to];
    let closest = Infinity;
    for (let i = 1; i < pts.length; i++) closest = Math.min(closest, distToSegment(piece.pos, pts[i - 1], pts[i]));
    expect(closest).toBeGreaterThan(DEFAULT_ROBOT.chassis.widthIn / 2); // the robot's side clears it
  });
});

describe('Plan mode sequences', () => {
  it('a click on a Goal scores the preload; a click on a Pin picks it up and the next Goal takes it', async () => {
    const { newProgram, placeSteps, pickSteps } = await import('../src/auton/plan');
    const { simulateProgram } = await import('../src/auton/simulate');
    const { buildGoals } = await import('../src/field/geometry');
    // the preload and one standing Pin
    const full = buildLayout('headToHead');
    const loose = { id: 'P99-YY', kind: 'pin' as const, type: 'YY' as const, start: { where: 'field' as const, pos: { x: -36, y: -8 }, upColor: 'yellow' as const } };
    const layout = { ...full, pins: [...full.pins.filter((p) => p.start.where === 'preload'), loose], cups: [] };
    const start = layout.robots.find((r) => r.slot === 'red-1')!;
    const goals = buildGoals();
    let program = newProgram('two pieces', 'red-1', 'match', start);
    const route = { alliance: 'red' as const, ownSideOnly: true };
    const at = () => {
      const pv = previewPath(program.steps, start);
      return pv[pv.length - 1];
    };
    // 1: the preload onto the red Alliance Goal
    let here = at();
    program = { ...program, steps: [...program.steps, ...placeSteps(here.frame, here.pos, goals.find((g) => g.id === 'G-R1a')!, DEFAULT_ROBOT, route)] };
    // 2: a standing field Pin off that route, onto the red neutral Goal (both routes go around the Alliance Goal)
    here = at();
    const pin = { x: -36, y: -8 };
    expect(layout.pins.some((p) => p.start.where === 'field' && Math.hypot(p.start.pos.x - pin.x, p.start.pos.y - pin.y) < 0.01)).toBe(true);
    program = { ...program, steps: [...program.steps, ...pickSteps(here.frame, here.pos, pin, DEFAULT_ROBOT, route)] };
    here = at();
    program = { ...program, steps: [...program.steps, ...placeSteps(here.frame, here.pos, goals.find((g) => g.id === 'G-R1n')!, DEFAULT_ROBOT, route)] };
    const sc: ScenarioConfig = { params: cloneParams(OVERRIDE_DEFAULTS), layout, matchType: 'headToHead', seed: 1, slots: [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'script', robot: cloneRobot(DEFAULT_ROBOT), program }] };
    const res = await simulateProgram(sc, program);
    expect(res.records.filter((r) => r.timedOut)).toEqual([]);
    const seats = res.events.filter((e) => /nests on/.test(e.text));
    expect(seats.map((e) => e.text.split(' nests on ')[1])).toEqual(['G-R1a', 'G-R1n']);
    expect(res.score.red).toBeGreaterThan(0);
    expect(res.violations).toEqual([]);
  });
});
