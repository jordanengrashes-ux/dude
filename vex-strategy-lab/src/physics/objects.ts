import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { IN } from '../core/units';
import { CUP, PIN, stackCenter, stackKind, stackNextBottom, stackTop, type GoalGeom } from '../field/geometry';
import type { HalfColor } from '../rules/ruleset';
import { CG, quatConj, quatFromTo, quatMul, rotateV, slerp, toWorld, upOf, yawQuat, type Quat, type V3 } from './frames';
import { CUP_SEGMENTS, cupColliders, pinColliders, RING } from './elementShapes';
import type { Rapier } from './rapier';

/**
 * Pins and Cups as rigid bodies, and where each one is:
 *
 *   offfield → (Drive Team introduces a Match Load) → free
 *   free → (a claw's rollers pull it between the jaws) → held
 *   held → (the claw opens, or its rollers push it out) → free
 *   free, at rest nested on a Goal stack's top → stacked
 *   stacked (top of a stack) → (gripped by a claw) → held
 *
 * Everything is rigid-body physics. A held piece is part of the claw: its collision
 * shapes are attached to the lift carriage (so it can't wobble on its own and it
 * pushes, and is stopped by, everything it meets), and the rollers move it within
 * the claw at their surface speed. A dropped piece falls under gravity; it only
 * joins a stack after it physically comes to rest nested on the stack's top (a
 * misaligned drop lands on the rim and tumbles off). A stacked piece is then fixed
 * in place.
 *
 * Body conventions: Pin local −Y half = colors[0], +Y half = colors[1].
 * Cup local +Y half = gray (opaque), −Y half = clear.
 */

export type ObjMode = 'offfield' | 'free' | 'held' | 'stacked';

export interface Pose {
  p: V3;
  q: Quat;
}

/** A piece in a claw. Poses are in the carriage frame (meters). */
export interface HeldState {
  robotId: string;
  /** Where it is in the claw now. */
  local: Pose;
  /** Where the rollers are moving it. */
  target: Pose;
  /** Roller surface speed (in/s) and turn rate (rad/s) toward the target. */
  speed: number;
  rate: number;
  /** Its collision shapes on the carriage. */
  colliders: Collider[];
  /** Taken off this Goal's stack: kept where it was gripped until it is clear of the stack. */
  clearOf?: string;
}

export interface SimObject {
  id: string;
  kind: 'pin' | 'cup';
  colors?: [HalfColor, HalfColor];
  body: RigidBody | null;
  /** First of the object's colliders (a Cup has several: its shell is hollow). */
  collider: Collider | null;
  mode: ObjMode;
  matchloadAlliance?: 'red' | 'blue';
  /** Robot currently holding / last holding the object. */
  robotId?: string;
  /** Two-pocket holders: which pocket. A claw's gripped piece is 'primary', the next one nested on it 'secondary'. */
  pocket?: 'primary' | 'secondary';
  hold?: HeldState;
  stack?: { goalId: string; index: number };
  /** Time of the last release (for seating attribution). */
  releasedAt?: number;
  /** Time it was introduced (Match Loads). */
  introducedAt?: number;
  /** Dropped by an easy-mode driver: steered toward a Goal (or loose piece) within `funnel.assistRadius` while it falls. */
  assist?: boolean;
  /** Pieces nested on / under this loose one, held to it as one piece (see ObjectManager.bond). */
  bonds: { other: SimObject; joint: ImpulseJoint }[];
}

export interface StackRecord {
  goal: GoalGeom;
  elements: SimObject[];
}

export interface SeatEvent {
  t: number;
  obj: SimObject;
  goalId: string;
  index: number;
  robotId?: string;
}

/**
 * Contacts predicted this far ahead (m): a piece falling fast onto another sees the
 * rim before it gets there, instead of sinking its thin wall into it in one step.
 */
const SOFT_CCD = 0.03;

/** Half length along the axis (in). */
export const halfLenIn = (k: 'pin' | 'cup') => (k === 'pin' ? PIN.half : CUP.half);

