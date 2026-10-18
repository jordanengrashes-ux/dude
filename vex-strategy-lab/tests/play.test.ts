import { describe, expect, it } from 'vitest';
import { IN, wrapAngle } from '../src/core/units';
import { buildGoals, CUP, PIN } from '../src/field/geometry';
import { buildLayout, type FieldLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { arcade, DriverController, zeroInput, type DriverInput } from '../src/sim/driver';
import { MatchSim } from '../src/sim/match';
import { buildMatch } from '../src/sim/scenario';
import { SimRunner } from '../src/ui/simRunner';
import { store } from '../src/ui/store';

/** Playing the robot yourself: turning while driving, easy claw, practice, claw state and aligner, element shapes. */

const skills = buildLayout('skillsDriver');
const empty: FieldLayout = { ...skills, pins: [], cups: [] };
/** Only red-1's preloaded Pin. */
const preloadOnly: FieldLayout = { ...skills, pins: skills.pins.filter((p) => p.start.where === 'preload' || p.start.where === 'held'), cups: [] };

/**
 * Like a driver placing a piece: raise the arm above the Goal first, then creep
 * forward until the claw is over the Goal's axis (along the robot's heading).
 */
function creepTo(sim: MatchSim, inp: DriverInput, goalX: number, height: number, slow = false) {
  const r = sim.robots[0];
  inp.preset = height;
  sim.runUntil(sim.t + 1.5);
  // on the floor, slower: an overshoot pushes the piece over with the carriage
  const [maxF, gain, tol] = slow ? [0.12, 0.05, 0.4] : [0.3, 0.08, 0.25];
  for (let i = 0; i < 200; i++) {
    const p = r.body.pose();
    const holderX = p.pos.x + Math.cos(p.heading) * DEFAULT_ROBOT.intake.holderOffsetIn;
    const err = goalX - holderX;
    if (Math.abs(err) < tol && Math.abs(r.body.telemetry.speed) < 1) break;
    inp.forward = Math.max(-maxF, Math.min(maxF, err * gain));
    sim.runUntil(sim.t + 0.05);
  }
  inp.forward = 0;
  sim.runUntil(sim.t + 0.3);
}

async function driven(inp: DriverInput, start: { pos: { x: number; y: number }; heading: number }, layout: FieldLayout = empty) {
  return MatchSim.create({ params: OVERRIDE_DEFAULTS, layout, robots: [{ id: 'red-1', alliance: 'red', config: DEFAULT_ROBOT, controller: new DriverController(() => inp), start }], seed: 1 });
}

describe('Driving', () => {
  it('arcade mixing keeps the turn when driving at full speed', () => {
    const full = arcade(1, 1);
    expect(full.right).toBeCloseTo(1, 6);
    expect(full.left).toBeLessThan(0.05);
    expect(arcade(0, 1).right).toBeGreaterThan(0.5); // turns in place
    expect(arcade(1, 0)).toEqual({ left: 1, right: 1 });
  });

  it('turns while driving forward (W + A)', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -55, y: -10 }, heading: 0 });
    const r = sim.robots[0];
    inp.forward = 1;
    sim.runUntil(0.8); // full speed
    inp.turn = 1;
    sim.runUntil(1.0);
    const a = r.body.pose();
    sim.runUntil(1.4);
    const b = r.body.pose();
    const yaw = (wrapAngle(b.heading - a.heading) / 0.4) * (180 / Math.PI);
    const speed = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) / 0.4;
    expect(yaw).toBeGreaterThan(50);
    expect(speed).toBeGreaterThan(15);
    sim.dispose();
  });
});

