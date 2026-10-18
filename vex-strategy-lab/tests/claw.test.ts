import { describe, expect, it } from 'vitest';
import { IN } from '../src/core/units';
import { buildGoals, CUP, nestOffset, PIN, stackCenter } from '../src/field/geometry';
import { buildLayout, type FieldLayout } from '../src/field/layout';
import { ObjectManager, tiltDeg } from '../src/physics/objects';
import { DEFAULT_ROBOT } from '../src/robot/config';
import { OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { DriverController, zeroInput, type DriverInput } from '../src/sim/driver';
import { MatchSim } from '../src/sim/match';

/**
 * The roller claw and real piece physics: held pieces are part of the claw (rigid,
 * colliding), rollers pull pieces in and push them out, drops fall and nest by
 * themselves, and a claw can carry a nested stack.
 */

const skills = buildLayout('skillsDriver');
const empty: FieldLayout = { ...skills, pins: [], cups: [] };
const H = DEFAULT_ROBOT.intake.holderOffsetIn;
const floor = DEFAULT_ROBOT.lift.holderMinHeightIn;

async function driven(inp: DriverInput, start: { pos: { x: number; y: number }; heading: number }, opts: { practice?: boolean; layout?: FieldLayout } = {}) {
  return MatchSim.create({
    params: OVERRIDE_DEFAULTS,
    layout: opts.layout ?? (opts.practice === false ? { ...buildLayout('headToHead'), pins: [], cups: [] } : empty),
    robots: [{ id: 'red-1', alliance: 'red', config: DEFAULT_ROBOT, controller: new DriverController(() => inp), start }],
    seed: 1,
    practice: opts.practice ?? true,
  });
}

const pinAt = (sim: MatchSim, id: string, x: number, y: number, z = 0) => sim.objects.add({ id, kind: 'pin', colors: ['red', 'yellow'] }, { x, y, z, flipped: false });
const cupAt = (sim: MatchSim, id: string, x: number, y: number, z = 0) => sim.objects.add({ id, kind: 'cup' }, { x, y, z, flipped: false });
const pos = (o: { body: { translation(): { x: number; y: number; z: number } } | null }) => {
  const t = o.body!.translation();
  return { x: t.x / IN, y: -t.z / IN, z: t.y / IN };
};

/** Hold intake until something is gripped (or time runs out). */
function intakeUntilHeld(sim: MatchSim, inp: DriverInput, maxT = 1.5) {
  const r = sim.robots[0];
  inp.intake = true;
  const t0 = sim.t;
  while (!r.held.length && sim.t < t0 + maxT) sim.step();
  sim.runUntil(sim.t + 0.3); // rollers seat it
  inp.intake = false;
}

describe('Roller claw', () => {
  it('pulls a Pin at the jaws in with the rollers — it moves there, it does not jump', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const pin = pinAt(sim, 'P', -40 + H + 2.4, 0);
    sim.runUntil(0.5);
    expect(r.held).toEqual([]);
    let last = pos(pin);
    let maxStep = 0;
    inp.intake = true;
    const t0 = sim.t;
    while (!r.held.length && sim.t < t0 + 1) {
      sim.step();
      const p = pos(pin);
      maxStep = Math.max(maxStep, Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z));
      last = p;
    }
    expect(r.held.map((o) => o.id)).toEqual(['P']);
    expect(sim.t - t0).toBeGreaterThan(0.05); // it took the rollers a moment
    for (let i = 0; i < 60; i++) {
      sim.step();
      const p = pos(pin);
      maxStep = Math.max(maxStep, Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z));
      last = p;
    }
    expect(maxStep).toBeLessThan(0.4); // never more than the rollers' surface speed allows in one step
    expect(tiltDeg(pin)).toBeLessThan(3);
    expect(r.clawClosed).toBe(true); // intake closed the claw
    sim.dispose();
  });

  it('runs the rollers out to push the held piece out the front', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const pin = pinAt(sim, 'P', -40 + H + 1.5, 0);
    sim.runUntil(0.3);
    intakeUntilHeld(sim, inp);
    expect(r.held.length).toBe(1);
    const before = pos(pin).x;
    inp.outtake = true;
    sim.runUntil(sim.t + 0.4);
    inp.outtake = false;
    sim.runUntil(sim.t + 0.6);
    expect(r.held).toEqual([]);
    expect(pin.mode).toBe('free');
    expect(pos(pin).x - before).toBeGreaterThan(2); // out in front of the robot
    sim.dispose();
  });
});

