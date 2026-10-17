import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { G as GRAV, IN, LB } from '../core/units';
import type { Vec2 } from '../core/vec';
import type { RobotConfig } from '../robot/config';
import { groupFreeSpeed, groupTorque, utilization } from '../robot/motor';
import { liftMovingMassLb, liftRadius, liftTravel } from '../robot/lift';
import type { Alliance } from '../rules/ruleset';
import { CG, fromWorld, headingOf, quatMul, rotateV, toWorld, yawQuat, type Quat, type V3 } from './frames';
import type { Rapier } from './rapier';

/**
 * A physical robot:
 *  - chassis: one rigid body with a U-shaped compound collider (two side rails,
 *    rear cross member, lift tower) and the configured mass / center of mass;
 *  - four wheel contact spheres (frictionless) that carry the normal load;
 *  - a tire model applied at each wheel contact point every step:
 *      longitudinal force from the V5 motor curve (back-EMF from ground speed),
 *      clamped by μ_long·N (static) and dropping to the kinetic value when it slips;
 *      lateral force cancelling sideways sliding, clamped by μ_lat·N;
 *      rolling resistance;
 *    N comes from the actual contact impulses, so load transfer, wheel lift-off
 *    and tipping emerge from the rigid-body dynamics;
 *  - the lift: the end effector moves straight up for both mechanisms, so it is a
 *    carriage body on a prismatic joint with travel limits, driven by a motor force
 *    F = τ(ω)/r(h). For a DR4B r(h) = 2L·cos θ(h) changes along the travel
 *    (robot/lift.ts); for a rack and pinion it is the pinion radius. The carriage
 *    carries the end effector plus the bars' equivalent mass and the payload.
 */

export interface DriveCommand {
  left: number;
  right: number;
}

export interface WheelState {
  load: number;
  slipping: boolean;
  forceLong: number;
  forceLat: number;
  inContact: boolean;
}

export interface RobotTelemetry {
  speed: number;
  yawRate: number;
  accel: number;
  utilLeft: number;
  utilRight: number;
  utilLift: number;
  liftHeight: number;
  slipping: number;
  tilt: number;
}

export class RobotBody {
  readonly chassis: RigidBody;
  readonly carriage: RigidBody;
  readonly colliders: Collider[] = [];
  readonly carriageCollider: Collider;
  readonly wheelColliders: Collider[] = [];
  readonly lift: ImpulseJoint;
  readonly wheelPos: { x: number; lat: number; left: boolean }[];
  cmd: DriveCommand = { left: 0, right: 0 };
  liftTarget: number; // holder height target (in)
  liftManual: number | null = null; // manual command [-1, 1]
  wheels: WheelState[] = [];
  telemetry: RobotTelemetry = { speed: 0, yawRate: 0, accel: 0, utilLeft: 0, utilRight: 0, utilLift: 0, liftHeight: 0, slipping: 0, tilt: 0 };
  /** Performance scale factors (uncertainty sampling). */
  motorScale = 1;
  tractionScale = 1;
  private lastSpeed = 0;
  private payloadKg = 0;
  private lastVel = { x: 0, z: 0 };