describe('Pin into a loose Cup', () => {
  it('the aligner leads the held Pin over a Cup on the tiles; dropped in, the pair locks together', async () => {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 }, preloadOnly);
    const r = sim.robots[0];
    const cupX = -40 + DEFAULT_ROBOT.intake.holderOffsetIn + 6;
    const cup = sim.objects.add({ id: 'C-test', kind: 'cup' }, { x: cupX, y: 0, z: 0, flipped: true }); // clear half up
    sim.runUntil(0.3);
    expect(sim.alignHint(r)).toMatchObject({ goal: cup.id, state: 0 }); // near, not lined up
    expect(sim.alignHint(r)!.at!.x).toBeCloseTo(cupX, 0);
    creepTo(sim, inp, cupX, CUP.length + 0.6);
    const a = sim.alignHint(r)!;
    expect(a.goal).toBe(cup.id);
    expect(a.state).toBe(2); // lined up and high enough: green
    const pin = r.primary!;
    inp.drop++; // open the claw
    sim.runUntil(sim.t + 1.5);
    expect(pin.mode).toBe('free');
    const dy = (pin.body!.translation().y - cup.body!.translation().y) / IN;
    expect(pin.bonds[0]?.other, `dy ${dy.toFixed(2)} pin v ${JSON.stringify(pin.body!.linvel())} up ${JSON.stringify(pin.body!.rotation())}`).toBe(cup); // resting in the Cup, held to it
    expect(pin.body!.translation().y / IN).toBeGreaterThan(CUP.length);
    sim.dispose();
  });
});

describe('Easy claw', () => {
  it('grabs a Pin the robot drives into, and does not grab it back right after dropping it', async () => {
    const inp = { ...zeroInput(), easy: true };
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 });
    const r = sim.robots[0];
    const pin = sim.objects.add({ id: 'P-test', kind: 'pin', colors: ['red', 'yellow'] }, { x: -40 + DEFAULT_ROBOT.intake.holderOffsetIn + 9, y: 0, z: 0, flipped: false });
    inp.forward = 0.35;
    sim.runUntil(2.5);
    expect([r.primary?.id, r.secondary?.id]).toContain(pin.id);
    inp.forward = 0;
    inp.drop++; // open the claw
    sim.runUntil(3.4);
    expect(pin.mode).toBe('free');
    sim.dispose();
  });

  it('never takes a scored piece off a Goal (closing the claw on purpose does)', async () => {
    const g = buildGoals().find((x) => x.id === 'G-R1a')!;
    for (const purposeful of [false, true]) {
      const inp = { ...zeroInput(), easy: true };
      const sim = await driven(inp, { pos: { x: g.pos.x - DEFAULT_ROBOT.intake.holderOffsetIn, y: g.pos.y }, heading: 0 });
      const pin = sim.objects.add({ id: 'P-scored', kind: 'pin', colors: ['red', 'yellow'] });
      sim.objects.preplace(pin, g.id, false);
      sim.runUntil(0.5);
      if (purposeful) inp.claw = true;
      sim.runUntil(1.5);
      expect(sim.objects.stacks.get(g.id)!.elements.length).toBe(purposeful ? 0 : 1);
      sim.dispose();
    }
  });

  it("Goals catch an easy-mode drop 2\" off center; a normal drop there misses", async () => {
    const g = buildGoals().find((x) => x.id === 'G-R1n')!;
    for (const easy of [true, false]) {
      const inp = { ...zeroInput(), easy };
      const sim = await driven(inp, { pos: { x: g.pos.x - DEFAULT_ROBOT.intake.holderOffsetIn - 12, y: g.pos.y + 2 }, heading: 0 }, preloadOnly);
      const r = sim.robots[0];
      creepTo(sim, inp, g.pos.x, g.height + 1.5);
      const held = r.primary!.body!.translation();
      const off = Math.hypot(held.x / IN - g.pos.x, -held.z / IN - g.pos.y);
      expect(off).toBeGreaterThan(1.3); // further off than a normal Goal catches
      expect(off).toBeLessThan(2.4);
      inp.drop++;
      sim.runUntil(sim.t + 1.5);
      expect(sim.objects.stacks.get(g.id)!.elements.length).toBe(easy ? 1 : 0);
      sim.dispose();
    }
  });
});

