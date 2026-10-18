import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { IN } from '../core/units';
import { CUP, PIN, type GoalGeom } from '../field/geometry';
import type { HalfColor } from '../rules/ruleset';
import { CG, quatConj, quatFromTo, quatMul, rotateV, slerp, toWorld, upOf, yawQuat, headingOf, type Quat, type V3 } from './frames';
import { CUP_SEGMENTS, cupColliders, pinColliders, RING } from './elementShapes';
import type { Rapier } from './rapier';

/**
 * Pins and Cups as rigid bodies, and the state machine that moves them between
 * the field, a robot's holder and a Goal stack.
 *
 *   offfield → (Drive Team introduces Match Load) → free
 *   free → (robot intake captures it) → intaking (mechanism-driven motion) → held
 *   held → (index between pockets) → indexing → held
 *   held → (release) → free (falls under gravity)
 *   free near a stack top, aligned within the funnel tolerance → seating → stacked
 *   stacked (top element of own Alliance Goal) → (intake) → intaking (descore)
 *
 * Nothing jumps: intaking/indexing/seating are continuous kinematic motions with
 * bounded duration driven by a mechanism or by the Goal funnel; everything else is
 * free rigid-body dynamics. Seating only happens if the object physically arrives
 * aligned with the stack — a misaligned release lands on the rim and tumbles.
 *
 * Body conventions: Pin local −Y half = colors[0], +Y half = colors[1].
 * Cup local +Y half = gray (opaque), −Y half = clear.
 */

export type ObjMode = 'offfield' | 'free' | 'intaking' | 'held' | 'indexing' | 'seating' | 'stacked';

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
  pocket?: 'primary' | 'secondary';
  joint?: ImpulseJoint | null;
  anim?: {
    frame: 'carriage' | 'world';
    from: { p: V3; q: Quat };
    to: { p: V3; q: Quat };
    t0: number;
    dur: number;
    then: 'held' | 'stacked';
  };
  stack?: { goalId: string; index: number };
  /** Time of the last release (for seating attribution). */
  releasedAt?: number;
  /** Time it was introduced (Match Loads). */
  introducedAt?: number;
  /** Dropped by an easy-mode driver: Goals capture it within `funnel.assistRadius`. */
  assist?: boolean;
  /** A Pin standing in a loose Cup, held to it as one piece (see ObjectManager.bond). */
  bond?: { other: SimObject; joint: ImpulseJoint };
}

export interface CarriageFrame {
  p: V3;
  q: Quat;
}

export interface StackRecord {
  goal: GoalGeom;
  elements: SimObject[];
  /** Object currently being guided onto this stack (slot reserved). */
  pending: SimObject | null;
}

export interface SeatEvent {
  t: number;
  obj: SimObject;
  goalId: string;
  index: number;
  robotId?: string;
}

const halfLen = (k: 'pin' | 'cup') => ((k === 'pin' ? PIN.length : CUP.length) / 2) * IN;

/** Every collider of an object's body. */
export function objectColliders(obj: SimObject): Collider[] {
  const b = obj.body;
  if (!b) return [];
  const out: Collider[] = [];
  for (let i = 0; i < b.numColliders(); i++) out.push(b.collider(i));
  return out;
}

/** Put all of an object's colliders in a collision group (free / held / stacked). */
export function setObjectGroups(obj: SimObject, groups: number) {
  for (const c of objectColliders(obj)) c.setCollisionGroups(groups);
}

export class ObjectManager {
  readonly objects = new Map<string, SimObject>();
  readonly stacks = new Map<string, StackRecord>();
  readonly seatEvents: SeatEvent[] = [];
  /**
   * Lateral/vertical capture tolerances of the Goal / Cup funnel (inches). A Pin's
   * tapered half self-centers in a Cup or Goal opening, a Cup's opening over a Pin's
   * tip; easy-mode drops get a wider assist.
   */
  funnel = { pinRadius: 1.0, cupRadius: 1.1, assistRadius: 2.5, maxTiltDeg: 20, above: 3.6, below: 0.35 };
  seatDuration = 0.12;

  constructor(private R: Rapier, private world: World, goals: GoalGeom[]) {
    for (const g of goals) this.stacks.set(g.id, { goal: g, elements: [], pending: null });
  }