describe('Claw toggle and easy claw', () => {
  it('the claw is a toggle: on, it pulls in a Pin that reaches its jaws (no key held); off, it drops it', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    pinAt(sim, 'P', -40 + H + 8, 0);
    sim.runUntil(0.5);
    inp.claw = !inp.claw; // on
    sim.runUntil(1.0);
    expect(r.clawClosed).toBe(true);
    expect(r.held).toEqual([]);
    inp.forward = 0.25; // drive up to it
    const t0 = sim.t;
    while (!r.held.length && sim.t < t0 + 3) sim.step();
    inp.forward = 0;
    expect(r.held.map((o) => o.id)).toEqual(['P']);
    sim.runUntil(sim.t + 0.5);
    inp.claw = !inp.claw; // off: it drops
    sim.runUntil(sim.t + 0.5);
    expect(r.held).toEqual([]);
    expect(r.clawClosed).toBe(false);
    sim.dispose();
  });

  it('easy claw picks a Pin lying on the ground up and stands it up (along or across); the normal claw leaves it', async () => {
    for (const [easy, lie] of [
      [true, 0],
      [true, Math.PI / 2],
      [false, 0],
    ] as const) {
      const inp = { ...zeroInput(), easy };
      const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
      const r = sim.robots[0];
      const pin = sim.objects.add({ id: 'P', kind: 'pin', colors: ['red', 'yellow'] }, { x: -40 + H + 7, y: 0, z: 0, flipped: false, lie });
      sim.runUntil(0.5);
      expect(tiltDeg(pin)).toBeGreaterThan(80);
      if (!easy) inp.claw = !inp.claw; // the normal claw, on
      inp.forward = 0.25;
      sim.runUntil(3);
      inp.forward = 0;
      sim.runUntil(3.8);
      expect(r.held.map((o) => o.id), `easy ${easy} lie ${lie}`).toEqual(easy ? ['P'] : []);
      if (easy) expect(tiltDeg(pin)).toBeLessThan(2); // stood up in the claw
      sim.dispose();
    }
  });
});

describe('Held pieces are part of the claw', () => {
  it('a held Pin does not wobble when the robot brakes hard (with momentum)', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -55, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const pin = pinAt(sim, 'P', -55 + H + 1.5, 0);
    sim.runUntil(0.3);
    intakeUntilHeld(sim, inp);
    inp.preset = 4;
    inp.forward = 1;
    sim.runUntil(sim.t + 1.2); // full speed
    inp.forward = -1; // slam it into reverse
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      sim.step();
      // where the Pin is vs where the claw holds it
      const f = r.body.carriageFrame();
      const want = ObjectManager.toWorldPose(f, pin.hold!.target.p, pin.hold!.target.q).p;
      const t = pin.body!.translation();
      worst = Math.max(worst, Math.hypot(t.x - want.x, t.y - want.y, t.z - want.z) / IN);
    }
    expect(worst).toBeLessThan(0.01);
    sim.dispose();
  });

  it('a held Pin collides with loose pieces: driven into a standing Cup, it pushes it', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    pinAt(sim, 'P', -40 + H + 1.5, 0);
    sim.runUntil(0.3);
    intakeUntilHeld(sim, inp);
    expect(r.held.length).toBe(1);
    // a Cup ahead, slightly off the robot's line so it is clear of the bumpers but in the held Pin's path
    const cup = cupAt(sim, 'C', -40 + H + 9, 0.8);
    sim.runUntil(sim.t + 0.5);
    const c0 = pos(cup);
    inp.forward = 0.3;
    sim.runUntil(sim.t + 1.6);
    inp.forward = 0;
    sim.runUntil(sim.t + 0.5);
    const c1 = pos(cup);
    expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeGreaterThan(2); // shoved, not passed through
    sim.dispose();
  });
});

describe('Drops are physical', () => {
  it('a Pin dropped from high over a Goal falls into its socket and stacks', async () => {
    const g = buildGoals().find((x) => x.id === 'G-R1n')!;
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: g.pos.x - H, y: g.pos.y }, heading: 0 });
    const pin = sim.objects.add({ id: 'P', kind: 'pin', colors: ['red', 'yellow'] }, { x: g.pos.x + 0.2, y: g.pos.y, z: g.height + 10, flipped: false });
    let seatedAt = -1;
    while (sim.t < 2) {
      sim.step();
      if (pin.mode === 'stacked' && seatedAt < 0) seatedAt = sim.t;
    }
    expect(pin.mode).toBe('stacked');
    expect(seatedAt).toBeGreaterThan(0.2); // it fell first (10" takes ≈ 0.23 s)
    expect(Math.abs(pos(pin).z - stackCenter(g.height, 0))).toBeLessThan(0.1); // band on the rim
    sim.dispose();
  });

  it('a drop 1" off a Goal socket lands on the rim and does not stack', async () => {
    const g = buildGoals().find((x) => x.id === 'G-R1n')!;
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: g.pos.x - H - 14, y: g.pos.y }, heading: 0 });
    const pin = sim.objects.add({ id: 'P', kind: 'pin', colors: ['red', 'yellow'] }, { x: g.pos.x + 1.0, y: g.pos.y, z: g.height + 3, flipped: false });
    sim.runUntil(2.5);
    expect(pin.mode).toBe('free');
    sim.dispose();
  });

  it('a Pin dropped from high into a standing Cup nests in it; a Cup dropped over a standing Pin nests on it', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -60, y: -30 }, heading: 0 });
    const pin = pinAt(sim, 'P1', -20, 0);
    const cup = cupAt(sim, 'C2', 10, 0);
    sim.runUntil(0.3);
    // (a Pin stands on its 1.4" tip: a Cup dropped on it from a foot up knocks the pair over)
    const cupTop = cupAt(sim, 'C1', -20.1, 0.05, PIN.half + nestOffset() - CUP.half + 4);
    const pinTop = pinAt(sim, 'P2', 10.25, -0.1, CUP.length + 14);
    sim.runUntil(3);
    for (const [base, top] of [
      [pin, cupTop],
      [cup, pinTop],
    ]) {
      const a = pos(base);
      const b = pos(top);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.3);
      expect(Math.abs(b.z - a.z - nestOffset())).toBeLessThan(0.15); // resting nested, not on the rim
      expect(tiltDeg(top)).toBeLessThan(5);
      expect(top.bonds.some((bd) => bd.other === base)).toBe(true); // held together as one piece
    }
    sim.dispose();
  });
});

