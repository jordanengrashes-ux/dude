import { describe, expect, it } from 'vitest';
import { dist, distPointToPolygon, obbCorners } from '../src/core/vec';
import {
  buildGoals,
  buildLoaders,
  buildToggles,
  footprintInMidfield,
  footprintOnOpposingSide,
  HALF,
  MIDFIELD_INNER_HALF,
  quadrantOf,
  sideOf,
  TILE,
} from '../src/field/geometry';
import { buildLayout, PIN_COLORS } from '../src/field/layout';
import { cloneRobot, DEFAULT_ROBOT } from '../src/robot/config';
import { inspectRobot } from '../src/rules/inspection';
import { buildClock, isEndgame, periodAt } from '../src/rules/timing';
import { OVERRIDE_DEFAULTS, OVERRIDE_RULES } from '../src/rules/ruleset';
import { SOURCES } from '../src/rules/sources';

describe('Field dimensions', () => {
  it('is 6 × 6 tiles of 600 mm (≈ 12 ft nominal)', () => {
    expect(TILE * 6 * 25.4).toBeCloseTo(3600, 6);
    expect(HALF * 2).toBeGreaterThan(140);
    expect(HALF * 2).toBeLessThan(144);
  });

  it('has 9 Goals: 2 red + 2 blue Alliance, 4 neutral, 1 Midfield', () => {
    const g = buildGoals();
    expect(g).toHaveLength(9);
    expect(g.filter((x) => x.type === 'alliance' && x.allianceColor === 'red')).toHaveLength(2);
    expect(g.filter((x) => x.type === 'alliance' && x.allianceColor === 'blue')).toHaveLength(2);
    expect(g.filter((x) => x.type === 'neutral')).toHaveLength(4);
    expect(g.filter((x) => x.type === 'midfield')).toHaveLength(1);
  });

  it('each non-center Goal is 1 tile from one wall and 2 tiles from another', () => {
    for (const g of buildGoals().filter((x) => x.type !== 'midfield')) {
      const dx = HALF - Math.abs(g.pos.x);
      const dy = HALF - Math.abs(g.pos.y);
      const ds = [dx, dy].map((d) => Math.round(d / TILE)).sort();
      expect(ds).toEqual([1, 2]);
    }
  });

  it('each Quadrant has 2 Goals (one Alliance, one neutral) and 1 Toggle', () => {
    const goals = buildGoals();
    for (const q of ['R1', 'R2', 'B1', 'B2'] as const) {
      const inQ = goals.filter((g) => g.quadrant === q);
      expect(inQ).toHaveLength(2);
      expect(inQ.filter((g) => g.type === 'alliance')).toHaveLength(1);
      const allianceGoal = inQ.find((g) => g.type === 'alliance')!;
      expect(allianceGoal.allianceColor).toBe(q.startsWith('R') ? 'red' : 'blue');
      expect(buildToggles().filter((t) => t.quadrant === q)).toHaveLength(1);
    }
  });

  it('Toggles sit at wall centers; Red 1 is adjacent to the red Alliance Station (−x wall)', () => {
    const t = buildToggles();
    for (const x of t) expect(Math.abs(x.pos.x) === HALF || Math.abs(x.pos.y) === HALF).toBe(true);
    expect(t.find((x) => x.quadrant === 'R1')!.pos.x).toBe(-HALF);
    expect(quadrantOf({ x: -60, y: 0 })).toBe('R1');
  });

  it('has 4 Loaders, two per Alliance', () => {
    const l = buildLoaders();
    expect(l).toHaveLength(4);
    expect(l.filter((x) => x.alliance === 'red')).toHaveLength(2);
  });

  it('Midfield square is the inner edge of tape centered on the ±1 tile seams', () => {
    expect(MIDFIELD_INNER_HALF).toBeCloseTo(TILE - 1.25, 6);
    expect(footprintInMidfield({ x: MIDFIELD_INNER_HALF + 7.9, y: 0 }, 0, 16, 16)).toBe(true);
    expect(footprintInMidfield({ x: MIDFIELD_INNER_HALF + 8.1, y: 0 }, 0, 16, 16)).toBe(false);
  });

  it('SG7 side test: red side is x+y<0; Midfield contact is not an opposing-side contact', () => {
    expect(sideOf({ x: -30, y: -10 })).toBe('red');
    expect(sideOf({ x: 30, y: 10 })).toBe('blue');
    expect(footprintOnOpposingSide({ x: -40, y: -40 }, 0, 16, 16, 'red')).toBe(false);
    expect(footprintOnOpposingSide({ x: 40, y: 40 }, 0, 16, 16, 'red')).toBe(true);
    expect(footprintOnOpposingSide({ x: 4, y: 4 }, 0, 16, 16, 'red')).toBe(false);
  });
});