describe('Claw state and aligner', () => {
  it('frames carry the claw, what is held and the aligner; the wire protocol keeps them', async () => {
    const g = buildGoals().find((x) => x.id === 'G-R1n')!;
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: g.pos.x - DEFAULT_ROBOT.intake.holderOffsetIn - 5, y: g.pos.y }, heading: 0 }, preloadOnly);
    sim.runUntil(0.5);
    let fr = sim.sceneFrame().robots[0];
    expect(fr.holding).toBe(1); // the preloaded Pin
    expect(fr.claw).toBe(true); // closed on it
    expect(fr.align).toMatchObject({ goal: g.id, state: 0 }); // near, not over it
    creepTo(sim, inp, g.pos.x, g.height + 1.5);
    fr = sim.sceneFrame().robots[0];
    expect(fr.claw).toBe(true);
    expect(fr.align?.state).toBe(2); // over it and high enough: open the claw
    const { decodeSnap, encodeSnap, setupFrom } = await import('../src/net/protocol');
    const { hudData } = await import('../src/sim/frame');
    const frame = sim.sceneFrame();
    expect(frame.robots[0].rollers).toBe(0); // gripping the Pin: the rollers stall
    const setup = setupFrom(frame, 'host', 'skillsDriver', OVERRIDE_DEFAULTS, preloadOnly);
    const d = decodeSnap(encodeSnap(frame, hudData(sim), 0, true, new Map(), false), setup, null, new Map());
    expect(d.robots[0]).toMatchObject({ claw: true, holding: 1, rollers: 0, align: { goal: g.id, state: 2 } });
    for (const rollers of [1, -1]) {
      const spun = { ...frame, robots: frame.robots.map((x) => ({ ...x, rollers })) };
      expect(decodeSnap(encodeSnap(spun, hudData(sim), 0, true, new Map(), false), setup, null, new Map()).robots[0].rollers).toBe(rollers);
    }
    // the aligner's zone and the held piece's dot travel too
    const a = frame.robots[0].align!;
    expect(a.tol).toBeCloseTo(sim.objects.funnel.socket, 2); // an empty Goal: the socket's funnel
    expect(d.robots[0].align!.tol).toBeCloseTo(a.tol!, 2);
    expect(d.robots[0].align!.from!.x).toBeCloseTo(a.from!.x, 1);
    expect(d.robots[0].align!.from!.y).toBeCloseTo(a.from!.y, 1);
    sim.dispose();
  });
});