describe('Carrying a nested stack', () => {
  /** A Pin in a Cup on a Pin in a Cup: 2 Cups + 2 Pins standing on the tiles. */
  function fourStack(sim: MatchSim, x: number) {
    const n = nestOffset();
    const c0 = cupAt(sim, 'C1', x, 0);
    const p0 = pinAt(sim, 'P1', x, 0, CUP.half + n - PIN.half + 0.02);
    const c1 = cupAt(sim, 'C2', x, 0, CUP.half + 2 * n - CUP.half + 0.04);
    const p1 = pinAt(sim, 'P2', x, 0, CUP.half + 3 * n - PIN.half + 0.06);
    return [c0, p0, c1, p1];
  }

  it('picks up 2 Cups + 2 Pins at once (gripping the bottom Cup) and drops them together', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const stack = fourStack(sim, -40 + H + 1.5);
    sim.runUntil(1.0);
    intakeUntilHeld(sim, inp);
    expect(r.held.map((o) => o.id)).toEqual(stack.map((o) => o.id));
    inp.preset = 3;
    sim.runUntil(sim.t + 1.0);
    // all four up off the tiles with the claw, still nested
    for (let i = 0; i < 4; i++) expect(pos(stack[i]).z).toBeGreaterThan(stack[i].kind === 'pin' ? PIN.half + 1 : CUP.half + 1);
    for (let i = 1; i < 4; i++) expect(pos(stack[i]).z - pos(stack[i - 1]).z).toBeCloseTo(nestOffset(), 1);
    inp.preset = floor;
    sim.runUntil(sim.t + 1.0);
    inp.drop++;
    sim.runUntil(sim.t + 1.5);
    expect(r.held).toEqual([]);
    for (const o of stack) expect(o.mode).toBe('free');
    sim.dispose();
  });

  it('builds a stack in the claw: lowered onto a standing piece, intake takes it in underneath', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const cup = cupAt(sim, 'C1', -40 + H + 1.5, 0);
    sim.runUntil(0.5);
    intakeUntilHeld(sim, inp);
    expect(r.held.map((o) => o.id)).toEqual(['C1']);
    // lift, set a Pin standing in front, then lower the held Cup over it
    inp.preset = 5;
    sim.runUntil(sim.t + 1.2);
    const pin = pinAt(sim, 'P1', pos(cup).x, pos(cup).y);
    sim.runUntil(sim.t + 0.3);
    inp.preset = PIN.half + nestOffset() - CUP.half - 0.05 + 0.15; // the Cup's lower half just over the Pin's top
    sim.runUntil(sim.t + 1.0);
    intakeUntilHeld(sim, inp, 0.3);
    inp.intake = true;
    sim.runUntil(sim.t + 0.5);
    inp.intake = false;
    expect(r.held.map((o) => o.id)).toEqual([pin.id, cup.id]); // the Pin taken in at the bottom
    sim.dispose();
  });

  it('holding 2 Cups + 2 Pins breaks the possession limit in a match, not in Practice', async () => {
    for (const practice of [true, false]) {
      const inp = zeroInput();
      const sim = await driven(inp, { pos: { x: -40, y: -36 }, heading: 0 }, { practice });
      if (!practice) sim.runUntil(sim.clock.autonomousEnd! + 0.1); // a driver drives from Driver Control on
      cupAt(sim, 'C1', -40 + H + 1.5, -36);
      const n = nestOffset();
      pinAt(sim, 'P1', -40 + H + 1.5, -36, CUP.half + n - PIN.half + 0.02);
      cupAt(sim, 'C2', -40 + H + 1.5, -36, CUP.half + 2 * n - CUP.half + 0.04);
      pinAt(sim, 'P2', -40 + H + 1.5, -36, CUP.half + 3 * n - PIN.half + 0.06);
      sim.runUntil(sim.t + 1.0);
      intakeUntilHeld(sim, inp);
      expect(sim.robots[0].held.length).toBe(4);
      expect(sim.violations.some((v) => v.ruleId === 'SG (possession)')).toBe(!practice);
      sim.dispose();
    }
  });
});