/** Every collider of an object's body. */
export function objectColliders(obj: SimObject): Collider[] {
  const b = obj.body;
  if (!b) return [];
  const out: Collider[] = [];
  for (let i = 0; i < b.numColliders(); i++) out.push(b.collider(i));
  return out;
}

/** Put all of an object's colliders in a collision group (free / ghost / stacked). */
export function setObjectGroups(obj: SimObject, groups: number) {
  for (const c of objectColliders(obj)) c.setCollisionGroups(groups);
}

/** Degrees from upright (either end up). */
export function tiltDeg(obj: SimObject): number {
  return (Math.acos(Math.min(1, Math.abs(upOf(obj.body!.rotation()).y))) * 180) / Math.PI;
}

/** Lowest point of a piece (in above the tiles), from its pose. */
export function bottomIn(obj: SimObject): number {
  const p = obj.body!.translation();
  const uy = Math.abs(upOf(obj.body!.rotation()).y);
  const r = (obj.kind === 'pin' ? PIN.diameter : CUP.diameter) / 2;
  return p.y / IN - halfLenIn(obj.kind) * uy - r * Math.sqrt(Math.max(0, 1 - uy * uy));
}

export class ObjectManager {
  readonly objects = new Map<string, SimObject>();
  readonly stacks = new Map<string, StackRecord>();
  readonly seatEvents: SeatEvent[] = [];
  /**
   * Lateral tolerances (in) of a drop, from the shapes: a Pin's Ø1.40" tip has to
   * land inside a Goal socket's Ø2.41" bore, a Pin's tip inside a Cup's Ø3.00" rim (or
   * a Cup's rim around a Pin's tip). Easy-mode drops are steered in from further out.
   * `seat`: how close to its place on a stack a piece at rest must be to count as stacked.
   */
  funnel = { socket: 0.45, nest: 0.7, assistRadius: 2.5, seat: { off: 0.45, height: 0.3, tiltDeg: 12 } };

  constructor(
    private R: Rapier,
    private world: World,
    goals: GoalGeom[],
  ) {
    for (const g of goals) this.stacks.set(g.id, { goal: g, elements: [] });
  }