describe('Claw: one piece, between the jaws, standing Pins', () => {
  const floor = DEFAULT_ROBOT.lift.holderMinHeightIn;
  const ahead = -40 + DEFAULT_ROBOT.intake.holderOffsetIn + 6;
  const held = (sim: MatchSim) => [sim.robots[0].primary?.id, sim.robots[0].secondary?.id].filter(Boolean);
  /** Drive up to a piece at (ahead, lat) and click the claw closed. */
  async function closeOn(place: (sim: MatchSim) => void, lat = 0) {
    const inp = zeroInput();
    const sim = await driven(inp, { pos: { x: -40, y: -lat }, heading: 0 });
    place(sim);
    sim.runUntil(1.0);
    creepTo(sim, inp, ahead, floor, true);
    inp.claw = !inp.claw;
    sim.runUntil(sim.t + 1.0);
    return { sim, inp };
  }
  const pin = (sim: MatchSim, id = 'P', z = 0) => sim.objects.add({ id, kind: 'pin', colors: ['red', 'yellow'] }, { x: ahead, y: 0, z, flipped: false });

  it('grabs a standing Pin between its jaws, not one 1.4" to the side, not one lying down', async () => {
    let { sim } = await closeOn((s) => pin(s));
    expect(held(sim)).toEqual(['P']);
    sim.dispose();
    ({ sim } = await closeOn((s) => pin(s), 1.4)); // the robot is 1.4" off the Pin's line (it still fits the 6" slot)
    expect(held(sim)).toEqual([]);
    expect(sim.objects.objects.get('P')!.body!.translation().y / IN).toBeGreaterThan(PIN.half - 0.3); // still standing beside the jaws (the old wide grab took it)
    sim.dispose();
    ({ sim } = await closeOn((s) => pin(s, 'P', 2).body!.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, true))); // lying on its side
    expect(held(sim)).toEqual([]);
    sim.dispose();
  });

  it('a Pin standing in a Cup comes along with it, and both drop together', async () => {
    const { sim, inp } = await closeOn((s) => {
      s.objects.add({ id: 'C', kind: 'cup' }, { x: ahead, y: 0, z: 0, flipped: false });
      pin(s, 'P', 7.5); // falls into the Cup
    });
    expect(held(sim).sort()).toEqual(['C', 'P']);
    const r = sim.robots[0];
    expect(r.primary!.id).toBe('C'); // the claw grips the Cup; the Pin rides in it
    inp.claw = !inp.claw; // open
    sim.runUntil(sim.t + 1.0);
    expect(held(sim)).toEqual([]);
    expect(sim.objects.objects.get('P')!.mode).toBe('free');
    sim.dispose();
  });

  it('holds one piece: holding a Pin, driving into a Cup in easy mode does not take it', async () => {
    const inp = { ...zeroInput(), easy: true };
    const sim = await driven(inp, { pos: { x: -40, y: 0 }, heading: 0 }, preloadOnly);
    const r = sim.robots[0];
    sim.objects.add({ id: 'C', kind: 'cup' }, { x: -40 + DEFAULT_ROBOT.intake.holderOffsetIn + 9, y: 0, z: 0, flipped: false });
    sim.runUntil(0.5);
    expect(held(sim).length).toBe(1);
    inp.forward = 0.35;
    sim.runUntil(2.5);
    expect(held(sim).length).toBe(1);
    expect(r.secondary).toBeNull();
    expect(sim.objects.objects.get('C')!.mode).toBe('free');
    sim.dispose();
  });
});

describe('No momentum', () => {
  it('same top speed and turning as normal driving, but it stops the moment you let go', async () => {
    const coast: number[] = [];
    const top: number[] = [];
    const yaw: number[] = [];
    for (const noMomentum of [false, true]) {
      const inp = { ...zeroInput(), noMomentum };
      const sim = await driven(inp, { pos: { x: -55, y: -10 }, heading: 0 });
      const r = sim.robots[0];
      inp.forward = 1;
      sim.runUntil(0.8);
      top.push(r.body.telemetry.speed);
      inp.forward = 0;
      const a = r.body.pose().pos.x;
      sim.runUntil(1.6);
      coast.push(r.body.pose().pos.x - a);
      sim.dispose();
      // turning in place from rest
      const inp2 = { ...zeroInput(), noMomentum, turn: 1 };
      const sim2 = await driven(inp2, { pos: { x: -40, y: -36 }, heading: 0 });
      sim2.runUntil(0.8);
      yaw.push(sim2.robots[0].body.chassis.angvel().y);
      sim2.dispose();
    }
    expect(top[1]).toBeCloseTo(top[0], 0);
    expect(yaw[1]).toBeCloseTo(yaw[0], 1);
    expect(coast[1]).toBeLessThan(0.3);
    expect(coast[0]).toBeGreaterThan(5);
  });
});

