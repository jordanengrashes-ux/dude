import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { IN } from '../../../core/units';
import { CLAW } from '../../../robot/claw';
import type { RobotConfig } from '../../../robot/config';
import { PALETTE, type MaterialLibrary } from './materials';
import { brainScreen, holeAlpha, licensePlate } from './textures';
import { DR4B_PIVOT_SPACING, DR4B_TOP_PIVOT_ABOVE_HOLDER, dr4bLayout } from '../../../robot/lift';

/**
 * Detailed robot model built from the RobotConfig, in the physics body frames:
 * chassis frame (+X forward, +Y up, −Z = robot left, origin on the ground at the
 * chassis center) and carriage frame (origin on the holder axis at the holder's
 * lowest point). Structure follows common VEX V5 construction: 1×2×1 C-channel
 * with the 0.5" hole pattern, 3.25" wheels between inner and outer rails, V5 Smart
 * Motors with cartridge-colored caps, Brain, battery, the lift (a DR4B linkage
 * animated from the bar angle, with 84T/12T gearing and rubber bands, or a tower
 * rack with a carriage pinion), the toggle arm on a standoff and alliance license
 * plates. Dimensions not in the
 * config (motor size, channel gauge) are typical V5 values.
 */

const CARTRIDGE_COLORS: Record<number, string> = { 100: '#d9302c', 200: '#2fa34a', 600: '#2d6fd6' };

/** C-channel (web + two flanges) along X, `len` long, web height `h` (vertical web at local z = 0, flanges toward +z·dir). */
function cChannel(len: number, h: number, flange: number, dir: 1 | -1, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const t = 0.046; // 0.046" aluminum
  const web = new THREE.Mesh(new THREE.BoxGeometry(len * IN, h * IN, t * IN), mat);
  g.add(web);
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(len * IN, t * IN, flange * IN), mat);
    f.position.set(0, ((s * (h - t)) / 2) * IN, ((dir * flange) / 2) * IN);
    g.add(f);
  }
  return g;
}

/** Spur gear with `teeth` teeth (pitch diameter in inches), axis along Z. */
function gearGeometry(pitchD: number, teeth: number, width: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry((pitchD / 2 - 0.05) * IN, (pitchD / 2 - 0.05) * IN, width * IN, 32);
  body.rotateX(Math.PI / 2);
  parts.push(body);
  for (let k = 0; k < teeth; k++) {
    const a = (k / teeth) * Math.PI * 2;
    const tooth = new THREE.BoxGeometry(0.1 * IN, ((Math.PI * pitchD) / teeth) * 0.5 * IN, width * IN);
    tooth.translate((pitchD / 2 + 0.02) * IN, 0, 0);
    tooth.rotateZ(a);
    parts.push(tooth);
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
}

/** Gear rack along Y: `len` long with teeth on +X. */
function rackGeometry(len: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(0.3 * IN, len * IN, 0.25 * IN).toNonIndexed()];
  const pitch = 0.157; // ~0.05 module-equivalent tooth spacing
  for (let y = -len / 2 + pitch / 2; y < len / 2; y += pitch) {
    const tooth = new THREE.BoxGeometry(0.09 * IN, pitch * 0.5 * IN, 0.25 * IN);
    tooth.translate(0.19 * IN, y * IN, 0);
    parts.push(tooth.toNonIndexed());
  }
  return mergeGeometries(parts);
}

function wheel(d: number, width: number, mats: MaterialLibrary): THREE.Group {
  const g = new THREE.Group();
  const r = d / 2;
  // tire: rounded shoulders and three tread grooves
  const prof: [number, number][] = [
    [r - 0.35, -width / 2],
    [r - 0.08, -width / 2],
    [r, -width / 2 + 0.1],
  ];
  const grooves = 3;
  for (let k = 1; k <= grooves; k++) {
    const y = -width / 2 + (k * width) / (grooves + 1);
    prof.push([r, y - 0.05], [r - 0.06, y - 0.03], [r - 0.06, y + 0.03], [r, y + 0.05]);
  }
  prof.push([r, width / 2 - 0.1], [r - 0.08, width / 2], [r - 0.35, width / 2]);
  const tire = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a * IN, b * IN)), 40), mats.rubber);
  g.add(tire);
  // hub with spokes
  const hub = new THREE.Mesh(new THREE.CylinderGeometry((r - 0.35) * IN, (r - 0.35) * IN, (width - 0.1) * IN, 24, 1, true), mats.plastic('#2c2f33'));
  g.add(hub);
  const spokes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const s = new THREE.BoxGeometry((r - 0.45) * IN, (width * 0.5) * IN, 0.14 * IN);
    s.translate(((r - 0.45) / 2) * IN, 0, 0);
    s.rotateY((k / 6) * Math.PI * 2);
    spokes.push(s.toNonIndexed());
  }
  g.add(new THREE.Mesh(mergeGeometries(spokes), mats.plastic('#3a3e43')));
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * IN, 0.1 * IN, (width + 0.6) * IN, 8), mats.steel);
  g.add(axle);
  g.rotation.x = Math.PI / 2; // lathe axis (Y) → robot lateral axis (Z)
  return g;
}