  constructor(
    R: Rapier,
    private world: World,
    readonly id: string,
    readonly alliance: Alliance,
    readonly cfg: RobotConfig,
    start: { pos: Vec2; heading: number },
    private floor: Collider,
  ) {
    const c = cfg.chassis;
    const d = cfg.drivetrain;
    const rw = (d.wheelDiameterIn / 2) * IN;
    const L = c.lengthIn * IN;
    const W = c.widthIn * IN;
    const railW = ((c.widthIn - c.slotWidthIn) / 2) * IN;
    const clear = c.groundClearanceIn * IN;
    const frameH = c.frameHeightIn * IN;
    const p0 = toWorld(start.pos.x, start.pos.y, 0);
    const q0 = yawQuat(start.heading);
    const massTotal = cfg.mass.totalLb * LB;
    const mCarriage = liftMovingMassLb(cfg) * LB;
    const mChassis = Math.max(0.5, massTotal - mCarriage);
    const H = c.towerHeightIn * IN;
    const com = { x: cfg.mass.comOffsetXIn * IN, y: cfg.mass.comHeightIn * IN, z: -cfg.mass.comOffsetYIn * IN };
    const inertia = {
      x: (mChassis * (W * W + (0.6 * H) ** 2)) / 12,
      y: (mChassis * (L * L + W * W)) / 12,
      z: (mChassis * (L * L + (0.6 * H) ** 2)) / 12,
    };
    this.chassis = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(p0.x, p0.y + 0.002, p0.z)
        .setRotation(q0)
        .setAdditionalMassProperties(mChassis, com, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setCcdEnabled(true)
        .setAngularDamping(0.5)
        .setLinearDamping(0.02),
    );
    const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => {
      const col = world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setDensity(0).setFriction(0.4).setRestitution(0.05).setCollisionGroups(CG.robot),
        this.chassis,
      );
      this.colliders.push(col);
      return col;
    };
    const railHalfH = (frameH - clear) / 2;
    const railY = clear + railHalfH;
    // side rails (local −Z = robot left)
    box(0, railY, -(W / 2 - railW / 2), L / 2, railHalfH, railW / 2);
    box(0, railY, W / 2 - railW / 2, L / 2, railHalfH, railW / 2);
    // rear cross member behind the slot
    const slotD = c.slotDepthIn * IN;
    const rearLen = L - slotD;
    box(-L / 2 + rearLen / 2, railY, 0, rearLen / 2, railHalfH, (c.slotWidthIn * IN) / 2);
    // lift tower just behind the slot
    const towerX = L / 2 - slotD - 0.75 * IN;
    box(towerX, frameH + (H - frameH) / 2, 0, 0.75 * IN, (H - frameH) / 2, (c.slotWidthIn * IN) / 2 + 0.5 * IN);
    // toggle arm: a paddle on a side standoff, high enough to reach over the wall top
    const ta = cfg.toggleArm;
    const armBack = towerX;
    const armFront = L / 2 + ta.reachIn * IN;
    box((armBack + armFront) / 2, ta.heightIn * IN, -ta.lateralIn * IN, (armFront - armBack) / 2, 0.25 * IN, 1.25 * IN);

    // wheel spheres
    this.wheelPos = [
      { x: (d.wheelBaseIn / 2) * IN, lat: (d.trackWidthIn / 2) * IN, left: true },
      { x: (-d.wheelBaseIn / 2) * IN, lat: (d.trackWidthIn / 2) * IN, left: true },
      { x: (d.wheelBaseIn / 2) * IN, lat: (-d.trackWidthIn / 2) * IN, left: false },
      { x: (-d.wheelBaseIn / 2) * IN, lat: (-d.trackWidthIn / 2) * IN, left: false },
    ];
    for (const wp of this.wheelPos) {
      const col = world.createCollider(
        R.ColliderDesc.ball(rw)
          .setTranslation(wp.x, rw, -wp.lat)
          .setDensity(0)
          .setFriction(0)
          .setFrictionCombineRule(R.CoefficientCombineRule.Min)
          .setRestitution(0)
          .setCollisionGroups(CG.wheel),
        this.chassis,
      );
      this.wheelColliders.push(col);
      this.wheels.push({ load: 0, slipping: false, forceLong: 0, forceLat: 0, inContact: true });
    }

