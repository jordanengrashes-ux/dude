import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { IN, wrapAngle } from '../core/units';
import { buildGoals, buildLoaders, buildToggles, HALF, PERIMETER_HEIGHT, PERIMETER_THICKNESS, type GoalGeom, type ToggleGeom } from '../field/geometry';
import type { TogglePosition } from '../rules/fieldState';
import { CG, quatConj, quatMul, toWorld, type Quat } from './frames';
import type { Rapier } from './rapier';

/**
 * Static field elements and the four Toggles.
 *
 * Toggle model (assumption — the mechanism is not specified in the sources found):
 * a triangular prism on a revolute joint whose axis is the wall normal. Its three
 * faces can each rest flat on the perimeter mount, giving three stable positions
 * 120° apart (yellow = 0°, red = +120°, blue = −120°). A detent torque models the
 * face resting on the mount; robots rotate it by pushing (contact) or with the
 * toggle arm. SC4: a Toggle counts only when seated and not contacted by a Robot.
 */

export interface ToggleBody {
  geom: ToggleGeom;
  body: RigidBody;
  collider: Collider;
  joint: ImpulseJoint;
  q0: Quat;
  /** Detent stiffness (N·m) and damping. */
  k: number;
  c: number;
  /** External actuator torque requested this step (N·m about the axis). */
  actuate: number;
}

export interface FieldBodies {
  floor: Collider;
  walls: Collider[];
  goalColliders: Map<string, Collider[]>;
  loaders: Collider[];
  toggles: ToggleBody[];
  goals: GoalGeom[];
}

export function buildField(R: Rapier, world: World): FieldBodies {
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());
  const floor = world.createCollider(
    R.ColliderDesc.cuboid((HALF + 12) * IN, 0.5 * IN, (HALF + 12) * IN).setTranslation(0, -0.5 * IN, 0).setFriction(0.6).setCollisionGroups(CG.field),
    fixed,
  );
  const walls: Collider[] = [];
  const h = PERIMETER_HEIGHT * IN;
  const t = PERIMETER_THICKNESS * IN;
  const span = (HALF + PERIMETER_THICKNESS) * IN;
  for (const [x, z, hx, hz] of [
    [-(HALF * IN + t / 2), 0, t / 2, span],
    [HALF * IN + t / 2, 0, t / 2, span],
    [0, -(HALF * IN + t / 2), span, t / 2],
    [0, HALF * IN + t / 2, span, t / 2],
  ]) {
    walls.push(world.createCollider(R.ColliderDesc.cuboid(hx, h / 2, hz).setTranslation(x, h / 2, z).setFriction(0.3).setCollisionGroups(CG.field), fixed));
  }
  const goals = buildGoals();
  const goalColliders = new Map<string, Collider[]>();
  for (const g of goals) {
    const p = toWorld(g.pos.x, g.pos.y, 0);
    const base = world.createCollider(
      R.ColliderDesc.cylinder(0.25 * IN, g.baseRadius * IN).setTranslation(p.x, 0.25 * IN, p.z).setFriction(0.5).setCollisionGroups(CG.field),
      fixed,
    );
    const post = world.createCollider(
      R.ColliderDesc.cylinder((g.height / 2) * IN, g.postRadius * IN).setTranslation(p.x, (g.height / 2) * IN, p.z).setFriction(0.4).setCollisionGroups(CG.post),
      fixed,
    );
    goalColliders.set(g.id, [base, post]);
  }
  const loaders: Collider[] = [];
  for (const l of buildLoaders()) {
    const F = l.footprint;
    const cx = l.corner.x - Math.sign(l.corner.x) * (F / 2);
    const cy = l.corner.y - Math.sign(l.corner.y) * (F / 2);
    const p = toWorld(cx, cy, 0);
    loaders.push(world.createCollider(R.ColliderDesc.cuboid((F / 2) * IN, 6 * IN, (F / 2) * IN).setTranslation(p.x, 6 * IN, p.z).setCollisionGroups(CG.field), fixed));
  }
  const toggles: ToggleBody[] = buildToggles().map((tg) => buildToggle(R, world, fixed, tg));
  return { floor, walls, goalColliders, loaders, toggles, goals };
}