  private makeBody(kind: 'pin' | 'cup', p: V3, q: Quat, mass: number): { body: RigidBody; collider: Collider } {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q).setCcdEnabled(true).setLinearDamping(0.1).setAngularDamping(0.8),
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
    const obj: SimObject = { id: o.id, kind: o.kind, colors: o.colors, body: null, collider: null, mode: 'offfield', matchloadAlliance: o.matchloadAlliance };
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
    const L = (obj.kind === 'pin' ? PIN.length : CUP.length) / 2;
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
    const pose = this.seatPose(st, obj.kind, flipped, 0);
    const { body, collider } = this.makeBody(obj.kind, pose.p, pose.q, obj.kind === 'pin' ? PIN.massKg : CUP.massKg);
    obj.body = body;
    obj.collider = collider;
    this.finishSeat(obj, st);
  }

  /** Expected bottom height (inches) of the next element on a stack. */
  nextBottom(st: StackRecord): number {
    const H = st.goal.height;
    const n = st.elements.length;
    if (n === 0) return H - PIN.half;
    if (n % 2 === 1) return H + ((n - 1) / 2) * PIN.length; // cup over top pin
    return H + (n / 2) * CUP.length - PIN.half; // pin into top cup
  }

  nextKind(st: StackRecord): 'pin' | 'cup' {
    return st.elements.length % 2 === 0 ? 'pin' : 'cup';
  }

  /** Height of the current top of the stack (inches). */
  topHeight(st: StackRecord): number {
    const H = st.goal.height;
    const n = st.elements.length;
    if (n === 0) return H;
    if (n % 2 === 1) return H + PIN.half + ((n - 1) / 2) * PIN.length;
    return H + (n / 2) * CUP.length;
  }

  private seatPose(st: StackRecord, kind: 'pin' | 'cup', flipped: boolean, yaw: number) {
    const bottom = this.nextBottom(st);
    const L = (kind === 'pin' ? PIN.length : CUP.length) / 2;
    const p = toWorld(st.goal.pos.x, st.goal.pos.y, bottom + L);
    let q = yawQuat(yaw);
    if (flipped) q = quatMul(q, { x: 1, y: 0, z: 0, w: 0 });
    return { p, q };
  }

  private finishSeat(obj: SimObject, st: StackRecord) {
    const b = obj.body!;
    b.setBodyType(this.R.RigidBodyType.Fixed, true);
    setObjectGroups(obj, CG.stacked);
    obj.mode = 'stacked';
    obj.anim = undefined;
    obj.assist = false;
    obj.stack = { goalId: st.goal.id, index: st.elements.length };
    st.elements.push(obj);
    if (st.pending === obj) st.pending = null;
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
    base.bond = { other: top, joint };
    top.bond = { other: base, joint };
  }

  unbond(obj: SimObject) {
    const bd = obj.bond;
    if (!bd) return;
    this.world.removeImpulseJoint(bd.joint, true);
    obj.bond = undefined;
    bd.other.bond = undefined;
  }

  /** Start a mechanism-driven motion (carriage or world frame). */
  animate(obj: SimObject, frame: 'carriage' | 'world', from: { p: V3; q: Quat }, to: { p: V3; q: Quat }, t: number, dur: number, then: 'held' | 'stacked') {
    this.unbond(obj);
    const b = obj.body!;
    if (b.bodyType() !== this.R.RigidBodyType.KinematicPositionBased) b.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    setObjectGroups(obj, CG.held);
    obj.anim = { frame, from, to, t0: t, dur: Math.max(1e-3, dur), then };
    obj.mode = then === 'held' ? (obj.mode === 'held' ? 'indexing' : 'intaking') : 'seating';
  }

  /** Express a world pose in a carriage frame. */
  static toLocal(f: CarriageFrame, p: V3, q: Quat): { p: V3; q: Quat } {
    const inv = { x: -f.q.x, y: -f.q.y, z: -f.q.z, w: f.q.w };
    const d = { x: p.x - f.p.x, y: p.y - f.p.y, z: p.z - f.p.z };
    return { p: rotateV(inv, d), q: quatMul(inv, q) };
  }

  static toWorldPose(f: CarriageFrame, lp: V3, lq: Quat): { p: V3; q: Quat } {
    const r = rotateV(f.q, lp);
    return { p: { x: f.p.x + r.x, y: f.p.y + r.y, z: f.p.z + r.z }, q: quatMul(f.q, lq) };
  }

  /**
   * Advance animations. `carriage(robotId)` returns the current carriage frame;
   * `attach` is called when an intake/index motion completes.
   */
  stepAnimations(t: number, carriage: (robotId: string) => CarriageFrame | null, attach: (obj: SimObject) => void) {
    // a pair tipped past 35° comes apart (the top piece falls off)
    for (const obj of this.objects.values()) if (obj.bond && obj.body && Math.abs(upOf(obj.body.rotation()).y) < 0.82) this.unbond(obj);
    for (const obj of this.objects.values()) {
      const a = obj.anim;
      if (!a || !obj.body) continue;
      const u = Math.min(1, (t - a.t0) / a.dur);
      const s = u * u * (3 - 2 * u);
      const lp = { x: a.from.p.x + (a.to.p.x - a.from.p.x) * s, y: a.from.p.y + (a.to.p.y - a.from.p.y) * s, z: a.from.p.z + (a.to.p.z - a.from.p.z) * s };
      const lq = slerp(a.from.q, a.to.q, s);
      let wp = lp;
      let wq = lq;
      if (a.frame === 'carriage') {
        const f = obj.robotId ? carriage(obj.robotId) : null;
        if (!f) continue;
        const w = ObjectManager.toWorldPose(f, lp, lq);
        wp = w.p;
        wq = w.q;
      }
      obj.body.setNextKinematicTranslation(wp);
      obj.body.setNextKinematicRotation(wq);
      if (u >= 1) {
        if (a.then === 'stacked') {
          const st = this.stacks.get(obj.stack?.goalId ?? '')!;
          obj.anim = undefined;
          obj.body.setTranslation(wp, true);
          obj.body.setRotation(wq, true);
          this.finishSeat(obj, st);
        } else {
          obj.anim = undefined;
          attach(obj);
        }
      }
    }
  }

  /**
   * Funnel capture: a free object that physically arrives over a stack, aligned
   * within tolerance and at the right height, is guided onto it.
   */
  detectSeating(t: number): SeatEvent[] {
    const out: SeatEvent[] = [];
    for (const obj of this.objects.values()) {
      if (obj.mode !== 'free' || !obj.body) continue;
      const b = obj.body;
      const p = b.translation();
      const v = b.linvel();
      if (v.y > 0.25) continue; // moving up (being thrown) — no capture
      const up = upOf(b.rotation());
      const tilt = Math.acos(Math.min(1, Math.abs(up.y)));
      if (tilt > (this.funnel.maxTiltDeg * Math.PI) / 180) continue;
      const L = halfLen(obj.kind);
      const bottomIn = (p.y - L * Math.abs(up.y)) / IN;
      for (const st of this.stacks.values()) {
        if (st.pending || this.nextKind(st) !== obj.kind) continue;
        const g = toWorld(st.goal.pos.x, st.goal.pos.y);
        const off = Math.hypot(p.x - g.x, p.z - g.z) / IN;
        if (off > this.captureRadius(obj)) continue;
        const seat = this.nextBottom(st);
        if (bottomIn < seat - this.funnel.below || bottomIn > seat + this.funnel.above) continue;
        // capture: guided down the funnel onto the axis, keeping which end is up
        this.unbond(obj);
        const flipped = up.y < 0;
        const yaw = headingOf(b.rotation());
        const target = this.seatPose(st, obj.kind, flipped, yaw);
        b.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
        setObjectGroups(obj, CG.held);
        const index = st.elements.length;
        obj.stack = { goalId: st.goal.id, index };
        const cur = { p: { x: p.x, y: p.y, z: p.z }, q: b.rotation() };
        const dist = Math.hypot(target.p.x - cur.p.x, target.p.y - cur.p.y, target.p.z - cur.p.z) / IN;
        obj.anim = { frame: 'world', from: cur, to: target, t0: t, dur: this.seatDuration * Math.min(2, 0.4 + dist / 2), then: 'stacked' };
        obj.mode = 'seating';
        st.pending = obj;
        const ev = { t, obj, goalId: st.goal.id, index, robotId: obj.robotId };
        out.push(ev);
        this.seatEvents.push(ev);
        break;
      }
    }
    return out;
  }

  /** Lateral distance (in) within which a Goal captures this object. */
  captureRadius(obj: SimObject): number {
    return obj.assist ? this.funnel.assistRadius : obj.kind === 'pin' ? this.funnel.pinRadius : this.funnel.cupRadius;
  }

  /** Remove the top element of a stack (descore by intake). */
  unstackTop(goalId: string): SimObject | null {
    const st = this.stacks.get(goalId);
    if (!st || !st.elements.length || st.pending) return null;
    const obj = st.elements.pop()!;
    obj.stack = undefined;
    obj.body!.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    return obj;
  }

  /** Release from a holder: dynamic again, falls under gravity. */
  release(obj: SimObject, t: number, assist = false) {
    if (obj.joint) {
      this.world.removeImpulseJoint(obj.joint, true);
      obj.joint = null;
    }
    const b = obj.body!;
    b.setBodyType(this.R.RigidBodyType.Dynamic, true);
    setObjectGroups(obj, CG.free);
    obj.mode = 'free';
    obj.pocket = undefined;
    obj.releasedAt = t;
    obj.assist = assist;
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