    // lift carriage on a prismatic joint
    const hx = cfg.intake.holderOffsetIn * IN;
    const hMin = cfg.lift.holderMinHeightIn * IN;
    const anchorW = rotateV(q0, { x: hx, y: hMin, z: 0 });
    this.carriage = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(p0.x + anchorW.x, p0.y + anchorW.y + 0.002, p0.z + anchorW.z)
        .setRotation(q0)
        .setAdditionalMassProperties(mCarriage, { x: -2.35 * IN, y: (cfg.lift.carriageHeightIn / 2) * IN, z: 0 }, { x: 1e-3, y: 1e-3, z: 1e-3 }, { x: 0, y: 0, z: 0, w: 1 })
        .setCcdEnabled(true),
    );
    this.carriageCollider = world.createCollider(
      R.ColliderDesc.cuboid(0.25 * IN, (cfg.lift.carriageHeightIn / 2) * IN, 2.5 * IN)
        .setTranslation(-2.35 * IN, (cfg.lift.carriageHeightIn / 2) * IN, 0)
        .setDensity(0)
        .setCollisionGroups(CG.robot),
      this.carriage,
    );
    const jd = R.JointData.prismatic({ x: hx, y: hMin, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    jd.limitsEnabled = true;
    jd.limits = [0, liftTravel(cfg) * IN];
    this.lift = world.createImpulseJoint(jd, this.chassis, this.carriage, true);
    this.lift.setContactsEnabled(false);
    this.liftTarget = cfg.lift.holderMinHeightIn;
  }

  /** Pose in game coordinates (inches, radians). */
  pose(): { pos: Vec2; heading: number; z: number } {
    const t = this.chassis.translation();
    const g = fromWorld(t);
    return { pos: { x: g.x, y: g.y }, heading: headingOf(this.chassis.rotation()), z: g.z };
  }

  /** Lift displacement (m) along the chassis up axis and its rate. */
  liftState(): { d: number; v: number } {
    const q = this.chassis.rotation();
    const hx = this.cfg.intake.holderOffsetIn * IN;
    const hMin = this.cfg.lift.holderMinHeightIn * IN;
    const ct = this.chassis.translation();
    const a = rotateV(q, { x: hx, y: hMin, z: 0 });
    const anchor = { x: ct.x + a.x, y: ct.y + a.y, z: ct.z + a.z };
    const up = rotateV(q, { x: 0, y: 1, z: 0 });
    const cp = this.carriage.translation();
    const d = (cp.x - anchor.x) * up.x + (cp.y - anchor.y) * up.y + (cp.z - anchor.z) * up.z;
    const va = this.chassis.velocityAtPoint(anchor);
    const vc = this.carriage.linvel();
    const v = (vc.x - va.x) * up.x + (vc.y - va.y) * up.y + (vc.z - va.z) * up.z;
    return { d, v };
  }

  /** Holder-bottom height above the tiles (inches). */
  holderHeight(): number {
    return this.carriage.translation().y / IN;
  }

  /** Carriage frame for held-object poses: origin on the holder axis at the holder bottom. */
  carriageFrame(): { p: V3; q: Quat } {
    const t = this.carriage.translation();
    const r = this.carriage.rotation();
    return { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  /** Combined center of mass of chassis + carriage (world, meters). */
  combinedCom(): V3 {
    const a = this.chassis.worldCom();
    const b = this.carriage.worldCom();
    const ma = this.chassis.mass();
    const mb = this.carriage.mass();
    const m = ma + mb || 1;
    return { x: (a.x * ma + b.x * mb) / m, y: (a.y * ma + b.y * mb) / m, z: (a.z * ma + b.z * mb) / m };
  }

  setPayload(kg: number) {
    if (Math.abs(kg - this.payloadKg) < 1e-9) return;
    this.payloadKg = kg;
    const m = liftMovingMassLb(this.cfg) * LB + kg;
    this.carriage.setAdditionalMassProperties(m, { x: -1.2 * IN, y: 3 * IN, z: 0 }, { x: 2e-3, y: 2e-3, z: 2e-3 }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  /** Apply drive and lift forces for one step of length dt. */
  applyForces(dt: number) {
    const cfg = this.cfg;
    const d = cfg.drivetrain;
    const rw = (d.wheelDiameterIn / 2) * IN;
    const q = this.chassis.rotation();
    const fwd = rotateV(q, { x: 1, y: 0, z: 0 });
    const left = rotateV(q, { x: 0, y: 0, z: -1 });
    const fh = norm2({ x: fwd.x, y: 0, z: fwd.z });
    const lh = norm2({ x: left.x, y: 0, z: left.z });
    const mPer = (cfg.mass.totalLb * LB) / 4;
    const vb = cfg.battery.voltage;
    const muX = d.muLongitudinal * this.tractionScale;
    const muY = d.muLateral * this.tractionScale;
    let tauL = 0;
    let tauR = 0;
    let slipCount = 0;
    const ct = this.chassis.translation();
    // ---- normal loads -------------------------------------------------------
    // Four contacts on a rigid plane are statically indeterminate, so solver
    // impulses cannot be used per wheel. Instead: static distribution from the
    // combined center of mass + longitudinal/lateral load transfer from the
    // measured acceleration, scaled so the total equals the support the solver
    // actually provided (captures bumps, being pushed down, tipping). A wheel whose
    // contact point is off the ground carries nothing.
    let measured = 0;
    for (const col of this.wheelColliders) {
      this.world.contactPair(col, this.floor, (m) => {
        for (let k = 0; k < m.numContacts(); k++) measured += m.contactImpulse(k);
      });
    }
    measured /= dt;
    const mTot = cfg.mass.totalLb * LB + this.payloadKg;
    const comW = this.combinedCom();
    const comL = rotateV({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, { x: comW.x - ct.x, y: comW.y - ct.y, z: comW.z - ct.z });
    const wb = d.wheelBaseIn * IN;
    const tw = d.trackWidthIn * IN;
    const lv0 = this.chassis.linvel();
    const aW = { x: (lv0.x - this.lastVel.x) / dt, z: (lv0.z - this.lastVel.z) / dt };
    this.lastVel = { x: lv0.x, z: lv0.z };
    const ax = aW.x * fh.x + aW.z * fh.z;
    const ay = aW.x * lh.x + aW.z * lh.z;
    const h = Math.max(0, comL.y);
    const fracFront = Math.min(1, Math.max(0, 0.5 + comL.x / wb - (ax * h) / (GRAV * wb)));
    const fracLeft = Math.min(1, Math.max(0, 0.5 + -comL.z / tw - (ay * h) / (GRAV * tw)));
    const share = this.wheelPos.map((wp) => (wp.x > 0 ? fracFront : 1 - fracFront) * (wp.left ? fracLeft : 1 - fracLeft));
    const grounded = this.wheelPos.map((wp) => {
      const c = this.chassisPoint({ x: wp.x, y: rw, z: -wp.lat });
      return c.y - rw < 0.004;
    });
    const shareSum = share.reduce((acc, x, i) => acc + (grounded[i] ? x : 0), 0);
    // The solver's summed contact impulse slightly over-reports support (penetration
    // correction); cap at the robot's weight, keep reductions (bumps, lift-off, tipping).
    const support = Math.min(measured, mTot * GRAV);
    this.wheelPos.forEach((wp, i) => {
      const N = grounded[i] && shareSum > 1e-6 ? (support * share[i]) / shareSum : 0;
      const w = this.wheels[i];
      w.load = N;
      w.inContact = grounded[i];
      const lp = rotateV(q, { x: wp.x, y: 0, z: -wp.lat });
      const p = { x: ct.x + lp.x, y: ct.y + lp.y, z: ct.z + lp.z };
      const v = this.chassis.velocityAtPoint(p);
      const vf = v.x * fh.x + v.z * fh.z;
      const vl = v.x * lh.x + v.z * lh.z;
      const group = wp.left ? d.left : d.right;
      // Wiring direction flips the command; the motor sees ground speed with the same sign
      // convention, so the wheel torque is the motor curve at (direction·command, ω).
      const u = (wp.left ? this.cmd.left : this.cmd.right) * group.direction;
      const perWheel = { ...group, motorCount: 1 };
      const tau = groupTorque(perWheel, u, vf / rw, vb, this.motorScale);
      if (wp.left) tauL += tau;
      else tauR += tau;
      let Fx = tau / rw;
      const lim = muX * N;
      w.slipping = false;
      if (Math.abs(Fx) > lim) {
        Fx = Math.sign(Fx) * lim * d.slipRatio;
        w.slipping = N > 1e-3;
      }
      if (w.slipping) slipCount++;
      const rr = Math.abs(vf) > 0.005 ? -Math.sign(vf) * d.rollingResistance * N : 0;
      let Fy = (-vl * mPer) / (2 * dt);
      const limY = muY * N;
      if (Math.abs(Fy) > limY) Fy = Math.sign(Fy) * limY;
      w.forceLong = Fx;
      w.forceLat = Fy;
      const F = { x: (Fx + rr) * fh.x + Fy * lh.x, y: 0, z: (Fx + rr) * fh.z + Fy * lh.z };
      this.chassis.applyImpulseAtPoint({ x: F.x * dt, y: 0, z: F.z * dt }, p, true);
    });

    // lift (DR4B or rack and pinion), through the height-dependent radius r(h)
    // The motor's force–speed slope (≈ F0/v_free) is stiff relative to the light
    // carriage, so the motor force is solved implicitly: the carriage velocity at the
    // end of the step satisfies m·Δv/dt = F0·(u − v'/v_free) − m·g_axis.
    const ls = this.liftState();
    const rp = liftRadius(cfg, Math.max(0, ls.d / IN)) * IN;
    const target = (this.liftTarget - cfg.lift.holderMinHeightIn) * IN;
    const mLift = liftMovingMassLb(cfg) * LB + this.payloadKg;
    const up = rotateV(q, { x: 0, y: 1, z: 0 });
    const F0 = groupTorque(cfg.lift.motor, 1, 0, vb, this.motorScale) / rp;
    const vFreeLift = groupFreeSpeed(cfg.lift.motor, vb) * rp;
    let u: number;
    if (this.liftManual !== null) u = this.liftManual;
    else {
      const err = target - ls.d;
      const ff = (mLift * GRAV * up.y) / Math.max(1e-6, F0);
      // position loop → velocity demand → voltage command
      const vDemand = Math.max(-vFreeLift, Math.min(vFreeLift, err * 25));
      u = Math.max(-1, Math.min(1, vDemand / Math.max(1e-6, vFreeLift) + ff + (vDemand - ls.v) * 0.8));
    }
    const vMax = groupFreeSpeed(cfg.lift.motor, cfg.battery.voltage) * rp;
    const uEff = u * (vMax > 0 ? 1 : 0);
    const gAxis = GRAV * up.y;
    let vNext = (mLift * (ls.v / dt) + F0 * uEff - mLift * gAxis) / (mLift / dt + F0 / Math.max(1e-6, vFreeLift));
    let F = F0 * (uEff - vNext / Math.max(1e-6, vFreeLift));
    if (Math.abs(F) > F0) {
      F = Math.sign(F) * F0;
      vNext = ls.v + (F / mLift - gAxis) * dt;
    }
    void vNext;
    const tauLift = F * rp;
    const imp = { x: up.x * F * dt, y: up.y * F * dt, z: up.z * F * dt };
    this.carriage.applyImpulse(imp, true);
    const cp = this.carriage.translation();
    this.chassis.applyImpulseAtPoint({ x: -imp.x, y: -imp.y, z: -imp.z }, cp, true);

    // telemetry
    const lv = this.chassis.linvel();
    const speed = (lv.x * fh.x + lv.z * fh.z) / IN;
    const av = this.chassis.angvel();
    this.telemetry = {
      speed,
      yawRate: av.y,
      accel: (speed - this.lastSpeed) / dt,
      utilLeft: utilization(d.left, tauL),
      utilRight: utilization(d.right, tauR),
      utilLift: utilization(cfg.lift.motor, tauLift),
      liftHeight: this.holderHeight(),
      slipping: slipCount,
      tilt: Math.acos(Math.max(-1, Math.min(1, up.y))),
    };
    this.lastSpeed = speed;
  }

  /** World point on the robot's front center at a given height (inches). */
  frontPoint(heightIn = 2): V3 {
    const q = this.chassis.rotation();
    const t = this.chassis.translation();
    const f = rotateV(q, { x: (this.cfg.chassis.lengthIn / 2) * IN, y: heightIn * IN, z: 0 });
    return { x: t.x + f.x, y: t.y + f.y, z: t.z + f.z };
  }

  /** Local-to-world for a point on the chassis. */
  chassisPoint(local: V3): V3 {
    const q = this.chassis.rotation();
    const t = this.chassis.translation();
    const r = rotateV(q, local);
    return { x: t.x + r.x, y: t.y + r.y, z: t.z + r.z };
  }

  /** Reset pose (scenario setup). */
  teleportForSetup(pos: Vec2, heading: number) {
    const p = toWorld(pos.x, pos.y, 0);
    const q = yawQuat(heading);
    this.chassis.setTranslation({ x: p.x, y: p.y + 0.002, z: p.z }, true);
    this.chassis.setRotation(q, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const a = rotateV(q, { x: this.cfg.intake.holderOffsetIn * IN, y: this.cfg.lift.holderMinHeightIn * IN, z: 0 });
    this.carriage.setTranslation({ x: p.x + a.x, y: p.y + a.y + 0.002, z: p.z + a.z }, true);
    this.carriage.setRotation(quatMul(q, { x: 0, y: 0, z: 0, w: 1 }), true);
  }
}

function norm2(v: V3): V3 {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, y: 0, z: v.z / l };
}