describe('Object layout', () => {
  const L = buildLayout('headToHead');
  it('has exactly 63 Pins and 56 Cups', () => {
    expect(L.pins).toHaveLength(63);
    expect(L.cups).toHaveLength(56);
  });

  it('Pin color split: 4 RB, 20 RY, 20 BY, 19 YY', () => {
    const count = (t: string) => L.pins.filter((p) => p.type === t).length;
    expect([count('RB'), count('RY'), count('BY'), count('YY')]).toEqual([4, 20, 20, 19]);
    expect(PIN_COLORS.RY).toEqual(['red', 'yellow']);
  });

  it('match-load and preload split per alliance', () => {
    const ml = L.pins.filter((p) => p.start.where === 'matchload');
    expect(ml.filter((p) => p.type === 'RY')).toHaveLength(10);
    expect(ml.filter((p) => p.type === 'BY')).toHaveLength(10);
    expect(ml.filter((p) => p.type === 'YY')).toHaveLength(2);
    expect(L.pins.filter((p) => p.start.where === 'preload')).toHaveLength(4);
    expect(L.cups.filter((c) => c.start.where === 'matchload')).toHaveLength(20);
    const fieldCups = L.cups.filter((c) => c.start.where === 'field');
    expect(fieldCups.filter((c) => c.start.where === 'field' && c.start.grayUp)).toHaveLength(24);
    expect(fieldCups.filter((c) => c.start.where === 'field' && !c.start.grayUp)).toHaveLength(12);
  });

  it('field objects are inside the field and clear of goals, loaders, robots and each other', () => {
    const pts = [
      ...L.pins.flatMap((p) => (p.start.where === 'field' ? [{ id: p.id, pos: p.start.pos, r: 0.8 }] : [])),
      ...L.cups.flatMap((c) => (c.start.where === 'field' ? [{ id: c.id, pos: c.start.pos, r: 1.6 }] : [])),
    ];
    for (const a of pts) {
      expect(Math.abs(a.pos.x)).toBeLessThan(HALF - 2);
      expect(Math.abs(a.pos.y)).toBeLessThan(HALF - 2);
      for (const g of buildGoals()) expect(dist(a.pos, g.pos)).toBeGreaterThan(g.baseRadius + a.r + 1);
      for (const l of buildLoaders()) expect(dist(a.pos, l.corner)).toBeGreaterThan(12);
      for (const r of L.robots) expect(distPointToPolygon(a.pos, obbCorners(r.pos, r.heading, 18, 18))).toBeGreaterThan(a.r + 1);
      for (const b of pts) if (a !== b) expect(dist(a.pos, b.pos)).toBeGreaterThan(a.r + b.r + 1);
    }
  });

  it('layout is 180° symmetric with colors swapped', () => {
    const field = L.pins.filter((p) => p.start.where === 'field');
    for (const p of field) {
      if (p.start.where !== 'field') continue;
      const pos = p.start.pos;
      const mirror = field.find((q) => q.start.where === 'field' && dist(q.start.pos, { x: -pos.x, y: -pos.y }) < 1e-9);
      expect(mirror).toBeDefined();
      const sw = (t: string) => (t === 'RY' ? 'BY' : t === 'BY' ? 'RY' : t);
      expect(mirror!.type).toBe(sw(p.type));
    }
  });

  it('Skills layout: Goals start empty; 3 RY + 4 BY + 7 Cup Match Loads; one robot', () => {
    const S = buildLayout('skillsDriver');
    expect(S.pins.filter((p) => p.start.where === 'goal')).toHaveLength(0);
    expect(S.pins.filter((p) => p.start.where === 'matchload' && p.type === 'RY')).toHaveLength(3);
    expect(S.pins.filter((p) => p.start.where === 'matchload' && p.type === 'BY')).toHaveLength(4);
    expect(S.cups.filter((c) => c.start.where === 'matchload')).toHaveLength(7);
    expect(S.robots).toHaveLength(1);
  });
});

