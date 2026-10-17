import { describe, expect, it } from 'vitest';
import { buildLayout } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { cloneParams, OVERRIDE_DEFAULTS } from '../src/rules/ruleset';
import { zeroInput, type DriverInput } from '../src/sim/driver';
import { hudData } from '../src/sim/frame';
import { buildMatch, planScenario, type ScenarioConfig } from '../src/sim/scenario';
import { decodeSnap, encodeSnap, setupFrom } from '../src/net/protocol';
import { TeamSession } from '../src/net/session';
import { LocalTransport } from '../src/net/transport';
import { SimRunner } from '../src/ui/simRunner';
import { store } from '../src/ui/store';

/** Driver controls, bot ↔ human hand-over, the wire protocol and a host/guest session. */

function skillsDriver(): ScenarioConfig {
  return {
    params: cloneParams(OVERRIDE_DEFAULTS),
    layout: buildLayout('skillsDriver'),
    matchType: 'skillsDriver',
    seed: 1,
    slots: [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'manual', robot: cloneRobot(DEFAULT_ROBOT) }],
  };
}

describe('Driver controls (physics)', () => {
  it('drive, raise and drop the DR4B, presets, claw grab and drop', async () => {
    const inp: DriverInput = zeroInput();
    const built = await buildMatch(skillsDriver(), () => inp, undefined, new Map());
    const sim = built.sim;
    const r = sim.robots[0];
    const x0 = r.body.pose().pos.x;
    // drive forward
    inp.forward = 1;
    sim.runUntil(0.8);
    inp.forward = 0;
    sim.runUntil(1.6);
    expect(r.body.pose().pos.x - x0).toBeGreaterThan(10);
    // raise the arm, then release the stick: it holds
    inp.lift = 1;
    sim.runUntil(2.0);
    inp.lift = 0;
    sim.runUntil(2.5);
    const raised = r.body.holderHeight();
    expect(raised).toBeGreaterThan(6);
    sim.runUntil(3.5);
    expect(Math.abs(r.body.holderHeight() - raised)).toBeLessThan(0.6);
    // drop the arm
    inp.lift = -1;
    sim.runUntil(4.2);
    inp.lift = 0;
    expect(r.body.holderHeight()).toBeLessThan(DEFAULT_ROBOT.lift.holderMinHeightIn + 0.8);
    // preset: tall Goal height
    inp.preset = 9.4;
    sim.runUntil(5.2);
    expect(Math.abs(r.body.holderHeight() - 9.4)).toBeLessThan(0.6);
    // drop the preloaded Pin with the claw
    const held = r.primary ?? r.secondary;
    expect(held).not.toBeNull();
    inp.drop++;
    sim.runUntil(5.6);
    expect(r.primary?.id === held!.id || r.secondary?.id === held!.id).toBe(false);
    sim.dispose();
  });

  it('the claw toggles: closed on the preload at the start; a click opens it (lets go), the next closes it (grabs what is in front)', async () => {
    const inp: DriverInput = zeroInput();
    const built = await buildMatch(skillsDriver(), () => inp, undefined, new Map());
    const sim = built.sim;
    const r = sim.robots[0];
    const held = (r.primary ?? r.secondary)!;
    sim.runUntil(0.5);
    expect(r.clawClosed).toBe(true);
    inp.claw = !inp.claw; // click: open, let go
    sim.runUntil(1.5);
    expect(r.clawClosed).toBe(false);
    expect([r.primary?.id, r.secondary?.id]).not.toContain(held.id);
    inp.claw = !inp.claw; // click: close, grabs the Pin lying in front of it
    sim.runUntil(3.0);
    expect(r.clawClosed).toBe(true);
    expect([r.primary?.id, r.secondary?.id]).toContain(held.id);
    sim.dispose();
  });
});

describe('Bot ↔ human hand-over', () => {
  it('the bot drives Autonomous, a human drives Driver Control, and the bot replans when handed back', async () => {
    const sc: ScenarioConfig = {
      params: cloneParams(OVERRIDE_DEFAULTS),
      layout: buildLayout('headToHead'),
      matchType: 'headToHead',
      seed: 1,
      aiBeamWidth: 6,
      slots: [
        { slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot: cloneRobot(DEFAULT_ROBOT) },
        { slot: 'blue-1', alliance: 'blue', enabled: true, strategy: 'idle', robot: cloneRobot(DEFAULT_ROBOT) },
      ],
    };
    const inp = zeroInput();
    const built = await buildMatch(sc, (slot) => (slot === 'red-1' ? inp : null), undefined, planScenario(sc));
    const sim = built.sim;
    const slot = built.slots.get('red-1')!;
    const ex = built.executors.get('red-1')!;
    slot.setHuman('Tester');
    const r = sim.robots.find((x) => x.id === 'red-1')!;
    const p0 = r.body.pose().pos;
    sim.runUntil(6);
    // Autonomous: the robot's program runs although a human owns the slot
    const p6 = r.body.pose().pos;
    expect(Math.hypot(p6.x - p0.x, p6.y - p0.y)).toBeGreaterThan(5);
    // Driver Control with zero input: the robot stands still under the human
    sim.runUntil(16);
    expect(ex.history.length).toBeGreaterThan(0); // its program worked through Autonomous
    const a = r.body.pose().pos;
    sim.runUntil(17.5);
    const b = r.body.pose().pos;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1);
    // hand back: the bot replans from the current field and gets back to work
    const replans = ex.replans;
    const handedBack = sim.t;
    slot.setBot();
    sim.runUntil(22);
    expect(ex.replans).toBeGreaterThan(replans);
    expect(ex.history.some((h) => h.ok && h.tStart >= handedBack && h.label !== 'Wait')).toBe(true);
    sim.dispose();
  });
});