function buildToggle(R: Rapier, world: World, fixed: RigidBody, tg: ToggleGeom): ToggleBody {
  // axis = inward wall normal in world coordinates
  const n = toWorld(tg.normal.x, tg.normal.y, 0);
  const axis = { x: n.x / IN, y: 0, z: n.z / IN };
  const offset = 1.2; // pivot distance from the wall face (in)
  const pivot = toWorld(tg.pos.x + tg.normal.x * offset, tg.pos.y + tg.normal.y * offset, tg.pivotHeight);
  // Build the prism in a local frame where local +Z = axis, then rotate.
  const r = (tg.size / Math.sqrt(3)) * IN; // circumradius of the equilateral triangle
  const th = 0.5 * IN; // half thickness along the axis
  const pts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 3; // vertex up at 0°
    for (const z of [-th, th]) pts.push(r * Math.cos(a), r * Math.sin(a), z);
  }
  // rotation taking local +Z to the axis (about world Y)
  const yaw = Math.atan2(axis.x, axis.z);
  const q0: Quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pivot.x, pivot.y, pivot.z).setRotation(q0).setAngularDamping(1.5));
  const collider = world.createCollider(
    R.ColliderDesc.convexHull(new Float32Array(pts))!.setMass(0.2).setFriction(0.5).setCollisionGroups(CG.toggle),
    body,
  );
  // A mount with the same orientation keeps the revolute axis identical in both local frames.
  void fixed;
  const mount = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pivot.x, pivot.y, pivot.z).setRotation(q0));
  const joint = world.createImpulseJoint(R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), mount, body, true);
  return { geom: tg, body, collider, joint, q0, k: 0.35, c: 0.02, actuate: 0 };
}

/** Rotation angle of a toggle about its axis relative to the yellow-up reference. */
export function toggleAngle(t: ToggleBody): number {
  const q = t.body.rotation();
  const rel = quatMul(quatConj(t.q0), q);
  // rotation about local +Z
  return wrapAngle(2 * Math.atan2(rel.z, rel.w));
}

export const DETENTS: { angle: number; color: TogglePosition }[] = [
  { angle: 0, color: 'yellow' },
  { angle: (2 * Math.PI) / 3, color: 'red' },
  { angle: (-2 * Math.PI) / 3, color: 'blue' },
];

export function toggleTargetAngle(color: TogglePosition): number {
  return DETENTS.find((d) => d.color === color)?.angle ?? 0;
}

/** Seated position (SC4) — within 6° of a detent and nearly at rest — else 'unseated'. */
export function togglePosition(t: ToggleBody): TogglePosition {
  const a = toggleAngle(t);
  const w = t.body.angvel();
  const speed = Math.hypot(w.x, w.y, w.z);
  for (const d of DETENTS) if (Math.abs(wrapAngle(a - d.angle)) < (6 * Math.PI) / 180 && speed < 0.6) return d.color;
  return 'unseated';
}

/** Apply detent + actuator torque for one step. */
export function stepToggle(t: ToggleBody, dt: number) {
  const a = toggleAngle(t);
  const w = t.body.angvel();
  const axisW = { x: 2 * (t.q0.x * t.q0.z + t.q0.w * t.q0.y), y: 2 * (t.q0.y * t.q0.z - t.q0.w * t.q0.x), z: 1 - 2 * (t.q0.x * t.q0.x + t.q0.y * t.q0.y) };
  const omega = w.x * axisW.x + w.y * axisW.y + w.z * axisW.z;
  // detent: stable at 0, ±120°; unstable at ±60°, 180°
  const tau = (-t.k * Math.sin(3 * a)) / 3 - t.c * omega + t.actuate;
  t.body.applyTorqueImpulse({ x: axisW.x * tau * dt, y: axisW.y * tau * dt, z: axisW.z * tau * dt }, true);
  t.actuate = 0;
}