describe('Timing', () => {
  it('Head-to-Head: 15 s Autonomous then 105 s Driver; Endgame is the last 10 s', () => {
    const c = buildClock('headToHead', OVERRIDE_DEFAULTS);
    expect(c.total).toBe(120);
    expect(periodAt(c, 0)).toBe('autonomous');
    expect(periodAt(c, 14.99)).toBe('autonomous');
    expect(periodAt(c, 15)).toBe('driver');
    expect(periodAt(c, 120)).toBe('ended');
    expect(isEndgame(c, 109.9)).toBe(false);
    expect(isEndgame(c, 110)).toBe(true);
  });
  it('Skills: one 60 s period', () => {
    const c = buildClock('skillsAuton', OVERRIDE_DEFAULTS);
    expect(c.total).toBe(60);
    expect(periodAt(c, 30)).toBe('skills');
  });
});

describe('Robot inspection', () => {
  it('the default 16×16 DR4B robot passes (and so does the rack-and-pinion variant)', () => {
    expect(DEFAULT_ROBOT.lift.type).toBe('dr4b');
    expect(inspectRobot(DEFAULT_ROBOT, OVERRIDE_DEFAULTS).passed).toBe(true);
    const rp = cloneRobot();
    rp.lift.type = 'rackPinion';
    expect(inspectRobot(rp, OVERRIDE_DEFAULTS).passed).toBe(true);
  });
  it('a 20" chassis fails the starting-size rule', () => {
    const c = cloneRobot();
    c.chassis.lengthIn = 20;
    const r = inspectRobot(c, OVERRIDE_DEFAULTS);
    expect(r.passed).toBe(false);
    expect(r.items.find((i) => i.label.startsWith('Starting length'))!.ok).toBe(false);
  });
  it('DR4B bars long enough that the knee swings past the rear bumper fail the starting length', () => {
    const c = cloneRobot();
    c.lift.barLengthIn = 14; // knee 12.7" behind the towers at −25°, towers 8.75" from the rear
    const r = inspectRobot(c, OVERRIDE_DEFAULTS);
    const item = r.items.find((i) => i.label.startsWith('Starting length'))!;
    expect(item.ok).toBe(false);
    expect(parseFloat(item.value)).toBeCloseTo(16 + 14 * Math.cos((25 * Math.PI) / 180) - 8.75, 1);
  });
  it('a lift tower taller than 18" fails the start height', () => {
    const c = cloneRobot();
    c.chassis.towerHeightIn = 19;
    expect(inspectRobot(c, OVERRIDE_DEFAULTS).passed).toBe(false);
  });
  it('legal holder height is capped by the 50" vertical limit (rack and DR4B)', () => {
    const c = cloneRobot();
    c.lift.type = 'rackPinion';
    c.lift.travelIn = 60;
    expect(inspectRobot(c, OVERRIDE_DEFAULTS).maxLegalHolderHeight.preEndgame).toBeCloseTo(50 - c.lift.carriageHeightIn, 6);
    const d = cloneRobot();
    d.lift.barLengthIn = 20;
    d.lift.maxAngleDeg = 80; // travel 2·20·(sin 80° + sin 25°) ≈ 56"
    expect(inspectRobot(d, OVERRIDE_DEFAULTS).maxLegalHolderHeight.preEndgame).toBeCloseTo(50 - d.lift.carriageHeightIn, 6);
  });
});

describe('Rule provenance', () => {
  it('every rule cites known sources (or is an explicit assumption) and has a last-checked date', () => {
    for (const r of OVERRIDE_RULES) {
      expect(r.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (r.verification !== 'assumption') expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) expect(SOURCES[s]).toBeDefined();
    }
  });
});