describe('Wire protocol', () => {
  it('snapshots round-trip within 1 mm / 1e-3 and only changed objects are re-sent', async () => {
    const built = await buildMatch(skillsDriver(), () => null, undefined, new Map());
    const sim = built.sim;
    sim.runUntil(0.5);
    const f0 = sim.sceneFrame();
    const setup = setupFrom(f0, 'host', 'skillsDriver', OVERRIDE_DEFAULTS, buildLayout('skillsDriver'));
    const prev = new Map<number, string>();
    const s0 = encodeSnap(f0, hudData(sim), 0, true, prev, false);
    expect(s0.o.length).toBe(f0.objects.length);
    const togglePos = new Map(f0.toggles.map((t) => [t.id, t.p]));
    const d0 = decodeSnap(s0, setup, null, togglePos);
    for (let i = 0; i < f0.objects.length; i++) {
      const a = f0.objects[i];
      const b = d0.objects[i];
      if (!a.p) {
        expect(b.p).toBeNull();
        continue;
      }
      expect(Math.abs(a.p.x - b.p!.x)).toBeLessThan(1e-3);
      expect(Math.abs(a.p.z - b.p!.z)).toBeLessThan(1e-3);
      expect(Math.abs(a.q!.w - b.q!.w)).toBeLessThan(2e-3);
    }
    expect(Math.abs(d0.robots[0].holderH - f0.robots[0].holderH)).toBeLessThan(0.01);
    // nothing moves while idle → after settling, a delta carries (almost) no objects
    sim.runUntil(2);
    encodeSnap(sim.sceneFrame(), hudData(sim), 1, false, prev, false);
    sim.runUntil(2.25);
    const s1 = encodeSnap(sim.sceneFrame(), hudData(sim), 1, false, prev, false);
    expect(s1.o.length).toBeLessThan(5);
    expect(JSON.stringify(s1).length).toBeLessThan(JSON.stringify(s0).length / 4);
    sim.dispose();
  });
});

describe('Team session over the local transport', () => {
  const wait = async (cond: () => boolean, ms = 10000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('a room starts by itself: the link joins it, the match starts, and a host alone streams nothing', async () => {
    const hostRunner = new SimRunner();
    await hostRunner.rebuild({ ...store.get() });
    let sent = 0;
    const counting = () => {
      const t = new LocalTransport();
      const send = t.send.bind(t);
      t.send = (m) => {
        if (m.type === 'snap') sent++;
        send(m);
      };
      return t;
    };
    const host = new TeamSession(hostRunner, counting);
    await host.autoStart('Hosty', null);
    expect(host.role).toBe('host');
    const room = host.state.room!;
    await new Promise((r) => setTimeout(r, 600));
    expect(sent).toBe(0); // nobody to stream to
    // opening the invite link joins the room; the guest replaces a bot and the match starts
    const guest = new TeamSession(new SimRunner(), () => new LocalTransport());
    await guest.autoStart('Gina', room);
    expect(guest.role).toBe('guest');
    await wait(() => guest.mySlot() !== null && guest.frameAt() !== null);
    expect(hostRunner.playing).toBe(true);
    expect(sent).toBeGreaterThan(0);
    // a link to a room nobody hosts (its host left): the visitor hosts it
    const late = new TeamSession(new SimRunner(), () => new LocalTransport());
    await late.autoStart('Lou', 'EMPTY');
    expect(late.role).toBe('host');
    expect(late.state.room).toBe('EMPTY');
    await Promise.all([guest.leave(), host.leave(), late.leave()]);
    hostRunner.sim?.dispose();
  }, 30000);

  it('a joining player replaces a bot, drives it, and the bot takes over again when they leave', async () => {
    const hostRunner = new SimRunner();
    await hostRunner.rebuild({ ...store.get() }); // default Head-to-Head, four bots
    const host = new TeamSession(hostRunner, () => new LocalTransport());
    const guest = new TeamSession(new SimRunner(), () => new LocalTransport());
    // the host drives red-1 itself
    await host.host('Hosty', 'local', 'TEST1');
    host.claimSlot('red-1');
    expect(hostRunner.driverOf('red-1').kind).toBe('local');
    await guest.join('TEST1', 'Gina', 'local');
    // the guest replaces a bot: the host's partner red-2 first
    await wait(() => guest.mySlot() !== null && guest.setup !== null);
    expect(guest.mySlot()).toBe('red-2');
    expect(hostRunner.driverOf('red-2')).toMatchObject({ kind: 'remote', name: 'Gina' });
    // snapshots arrive and interpolate
    hostRunner.setPlaying(true);
    await wait(() => guest.frameAt() !== null);
    expect(guest.frameAt()!.robots.length).toBe(4);
    expect(guest.hud).not.toBeNull();
    // the guest's input reaches the host's robot
    guest.onLocalInput({ ...zeroInput(), forward: 1, lift: 0.5 });
    await wait(() => (hostRunner.remote.get('red-2')?.forward ?? 0) === 1);
    expect(hostRunner.remote.get('red-2')!.lift).toBe(0.5);
    // switching robots: claim a free opponent bot
    guest.claimSlot('blue-1');
    await wait(() => guest.mySlot() === 'blue-1');
    expect(hostRunner.driverOf('red-2').kind).toBe('bot');
    // leaving hands the robot back to its bot
    await guest.leave();
    await wait(() => hostRunner.driverOf('blue-1').kind === 'bot');
    await host.leave();
    hostRunner.sim?.dispose();
  });
});