describe('Practice', () => {
  it('has no time limit: the clock counts up and the match never ends', async () => {
    const sc = new SimRunner().scenarioFrom({ ...store.get(), practice: true });
    const inp = zeroInput();
    const built = await buildMatch({ ...sc, params: cloneParams(OVERRIDE_DEFAULTS), layout: empty }, () => inp, undefined, new Map());
    const sim = built.sim;
    expect(sim.clock.total).toBe(Infinity);
    sim.runUntil(130); // past a whole match
    const { hudData } = await import('../src/sim/frame');
    expect(hudData(sim).clock).toBe('2:10');
    const r = sim.robots[0];
    const p0 = r.body.pose().pos;
    inp.forward = 1;
    sim.runUntil(131);
    expect(Math.hypot(r.body.pose().pos.x - p0.x, r.body.pose().pos.y - p0.y)).toBeGreaterThan(10); // still driving
    sim.dispose();
  });

  it('only your robot, driven by you from the first second, without rule checks', async () => {
    const sc = new SimRunner().scenarioFrom({ ...store.get(), practice: true });
    expect(sc.slots.map((s) => [s.slot, s.strategy])).toEqual([['red-1', 'manual']]);
    const inp = zeroInput();
    const built = await buildMatch({ ...sc, params: cloneParams(OVERRIDE_DEFAULTS) }, () => inp, undefined, new Map());
    const sim = built.sim;
    expect(sim.robots.length).toBe(1);
    const r = sim.robots[0];
    const p0 = r.body.pose().pos;
    inp.forward = 1;
    sim.runUntil(1.5); // still the Autonomous window of a match clock
    expect(Math.hypot(r.body.pose().pos.x - p0.x, r.body.pose().pos.y - p0.y)).toBeGreaterThan(20);
    sim.runUntil(6);
    expect(sim.violations.length).toBe(0);
    sim.dispose();
  });
});

describe('Pin and Cup shapes', () => {
  it('rest on their real geometry, a Pin nests in a loose Cup, and the field settles', async () => {
    const sim = await driven(zeroInput(), { pos: { x: 0, y: -40 }, heading: 0 });
    const om = sim.objects;
    const add = (id: string, kind: 'pin' | 'cup', x: number, z: number, lying = false) => {
      const o = om.add({ id, kind, colors: kind === 'pin' ? ['red', 'yellow'] : undefined }, { x, y: 30, z, flipped: false });
      if (lying) o.body!.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, true);
      return o;
    };
    const h = (o: ReturnType<typeof add>) => o.body!.translation().y / IN;
    const pinUp = add('pinUp', 'pin', 0, 0.3);
    const pinSide = add('pinSide', 'pin', 10, 2, true);
    const cupSide = add('cupSide', 'cup', 30, 2, true);
    const host = add('host', 'cup', -20, 0);
    const drop = add('drop', 'pin', -20, 7.5);
    sim.runUntil(2.5);
    expect(h(pinUp)).toBeGreaterThan(PIN.half - 0.15); // standing on its tip
    expect(h(pinSide)).toBeGreaterThan(1.25); // lying on its 3" ridge
    expect(h(pinSide)).toBeLessThan(1.55);
    expect(h(cupSide)).toBeGreaterThan(1.3); // lying on its 3.15" rims
    const rim = h(host) + CUP.half;
    expect(h(drop)).toBeLessThan(rim + 0.8); // the Pin half went into the Cup
    expect(h(drop)).toBeGreaterThan(rim - 0.3);
    for (const o of om.objects.values()) {
      if (!o.body) continue;
      const w = o.body.angvel();
      expect(Math.hypot(w.x, w.y, w.z), `${o.id} at rest`).toBeLessThan(0.05);
    }
    sim.dispose();
  });

  it('pieces on the full field are at rest within 3 s', async () => {
    const built = await buildMatch({ params: cloneParams(OVERRIDE_DEFAULTS), layout: skills, matchType: 'skillsDriver', seed: 1, slots: [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'manual', robot: cloneRobot(DEFAULT_ROBOT) }] }, () => null, undefined, new Map());
    const sim = built.sim;
    sim.runUntil(3);
    const moving = [...sim.objects.objects.values()].filter((o) => {
      if (!o.body || o.mode !== 'free') return false;
      const w = o.body.angvel();
      return Math.hypot(w.x, w.y, w.z) > 0.05;
    });
    expect(moving.map((o) => o.id)).toEqual([]);
    sim.dispose();
  });
});