  private makeBody(kind: 'pin' | 'cup', p: V3, q: Quat, mass: number): { body: RigidBody; collider: Collider } {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q).setCcdEnabled(true).setSoftCcdPrediction(SOFT_CCD).setLinearDamping(0.1).setAngularDamping(0.8),
    );
    // shapes that follow the real geometry; plastic on foam tile: little bounce, rocking dies out quickly
    const parts = kind === 'pin' ? pinColliders(R) : cupColliders(R);
    let collider: Collider | null = null;
    for (const d of parts) {
      const c = this.world.createCollider(d.setMass(mass / parts.length).setFriction(0.45).setRestitution(0.03).setCollisionGroups(CG.free), body);
      collider ??= c;
    }
    return { body, collider: collider! };
  }

  /** Create an object on the field (upright) or off-field (Match Load). */
  add(o: { id: string; kind: 'pin' | 'cup'; colors?: [HalfColor, HalfColor]; matchloadAlliance?: 'red' | 'blue' }, place?: { x: number; y: number; z: number; flipped: boolean; yaw?: number; lie?: number }) {
    const obj: SimObject = { id: o.id, kind: o.kind, colors: o.colors, body: null, collider: null, mode: 'offfield', matchloadAlliance: o.matchloadAlliance, bonds: [] };
    this.objects.set(o.id, obj);
    if (place) this.spawn(obj, place);
    return obj;
  }

  /**
   * Put an off-field object onto the field at rest (start of match or Match Load
   * introduction): standing with its bottom at height `z`, or lying on its side with
   * its local +Y end toward field heading `lie`.
   */
  spawn(obj: SimObject, place: { x: number; y: number; z: number; flipped: boolean; yaw?: number; lie?: number }, t = 0) {
    const L = halfLenIn(obj.kind);
    let p: V3;
    let q: Quat;
    if (place.lie !== undefined) {
      // roll about the long axis so a flat face of the polygonal hull is down: it starts at rest
      const n = obj.kind === 'pin' ? RING : CUP_SEGMENTS;
      const q0 = quatFromTo({ x: 0, y: 1, z: 0 }, { x: Math.cos(place.lie), y: 0, z: -Math.sin(place.lie) });
      const g = rotateV(quatConj(q0), { x: 0, y: -1, z: 0 });
      const beta = Math.PI / n - Math.atan2(g.z, g.x);
      q = quatMul(q0, { x: 0, y: Math.sin(beta / 2), z: 0, w: Math.cos(beta / 2) });
      // the solver rests contacts about 1 mm deep
      p = toWorld(place.x, place.y, place.z + ((obj.kind === 'pin' ? PIN.diameter : CUP.diameter) / 2) * Math.cos(Math.PI / n) - 0.04);
    } else {
      p = toWorld(place.x, place.y, place.z + L);
      q = yawQuat(place.yaw ?? 0);
      if (place.flipped) q = quatMul(q, { x: 1, y: 0, z: 0, w: 0 }); // 180° about local X
    }
    const { body, collider } = this.makeBody(obj.kind, p, q, obj.kind === 'pin' ? PIN.massKg : CUP.massKg);
    obj.body = body;
    obj.collider = collider;
    obj.mode = 'free';
    obj.introducedAt = t;
  }

  /** Put an object directly into a Goal stack (start-of-match pre-placed Pins). */
  preplace(obj: SimObject, goalId: string, flipped: boolean) {
    const st = this.stacks.get(goalId)!;
    const n = st.elements.length;
    const p = toWorld(st.goal.pos.x, st.goal.pos.y, stackCenter(st.goal.height, n));
    let q = yawQuat(0);
    if (flipped) q = quatMul(q, { x: 1, y: 0, z: 0, w: 0 });
    const { body, collider } = this.makeBody(obj.kind, p, q, obj.kind === 'pin' ? PIN.massKg : CUP.massKg);
    obj.body = body;
    obj.collider = collider;
    this.finishSeat(obj, st);
  }

  /** Bottom height (in) of the next element of a stack once it has dropped in. */
  nextBottom(st: StackRecord): number {
    return stackNextBottom(st.goal.height, st.elements.length);
  }

  nextKind(st: StackRecord): 'pin' | 'cup' {
    return stackKind(st.elements.length);
  }

  /** Height of the current top of the stack (in). */
  topHeight(st: StackRecord): number {
    return stackTop(st.goal.height, st.elements.length);
  }

  private finishSeat(obj: SimObject, st: StackRecord) {
    this.unbond(obj);
    const b = obj.body!;
    b.setBodyType(this.R.RigidBodyType.Fixed, true);
    setObjectGroups(obj, CG.stacked);
    obj.mode = 'stacked';
    obj.assist = false;
    obj.stack = { goalId: st.goal.id, index: st.elements.length };
    st.elements.push(obj);
  }

  /**
   * A piece nested on a loose one (a Pin standing in a Cup, a Cup over a Pin) moves
   * with it as one piece — two resting rigid bodies in a ring-on-rim contact jitter
   * and creep across the tiles — until either is picked up or caught by a Goal, or
   * the pair tips far enough for the top piece to fall off.
   */
  bond(base: SimObject, top: SimObject) {
    const a = base.body!;
    const b = top.body!;
    const pa = a.translation();
    const pb = b.translation();
    const inv = quatConj(a.rotation());
    const lp = rotateV(inv, { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z });
    const lq = quatMul(inv, b.rotation());
    const joint = this.world.createImpulseJoint(this.R.JointData.fixed(lp, lq, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }), a, b, true);
    joint.setContactsEnabled(false);
    base.bonds.push({ other: top, joint });
    top.bonds.push({ other: base, joint });
  }

  unbond(obj: SimObject) {
    for (const bd of obj.bonds) {
      this.world.removeImpulseJoint(bd.joint, true);
      bd.other.bonds = bd.other.bonds.filter((x) => x.joint !== bd.joint);
    }
    obj.bonds = [];
  }

  /** Every piece bonded to this one, directly or through others (itself included). */
  bondedGroup(obj: SimObject): SimObject[] {
    const out = [obj];
    for (let i = 0; i < out.length; i++) for (const bd of out[i].bonds) if (!out.includes(bd.other)) out.push(bd.other);
    return out;
  }

  /** Express a world pose in a carriage frame. */
  static toLocal(f: Pose, p: V3, q: Quat): Pose {
    const inv = { x: -f.q.x, y: -f.q.y, z: -f.q.z, w: f.q.w };
    const d = { x: p.x - f.p.x, y: p.y - f.p.y, z: p.z - f.p.z };
    return { p: rotateV(inv, d), q: quatMul(inv, q) };
  }

  static toWorldPose(f: Pose, lp: V3, lq: Quat): Pose {
    const r = rotateV(f.q, lp);
    return { p: { x: f.p.x + r.x, y: f.p.y + r.y, z: f.p.z + r.z }, q: quatMul(f.q, lq) };
  }

  /**
   * Grip a piece in a claw: its shapes become part of the carriage at its current
   * place in the claw (`local`), and the rollers start moving it to `target`. Its own
   * body only follows the carriage from now on (for drawing; it collides with nothing).
   */
  grip(obj: SimObject, robotId: string, carriage: RigidBody, local: Pose, target: Pose, speed: number, rate: number): Collider[] {
    this.unbond(obj);
    const R = this.R;
    const b = obj.body!;
    b.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
    setObjectGroups(obj, CG.ghost);
    const colliders = (obj.kind === 'pin' ? pinColliders(R) : cupColliders(R)).map((d) =>
      this.world.createCollider(
        d.setTranslation(local.p.x, local.p.y, local.p.z).setRotation(local.q).setDensity(0).setFriction(0.5).setRestitution(0.03).setCollisionGroups(CG.carried),
        carriage,
      ),
    );
    obj.hold = { robotId, local, target, speed, rate, colliders };
    obj.mode = 'held';
    obj.robotId = robotId;
    obj.stack = undefined;
    obj.assist = false;
    return colliders;
  }

  /** The rollers move a held piece toward its target in the claw (call before the physics step). */
  stepHeld(obj: SimObject, dt: number) {
    const h = obj.hold;
    if (!h) return;
    const d = { x: h.target.p.x - h.local.p.x, y: h.target.p.y - h.local.p.y, z: h.target.p.z - h.local.p.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const dot = Math.min(1, Math.abs(h.local.q.x * h.target.q.x + h.local.q.y * h.target.q.y + h.local.q.z * h.target.q.z + h.local.q.w * h.target.q.w));
    const ang = 2 * Math.acos(dot);
    if (len < 1e-6 && ang < 1e-4) return;
    const step = h.speed * IN * dt;
    const k = len <= step ? 1 : step / len;
    h.local = {
      p: { x: h.local.p.x + d.x * k, y: h.local.p.y + d.y * k, z: h.local.p.z + d.z * k },
      q: ang <= h.rate * dt ? h.target.q : slerp(h.local.q, h.target.q, (h.rate * dt) / ang),
    };
    for (const c of h.colliders) {
      c.setTranslationWrtParent(h.local.p);
      c.setRotationWrtParent(h.local.q);
    }
  }

  /** Has the piece reached its place in the claw? */
  static settledInClaw(obj: SimObject): boolean {
    const h = obj.hold;
    if (!h) return true;
    const d = Math.hypot(h.target.p.x - h.local.p.x, h.target.p.y - h.local.p.y, h.target.p.z - h.local.p.z);
    const dot = Math.abs(h.local.q.x * h.target.q.x + h.local.q.y * h.target.q.y + h.local.q.z * h.target.q.z + h.local.q.w * h.target.q.w);
    return d < 0.02 * IN && dot > 0.9999;
  }

  /** Move a held piece's body to where it is in the claw (call after the physics step). */
  syncHeld(obj: SimObject, carriage: Pose) {
    const h = obj.hold;
    if (!h || !obj.body) return;
    const w = ObjectManager.toWorldPose(carriage, h.local.p, h.local.q);
    obj.body.setTranslation(w.p, false);
    obj.body.setRotation(w.q, false);
  }

  /**
   * Let go of a held piece: it is its own rigid body again, moving with the claw's
   * velocity at that point (plus `push`, m/s, when the rollers spit it out).
   */
  ungrip(obj: SimObject, t: number, carriage: RigidBody, push: V3 = { x: 0, y: 0, z: 0 }, assist = false) {
    const h = obj.hold;
    const b = obj.body!;
    if (h) {
      const f = { p: carriage.translation(), q: carriage.rotation() };
      const w = ObjectManager.toWorldPose(f, h.local.p, h.local.q);
      for (const c of h.colliders) this.world.removeCollider(c, true);
      b.setBodyType(this.R.RigidBodyType.Dynamic, true);
      b.setTranslation(w.p, true);
      b.setRotation(w.q, true);
      const v = carriage.velocityAtPoint(w.p);
      b.setLinvel({ x: v.x + push.x, y: v.y + push.y, z: v.z + push.z }, true);
      b.setAngvel(carriage.angvel(), true);
    } else b.setBodyType(this.R.RigidBodyType.Dynamic, true);
    setObjectGroups(obj, CG.free);
    obj.hold = undefined;
    obj.mode = 'free';
    obj.pocket = undefined;
    obj.releasedAt = t;
    obj.assist = assist;
  }

  /** Take the top element off a stack (a claw grips it). */
  unstackTop(goalId: string): SimObject | null {
    const st = this.stacks.get(goalId);
    if (!st || !st.elements.length) return null;
    const obj = st.elements.pop()!;
    obj.stack = undefined;
    return obj;
  }

  /** Pairs tipped past 35° come apart (the top piece falls off). */
  stepBonds() {
    for (const obj of this.objects.values()) if (obj.bonds.length && obj.body && obj.mode === 'free' && Math.abs(upOf(obj.body.rotation()).y) < 0.82) this.unbond(obj);
  }

  /** Where a piece dropped now would land: Goal stacks that take its kind next, and loose pieces it nests on. */
  dropTargets(kind: 'pin' | 'cup', exclude: (o: SimObject) => boolean = () => false): { id: string; at: { x: number; y: number }; top: number; tol: number; goal?: StackRecord; piece?: SimObject }[] {
    const out: { id: string; at: { x: number; y: number }; top: number; tol: number; goal?: StackRecord; piece?: SimObject }[] = [];
    for (const st of this.stacks.values()) {
      if (this.nextKind(st) !== kind) continue;
      out.push({ id: st.goal.id, at: st.goal.pos, top: this.topHeight(st), tol: st.elements.length === 0 ? this.funnel.socket : this.funnel.nest, goal: st });
    }
    // a standing piece of the other kind with nothing nested on it yet
    for (const o of this.objects.values()) {
      if (o.kind === kind || o.mode !== 'free' || !o.body || exclude(o) || tiltDeg(o) > 12) continue;
      if (this.nestedOn(o, 1)) continue;
      const t = o.body.translation();
      out.push({ id: o.id, at: { x: t.x / IN, y: -t.z / IN }, top: t.y / IN + halfLenIn(o.kind), tol: this.funnel.nest, piece: o });
    }
    return out;
  }

  /** A free piece of the other kind nested on top of `base` (dir 1: Pin in a Cup, Cup on a Pin) or under it (dir −1). */
  nestedOn(base: SimObject, dir: 1 | -1, modes: ObjMode[] = ['free']): SimObject | null {
    const b = base.body!.translation();
    for (const o of this.objects.values()) {
      if (o === base || !modes.includes(o.mode) || !o.body || o.kind === base.kind) continue;
      const p = o.body.translation();
      if (Math.hypot(p.x - b.x, p.z - b.z) / IN > 0.9) continue;
      const dy = (dir * (p.y - b.y)) / IN;
      if (dy < 2.2 || dy > 4.3 || tiltDeg(o) > 25) continue;
      return o;
    }
    return null;
  }

  /**
   * Easy mode: a dropped piece falling near a place it nests on is steered over it
   * (its horizontal velocity and tilt are guided; it still falls, collides and comes
   * to rest by itself).
   */
  stepAssist(t: number) {
    const radius = this.funnel.assistRadius;
    for (const obj of this.objects.values()) {
      if (!obj.assist || obj.mode !== 'free' || !obj.body) continue;
      if (t - (obj.releasedAt ?? 0) > 1.5) {
        obj.assist = false;
        continue;
      }
      const b = obj.body;
      const p = b.translation();
      const x = p.x / IN;
      const y = -p.z / IN;
      const bottom = bottomIn(obj);
      let best: { at: { x: number; y: number }; d: number } | null = null;
      for (const tg of this.dropTargets(obj.kind, (o) => o === obj || o.bonds.some((bd) => bd.other === obj))) {
        const d = Math.hypot(tg.at.x - x, tg.at.y - y);
        // only while it is still above the place it would nest on
        if (d > radius || bottom < tg.top - 0.6) continue;
        if (!best || d < best.d) best = { at: tg.at, d };
      }
      if (!best) continue;
      const v = b.linvel();
      const k = Math.min(1, 30 / Math.max(1e-6, best.d * 12)); // up to 30 in/s sideways
      const vx = (best.at.x - x) * 12 * k * IN;
      const vz = -(best.at.y - y) * 12 * k * IN;
      b.setLinvel({ x: vx, y: v.y, z: vz }, true);
      // and stood up (keeping whichever end is up)
      const up = upOf(b.rotation());
      const want = { x: 0, y: Math.sign(up.y) || 1, z: 0 };
      const ax = { x: up.y * want.z - up.z * want.y, y: up.z * want.x - up.x * want.z, z: up.x * want.y - up.y * want.x };
      b.setAngvel({ x: ax.x * 10, y: 0, z: ax.z * 10 }, true);
    }
  }

  /**
   * A free piece at rest nested on a stack's top — centered, upright, at the height
   * where the next element sits — joins the stack.
   */
  detectSeating(t: number): SeatEvent[] {
    const out: SeatEvent[] = [];
    const S = this.funnel.seat;
    for (const obj of this.objects.values()) {
      if (obj.mode !== 'free' || !obj.body) continue;
      const b = obj.body;
      const v = b.linvel();
      if (Math.hypot(v.x, v.y, v.z) / IN > 1.5) continue;
      const w = b.angvel();
      if (Math.hypot(w.x, w.y, w.z) > 1.5) continue;
      if (tiltDeg(obj) > S.tiltDeg) continue;
      const p = b.translation();
      for (const st of this.stacks.values()) {
        if (this.nextKind(st) !== obj.kind) continue;
        const off = Math.hypot(p.x / IN - st.goal.pos.x, -p.z / IN - st.goal.pos.y);
        if (off > S.off) continue;
        if (Math.abs(p.y / IN - stackCenter(st.goal.height, st.elements.length)) > S.height) continue;
        const index = st.elements.length;
        this.finishSeat(obj, st);
        const ev = { t, obj, goalId: st.goal.id, index, robotId: obj.robotId };
        out.push(ev);
        this.seatEvents.push(ev);
        break;
      }
    }
    return out;
  }

  /** Orientation facts for scoring extraction. */
  static isUpright(obj: SimObject): boolean {
    return upOf(obj.body!.rotation()).y >= 0;
  }

  /** Rotation that stands an object upright (keeping its up-sign) with a given yaw. */
  static uprightRotation(q: Quat, yaw: number): Quat {
    const up = upOf(q);
    let r = yawQuat(yaw);
    if (up.y < 0) r = quatMul(r, { x: 1, y: 0, z: 0, w: 0 });
    return r;
  }

  static alignUp(q: Quat): Quat {
    const up = upOf(q);
    return quatMul(quatFromTo(up, { x: 0, y: Math.sign(up.y) || 1, z: 0 }), q);
  }
}