function motor(mats: MaterialLibrary, rpm: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0 * IN, 1.6 * IN, 1.3 * IN), mats.blackPlastic);
  g.add(body);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.42 * IN, 0.42 * IN, 0.06 * IN, 20), mats.plastic(CARTRIDGE_COLORS[rpm] ?? '#888888'));
  cap.rotation.x = Math.PI / 2;
  cap.position.set(0.35 * IN, 0, 0.66 * IN);
  g.add(cap);
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.35 * IN, 0.25 * IN, 0.05 * IN), mats.plastic('#5a5e63'));
  port.position.set(-0.6 * IN, 0.45 * IN, 0.66 * IN);
  g.add(port);
  return g;
}

export interface RobotModel {
  chassis: THREE.Group;
  carriage: THREE.Group;
  /** Chassis length (in), front to back. */
  lengthIn: number;
  /** Holder bottom with the arm all the way down (in above the tiles). */
  holderMinIn: number;
  /** Rotate the lift pinion for a holder height above its minimum (in). */
  setLift(liftIn: number): void;
  /** Swing the claw jaws closed / open (eased over a few frames), spin the rollers (1 in, −1 out) and set the status light. */
  setClaw(closed: boolean, rollers?: number): void;
}

export function robotModel(id: string, alliance: 'red' | 'blue', cfg: RobotConfig, mats: MaterialLibrary): RobotModel {
  const c = cfg.chassis;
  const d = cfg.drivetrain;
  const chassis = new THREE.Group();
  const L = c.lengthIn;
  const W = c.widthIn;
  const holeMat = mats.aluminum.clone();
  const holes = holeAlpha();
  holes.repeat.set(L / 0.5, 2 / 0.5);
  holeMat.alphaMap = holes;
  holeMat.alphaTest = 0.5;
  holeMat.side = THREE.DoubleSide;
  const towerHole = mats.aluminum.clone();
  const th = holeAlpha();
  th.repeat.set(1 / 0.5, (c.towerHeightIn - c.frameHeightIn) / 0.5);
  towerHole.alphaMap = th;
  towerHole.alphaTest = 0.5;
  towerHole.side = THREE.DoubleSide;

  // ---- drivetrain sides: outer + inner C-channel, wheels and motors between. Each side
  // module spans from the claw slot to the outside, the block physics collides with
  const rw = d.wheelDiameterIn / 2;
  const axleY = rw;
  const sideRails = (sign: 1 | -1) => {
    const zOuter = sign * (W / 2 - 0.25);
    const zInner = sign * (c.slotWidthIn / 2 + 0.25);
    const h = 2;
    for (const [z, dir] of [
      [zOuter, -sign],
      [zInner, sign],
    ] as const) {
      const ch = cChannel(L, h, 0.5, dir as 1 | -1, holeMat);
      ch.rotation.x = 0;
      ch.position.set(0, axleY * IN, z * IN);
      chassis.add(ch);
    }
    for (const x of [d.wheelBaseIn / 2, -d.wheelBaseIn / 2]) {
      const wh = wheel(d.wheelDiameterIn, 1.0, mats);
      wh.position.set(x * IN, axleY * IN, ((sign * d.trackWidthIn) / 2) * IN);
      chassis.add(wh);
      const m = motor(mats, d.left.cartridgeRpm);
      m.position.set(x * 0.55 * IN, (axleY + 0.1) * IN, (zInner + sign * 0.9) * IN);
      if (sign < 0) m.rotation.y = Math.PI;
      chassis.add(m);
    }
    // license plate on the outer face
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(9 * IN, 2.25 * IN), new THREE.MeshStandardMaterial({ map: licensePlate(id, alliance), roughness: 0.6 }));
    plate.position.set(-1 * IN, (axleY + 0.35) * IN, (zOuter + sign * 0.06) * IN);
    if (sign < 0) plate.rotation.y = Math.PI;
    chassis.add(plate);
  };
  // robot left is −Z, right is +Z
  sideRails(-1);
  sideRails(1);

  // ---- cross members behind the slot and at the rear, base plate
  const slotBack = L / 2 - c.slotDepthIn;
  for (const x of [slotBack - 0.5, -L / 2 + 0.5]) {
    const ch = cChannel(W - 1, 2, 0.5, 1, holeMat);
    ch.rotation.y = Math.PI / 2;
    ch.position.set(x * IN, (axleY + 0.3) * IN, 0);
    chassis.add(ch);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry((slotBack + L / 2 - 1) * IN, 0.06 * IN, (d.trackWidthIn - 2.6) * IN), holeMat);
  deck.position.set(((slotBack - L / 2) / 2) * IN, (axleY + 1.35) * IN, 0);
  chassis.add(deck);

  // ---- Brain and battery on the deck
  const brain = new THREE.Group();
  const bb = new THREE.Mesh(new THREE.BoxGeometry(4.3 * IN, 1.2 * IN, 5.5 * IN), mats.blackPlastic);
  const scr = brainScreen(id.toUpperCase());
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.4 * IN, 2.2 * IN), new THREE.MeshStandardMaterial({ map: scr, emissive: '#ffffff', emissiveMap: scr, emissiveIntensity: 0.6, roughness: 0.2 }));
  screen.rotation.x = -Math.PI / 2;
  screen.rotation.z = Math.PI / 2;
  screen.position.y = 0.61 * IN;
  brain.add(bb, screen);
  brain.position.set((-L / 2 + 3) * IN, (axleY + 2.0) * IN, 1.4 * IN);
  chassis.add(brain);
  const battery = new THREE.Mesh(new THREE.BoxGeometry(2.3 * IN, 2.0 * IN, 5.6 * IN), mats.plastic('#25272a'));
  battery.position.set((-L / 2 + 3) * IN, (axleY + 2.5) * IN, -3.0 * IN);
  chassis.add(battery);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * IN, 3.5 * IN), mats.plastic('#b8202b'));
  label.rotation.x = -Math.PI / 2;
  label.position.set((-L / 2 + 3) * IN, (axleY + 3.51) * IN, -3.0 * IN);
  chassis.add(label);

  // ---- lift: towers flanking the slot, then either a DR4B linkage or a rack
  const towerX = slotBack - 0.75;
  const hx = cfg.intake.holderOffsetIn;
  const isDr4b = cfg.lift.type === 'dr4b';
  const sp = DR4B_PIVOT_SPACING;
  const lay0 = dr4bLayout(cfg, 0);
  const towerTop = isDr4b ? Math.max(c.towerHeightIn, lay0.baseY + sp + 0.75) : c.towerHeightIn;
  const towerH = towerTop - c.frameHeightIn;
  for (const s of [-1, 1]) {
    const ch = cChannel(towerH, 1, 0.5, s as 1 | -1, towerHole);
    ch.rotation.z = Math.PI / 2;
    ch.position.set(towerX * IN, (c.frameHeightIn + towerH / 2) * IN, s * (c.slotWidthIn / 2 + 0.5) * IN);
    chassis.add(ch);
  }
  const brace = new THREE.Mesh(new THREE.BoxGeometry(1 * IN, 0.5 * IN, (c.slotWidthIn + 2) * IN), mats.aluminum);
  brace.position.set((towerX - 0.6) * IN, (towerTop - 0.25) * IN, 0);
  chassis.add(brace);
  const rackZ = c.slotWidthIn / 2 + 1.2;
  const rackX = towerX + 0.9;
  let updateLift: (liftIn: number) => void = () => {};
  if (isDr4b) {
    // Two four-bar stages per side: lower bars pivot on the tower and rise backward to
    // the knee; the reversed upper bars rise forward to the carriage (robot/lift.ts).
    const Lb = cfg.lift.barLengthIn;
    const zLow = c.slotWidthIn / 2 + 1.15;
    const zUp = c.slotWidthIn / 2 + 1.75;
    const barGeo = new THREE.BoxGeometry((Lb + 0.7) * IN, 0.5 * IN, 0.18 * IN);
    const barMat = holeMat.clone();
    const bh = holeAlpha();
    bh.repeat.set((Lb + 0.7) / 0.5, 1);
    barMat.alphaMap = bh;
    const lower: { m: THREE.Mesh; off: number; side: number }[] = [];
    const upper: { m: THREE.Mesh; off: number; side: number }[] = [];
    const knees: THREE.Mesh[] = [];
    const gears: THREE.Mesh[] = [];
    const pinions: THREE.Mesh[] = [];
    const bands: THREE.Mesh[] = [];
    const bandGeo = new THREE.CylinderGeometry(0.06 * IN, 0.06 * IN, 1, 6);
    for (const side of [-1, 1]) {
      for (const off of [0, sp]) {
        const lm = new THREE.Mesh(barGeo, barMat);
        lower.push({ m: lm, off, side });
        chassis.add(lm);
        const um = new THREE.Mesh(barGeo, barMat);
        upper.push({ m: um, off: off + sp, side });
        chassis.add(um);
      }
      const knee = new THREE.Mesh(new THREE.BoxGeometry(0.9 * IN, (2 * sp + 0.9) * IN, 0.12 * IN), mats.aluminumDark);
      knees.push(knee);
      chassis.add(knee);
      // 84T gear on the lower bar, driven by a 12T pinion on the lift motor (1:7)
      const gear = new THREE.Mesh(gearGeometry(3.5, 84, 0.25), mats.plastic('#d7d9dc'));
      gear.position.set(towerX * IN, lay0.baseY * IN, side * (c.slotWidthIn / 2 + 0.25) * IN);
      gears.push(gear);
      chassis.add(gear);
      const pin = new THREE.Mesh(gearGeometry(0.5, 12, 0.25), mats.steel);
      pin.position.set((towerX - 2.0) * IN, lay0.baseY * IN, side * (c.slotWidthIn / 2 + 0.25) * IN);
      pinions.push(pin);
      chassis.add(pin);
      const lm = motor(mats, cfg.lift.motor.cartridgeRpm);
      lm.rotation.y = side > 0 ? 0 : Math.PI;
      lm.position.set((towerX - 2.35) * IN, (lay0.baseY - 0.1) * IN, side * (c.slotWidthIn / 2 - 0.5) * IN);
      chassis.add(lm);
      // rubber bands from the tower top to the knee (DR4Bs are rubber-band assisted)
      for (let k = 0; k < 2; k++) {
        const b = new THREE.Mesh(bandGeo, mats.plastic('#2a2a2a'));
        bands.push(b);
        chassis.add(b);
      }
    }
    const place = (m: THREE.Object3D, x0: number, y0: number, x1: number, y1: number, z: number) => {
      m.position.set(((x0 + x1) / 2) * IN, ((y0 + y1) / 2) * IN, z * IN);
      m.rotation.set(0, 0, Math.atan2(y1 - y0, x1 - x0));
    };
    updateLift = (liftIn: number) => {
      const lay = dr4bLayout(cfg, liftIn);
      const kx = towerX - lay.kneeBack;
      for (const b of lower) place(b.m, towerX, lay.baseY + b.off, kx, lay.kneeY + b.off, b.side * zLow);
      for (const b of upper) place(b.m, kx, lay.kneeY + b.off, towerX, lay.kneeY + b.off + Lb * Math.sin(lay.theta), b.side * zUp);
      knees.forEach((k, i) => k.position.set(kx * IN, (lay.kneeY + sp) * IN, (i ? 1 : -1) * ((zLow + zUp) / 2) * IN));
      const dTheta = lay.theta - lay0.theta;
      for (const g of gears) g.rotation.z = -dTheta;
      for (const p of pinions) p.rotation.z = dTheta / Math.abs(cfg.lift.motor.gearRatio || 1 / 7);
      bands.forEach((b, i) => {
        const side = i < 2 ? -1 : 1;
        const a = new THREE.Vector3(towerX * IN, (towerTop - 0.4 - (i % 2) * 0.6) * IN, side * zLow * IN);
        const bpt = new THREE.Vector3(kx * IN, (lay.kneeY + sp * 0.5 + (i % 2) * 0.6) * IN, side * zLow * IN);
        b.position.copy(a).add(bpt).multiplyScalar(0.5);
        b.scale.set(1, a.distanceTo(bpt), 1);
        b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bpt.clone().sub(a).normalize());
      });
    };
  } else {
    // gear rack fixed to the tower's front face, teeth toward the carriage
    const rack = new THREE.Mesh(rackGeometry(towerH), mats.plastic('#d7d9dc'));
    rack.position.set(rackX * IN, (c.frameHeightIn + towerH / 2) * IN, rackZ * IN);
    chassis.add(rack);
  }

  // ---- toggle arm: standoff at the tower, arm to reachIn past the bumper, rubber pad
  const ta = cfg.toggleArm;
  const armZ = -ta.lateralIn;
  const standoff = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * IN, 0.16 * IN, (ta.heightIn - c.frameHeightIn) * IN, 6), mats.aluminumDark);
  standoff.position.set(towerX * IN, ((ta.heightIn + c.frameHeightIn) / 2) * IN, armZ * IN);
  chassis.add(standoff);
  const armLen = L / 2 + ta.reachIn - towerX;
  const arm = cChannel(armLen, 0.5, 0.5, 1, mats.aluminum);
  arm.position.set((towerX + armLen / 2) * IN, ta.heightIn * IN, armZ * IN);
  chassis.add(arm);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.3 * IN, 0.6 * IN, 2.4 * IN), mats.rubber);
  pad.position.set((L / 2 + ta.reachIn - 0.15) * IN, ta.heightIn * IN, armZ * IN);
  chassis.add(pad);

  chassis.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  // ---- carriage (holder axis at x = 0): plate, bearing blocks, rack, fork with polycarbonate guards and a roller
  const carriage = new THREE.Group();
  const ch = cfg.lift.carriageHeightIn;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.15 * IN, ch * IN, 5.6 * IN), holeMat);
  plate.position.set(-2.35 * IN, (ch / 2) * IN, 0);
  carriage.add(plate);
  // roller claw: two jaws hinged behind the holder, each a pair of arms out to a vertical
  // shaft with three roller wheels (see robot/claw.ts); open, they swing out
  const jaws: { g: THREE.Group; side: number; shaft: THREE.Group }[] = [];
  const reach = Math.hypot(CLAW.shaftX - CLAW.hingeX, CLAW.shaftZ - CLAW.hingeZ);
  const splay = Math.atan2(CLAW.shaftZ - CLAW.hingeZ, CLAW.shaftX - CLAW.hingeX);
  const rollerMat = mats.plastic('#3fae5a');
  const shaftTop = CLAW.rollerHeights[CLAW.rollerHeights.length - 1] + 0.45;
  for (const s of [-1, 1]) {
    const jaw = new THREE.Group();
    jaw.position.set(CLAW.hingeX * IN, 0, s * CLAW.hingeZ * IN);
    const arms = new THREE.Group();
    arms.rotation.y = -s * splay;
    for (const y of [0.35, shaftTop - 0.1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(reach * IN, 0.25 * IN, 0.5 * IN), mats.aluminum);
      arm.position.set((reach / 2) * IN, y * IN, 0);
      arms.add(arm);
    }
    jaw.add(arms);
    // the shaft and its wheels sit at the arms' tip
    const shaft = new THREE.Group();
    shaft.position.set(reach * Math.cos(splay) * IN, 0, s * reach * Math.sin(splay) * IN);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * IN, 0.09 * IN, (shaftTop - 0.15) * IN, 8), mats.steel);
    rod.position.y = ((shaftTop + 0.15) / 2) * IN;
    shaft.add(rod);
    for (const h of CLAW.rollerHeights) {
      // a flex wheel: green hub with ribs so the spin shows
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(CLAW.rollerR * IN, CLAW.rollerR * IN, 0.55 * IN, 10), rollerMat);
      wheel.position.y = h * IN;
      shaft.add(wheel);
      for (let k = 0; k < 4; k++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.1 * IN, 0.57 * IN, 2 * CLAW.rollerR * IN + 0.02 * IN), mats.blackPlastic);
        rib.position.y = h * IN;
        rib.rotation.y = (k / 4) * Math.PI;
        shaft.add(rib);
      }
    }
    jaw.add(shaft);
    carriage.add(jaw);
    jaws.push({ g: jaw, side: s, shaft });
    // polycarbonate side guards behind the rollers
    const guard = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * IN, (ch - 0.4) * IN), mats.polycarbonate);
    guard.position.set(-1.3 * IN, (ch / 2) * IN, s * 1.95 * IN);
    carriage.add(guard);
  }
  if (isDr4b) {
    // side plates carrying the upper bars' carriage pivots, tied to the carriage plate
    const px = towerX - hx; // pivot column in the carriage frame
    const zUp = c.slotWidthIn / 2 + 1.75;
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(2.2 * IN, (DR4B_PIVOT_SPACING + 1.2) * IN, 0.12 * IN), mats.aluminumDark);
      side.position.set((px + 0.6) * IN, (DR4B_TOP_PIVOT_ABOVE_HOLDER + DR4B_PIVOT_SPACING / 2) * IN, s * (zUp - 0.2) * IN);
      carriage.add(side);
    }
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.5 * IN, 0.5 * IN, 2 * (zUp - 0.2) * IN), mats.aluminum);
    tie.position.set((px + 1.2) * IN, (DR4B_TOP_PIVOT_ABOVE_HOLDER + 0.25) * IN, 0);
    carriage.add(tie);
  } else {
    // pinion meshing with the tower rack, driven by the lift motor riding on the carriage
    const pitchD = cfg.lift.pinionPitchDiameterIn;
    const pinionX = rackX + 0.19 + 0.045 + pitchD / 2 - 0.05 - hx; // carriage frame
    const pinion = new THREE.Mesh(gearGeometry(pitchD, 12, 0.25), mats.steel);
    pinion.position.set(pinionX * IN, (ch / 2) * IN, rackZ * IN);
    carriage.add(pinion);
    const liftMotor = motor(mats, cfg.lift.motor.cartridgeRpm);
    liftMotor.position.set(pinionX * IN, (ch / 2) * IN, (rackZ + 0.95) * IN);
    carriage.add(liftMotor);
    for (const s of [-1, 1]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.7 * IN, 1.2 * IN, 0.6 * IN), mats.blackPlastic);
      block.position.set(-2.65 * IN, (ch / 2) * IN, s * (c.slotWidthIn / 2 + 0.5) * IN);
      carriage.add(block);
    }
    updateLift = (liftIn: number) => {
      pinion.rotation.z = -liftIn / (pitchD / 2);
    };
  }
  const accent = new THREE.Mesh(new THREE.BoxGeometry(0.2 * IN, 0.5 * IN, 5.6 * IN), mats.plastic(alliance === 'red' ? PALETTE.red : PALETTE.blue));
  accent.position.set(-2.25 * IN, (ch - 0.25) * IN, 0);
  carriage.add(accent);
  // claw status light: green = closed, amber = open
  const ledMat = new THREE.MeshBasicMaterial({ color: '#ffb020', toneMapped: false });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.32 * IN, 12, 8), ledMat);
  led.position.set(-2.25 * IN, (ch + 0.15) * IN, 0);
  carriage.add(led);
  let jawOpen = 1; // 0 closed … 1 open
  let spin = 0;
  let last = performance.now();
  const setClaw = (closed: boolean, rollers = 0) => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    jawOpen += ((closed ? 0 : 1) - jawOpen) * 0.35;
    for (const j of jaws) j.g.rotation.y = -j.side * 0.14 * jawOpen; // 8° out frees a piece (the rollers grip it at its rim)
    // in: each shaft's inner face moves back toward the holder; out: the other way
    spin += rollers * dt * (CLAW.surfaceSpeed / CLAW.rollerR);
    for (const j of jaws) j.shaft.rotation.y = j.side * spin;
    ledMat.color.set(closed ? '#39d353' : '#ffb020');
  };
  carriage.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });

  updateLift(0);
  chassis.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  setClaw(false);
  return {
    chassis,
    carriage,
    lengthIn: L,
    holderMinIn: cfg.lift.holderMinHeightIn,
    setLift: updateLift,
    setClaw,
  };
}
