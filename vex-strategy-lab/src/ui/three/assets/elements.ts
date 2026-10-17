import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { IN } from '../../../core/units';
import { CUP, HALF, PERIMETER_HEIGHT, PERIMETER_THICKNESS, PIN, TILE, type GoalGeom, type LoaderGeom, type ToggleGeom } from '../../../field/geometry';
import { toggleSection } from '../../../physics/field';
import { toWorld } from '../../../physics/frames';
import { PALETTE, type MaterialLibrary } from './materials';

/**
 * Procedural models of the Override field and game elements, built from the same
 * dimensions the physics uses (Pin 1.6" × 6.5", Cup 3.15" × 6.5", Goal socket
 * heights 3.25 / 5.8 / 8.7", 25.8" Toggle bars, 11.5" walls). Fine details (edge
 * chamfers, lips, seams, brackets, bolt heads) are modeled for realism but are not
 * taken from official drawings; official CAD can replace any of these via
 * public/models/manifest.json (see docs/CAD.md).
 *
 * All geometry is in meters (world units), Y up.
 */

const v2 = (r: number, y: number) => new THREE.Vector2(r * IN, y * IN);

/** Lathe a profile given as [r, y] inches; `mirror` flips it end-for-end (keeping winding). */
function lathe(profile: [number, number][], segments: number, mirror = false): THREE.LatheGeometry {
  const pts = mirror ? profile.map(([r, y]) => [r, -y] as [number, number]).reverse() : profile;
  return new THREE.LatheGeometry(
    pts.map(([r, y]) => v2(r, y)),
    segments,
  );
}

// ---------------------------------------------------------------- Pins

/**
 * One Pin half (3.25"), centered on its own midpoint. `outer` = which end is the
 * Pin's end (+1: +Y end, the seam at −Y). Body Ø1.6", seam groove at the middle of
 * the Pin, chamfered end with a shallow recess.
 */
export function pinHalfGeometry(outer: 1 | -1): THREE.BufferGeometry {
  const R = PIN.diameter / 2;
  const H = PIN.half / 2;
  const prof: [number, number][] = [
    [0, -H],
    [R - 0.07, -H],
    [R - 0.07, -H + 0.04],
    [R - 0.015, -H + 0.1],
    [R, -H + 0.16],
    [R, H - 0.24],
    [R - 0.03, H - 0.13],
    [R - 0.14, H - 0.01],
    [R - 0.2, H],
    [0.36, H],
    [0.32, H - 0.05],
    [0, H - 0.05],
  ];
  return lathe(prof, 40, outer === -1);
}

// ---------------------------------------------------------------- Cups

/**
 * One Cup half (3.25"): a Ø3.15" polymer tube with a rolled lip at the open end.
 * The gray half carries the internal ledge at the Cup's midpoint where the Pins
 * below and above meet (the stack model seats both there).
 */
export function cupHalfGeometry(outer: 1 | -1, ledge: boolean): THREE.BufferGeometry {
  const R = CUP.diameter / 2;
  const Ri = R - 0.09;
  const H = CUP.half / 2;
  const prof: [number, number][] = [];
  if (ledge) prof.push([0.5, -H], [0.5, -H + 0.08], [Ri, -H + 0.08]);
  else prof.push([Ri, -H]);
  prof.push([Ri, H - 0.04], [R - 0.03, H], [R + 0.05, H - 0.03], [R + 0.06, H - 0.12], [R, H - 0.2], [R, -H]);
  if (ledge) prof.push([0.5, -H]);
  return lathe(prof, 48, outer === -1);
}

// ---------------------------------------------------------------- Goals

/**
 * Goal: octagonal column on a powder-coated Field Element Plate. The column's
 * inradius equals the physics post radius; a 3.25"-deep socket at the top receives
 * the first Pin (the physics seats it with its lower half inside).
 */
export function goalModel(g: GoalGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const oct = 1 / Math.cos(Math.PI / 8);
  const rc = g.postRadius * oct; // circumradius from the inradius
  const plateR = g.baseRadius * oct;
  const plateT = 0.19;
  const H = g.height;
  const bore = PIN.diameter / 2 + 0.06;
  const socketBottom = Math.max(plateT + 0.05, H - PIN.half);
  const colColor = g.type === 'alliance' ? (g.allianceColor === 'red' ? PALETTE.red : PALETTE.blue) : PALETTE.neutralGoal;
  const colMat = mats.plastic(colColor).clone();
  colMat.flatShading = true;
  // plate (octagon, slightly beveled)
  const plate = new THREE.Mesh(
    lathe(
      [
        [0, 0],
        [plateR - 0.06, 0],
        [plateR, 0.06],
        [plateR, plateT - 0.04],
        [plateR - 0.04, plateT],
        [0, plateT],
      ],
      8,
    ),
    mats.powderCoat,
  );
  plate.rotation.y = Math.PI / 8;
  grp.add(plate);
  // bolts on the plate
  const boltGeo = new THREE.CylinderGeometry(0.17 * IN, 0.17 * IN, 0.1 * IN, 6);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const r = (rc + plateR) / 2 + 0.2;
    if (r > plateR - 0.25) continue;
    const b = new THREE.Mesh(boltGeo, mats.bolt);
    b.position.set(Math.cos(a) * r * IN, (plateT + 0.05) * IN, Math.sin(a) * r * IN);
    grp.add(b);
  }
  // column with base flange, top collar, chamfered rim and socket bore
  const prof: [number, number][] = [
    [rc + 0.32, plateT],
    [rc + 0.32, plateT + 0.22],
    [rc + 0.04, plateT + 0.36],
    [rc, plateT + 0.42],
    [rc, Math.max(plateT + 0.5, H - 0.55)],
    [rc + 0.14, Math.max(plateT + 0.55, H - 0.45)],
    [rc + 0.14, H - 0.08],
    [rc + 0.06, H],
    [bore + 0.08, H],
    [bore, H - 0.08],
    [bore, socketBottom],
    [0, socketBottom],
  ];
  const col = new THREE.Mesh(lathe(prof, 8), colMat);
  col.rotation.y = Math.PI / 8;
  grp.add(col);
  // dark socket floor so the bore reads as a hole
  const floor = new THREE.Mesh(new THREE.CircleGeometry(bore * IN, 24), mats.blackPlastic);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = (socketBottom + 0.01) * IN;
  grp.add(floor);
  const p = toWorld(g.pos.x, g.pos.y);
  grp.position.set(p.x, 0, p.z);
  grp.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return grp;
}

// ---------------------------------------------------------------- Toggles

/**
 * The rotating Toggle bar in its physics body frame (+X into the field, +Y up,
 * +Z along the wall): three colored long faces (yellow toward the field at the
 * yellow detent, red on the bottom, blue outward), dark end caps and edge strips.
 */
export function toggleBarModel(tg: ToggleGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const sec = toggleSection(tg);
  const L = (tg.length / 2) * IN;
  const faceColors = [PALETTE.yellow, PALETTE.red, PALETTE.blue];
  const inset = 0.04; // faces sit slightly inside the edge strips
  const c = sec.reduce((a, [x, y]) => [a[0] + x / 3, a[1] + y / 3], [0, 0]);
  const shrink = ([x, y]: [number, number]) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const d = Math.hypot(dx, dy);
    return [x - (dx / d) * inset, y - (dy / d) * inset] as [number, number];
  };
  for (let k = 0; k < 3; k++) {
    const a = shrink(sec[k]);
    const b = shrink(sec[(k + 1) % 3]);
    const geo = new THREE.BufferGeometry();
    const P = [
      [a[0], a[1], -L / IN],
      [b[0], b[1], -L / IN],
      [b[0], b[1], L / IN],
      [a[0], a[1], L / IN],
    ].map(([x, y, z]) => [x * IN, y * IN, z * IN]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...P[0], ...P[1], ...P[2], ...P[0], ...P[2], ...P[3]], 3));
    geo.computeVertexNormals();
    // make sure the face normal points away from the bar's axis
    const nrm = geo.getAttribute('normal');
    const mid = [(a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1]];
    if (nrm.getX(0) * mid[0] + nrm.getY(0) * mid[1] < 0) {
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...P[0], ...P[2], ...P[1], ...P[0], ...P[3], ...P[2]], 3));
      geo.computeVertexNormals();
    }
    const m = new THREE.Mesh(geo, mats.plastic(faceColors[k]));
    grp.add(m);
  }
  // end caps
  const capShape = new THREE.Shape(sec.map(([x, y]) => new THREE.Vector2(x * IN, y * IN)));
  for (const z of [-L, L]) {
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(capShape), mats.blackPlastic);
    cap.position.z = z;
    if (z < 0) cap.rotation.y = Math.PI;
    if (z < 0) cap.scale.x = -1;
    grp.add(cap);
  }
  // rounded edge strips along the three long edges
  const edgeGeo = new THREE.CylinderGeometry(0.07 * IN, 0.07 * IN, 2 * L, 10);
  edgeGeo.rotateX(Math.PI / 2);
  for (const [x, y] of sec) {
    const e = new THREE.Mesh(edgeGeo, mats.blackPlastic);
    e.position.set(x * IN, y * IN, 0);
    grp.add(e);
  }
  grp.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return grp;
}

/** Static wall-top brackets holding a Toggle's axle (world frame). */
export function toggleMountModel(tg: ToggleGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const axisH = tg.pivotHeight;
  for (const s of [-1, 1]) {
    const along = s * (tg.length / 2 + 0.45);
    const base = { x: tg.pos.x + tg.normal.x * tg.axisOffset + tg.tangent.x * along, y: tg.pos.y + tg.normal.y * tg.axisOffset + tg.tangent.y * along };
    const w = toWorld(base.x, base.y);
    const yaw = Math.atan2(-tg.tangent.y, tg.tangent.x);
    const bracket = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.25 * IN, (axisH - PERIMETER_HEIGHT + 1.2) * IN, PERIMETER_THICKNESS * 1.1 * IN), mats.aluminumDark);
    plate.position.y = ((PERIMETER_HEIGHT + axisH + 1.2) / 2 - 0.6) * IN;
    plate.rotation.y = Math.PI / 2;
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * IN, 0.35 * IN, 0.4 * IN, 16), mats.steel);
    boss.rotation.x = Math.PI / 2;
    boss.position.y = axisH * IN;
    bracket.add(plate, boss);
    bracket.rotation.y = yaw + Math.PI / 2;
    bracket.position.set(w.x, 0, w.z);
    grp.add(bracket);
  }
  // axle through the bar
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.125 * IN, 0.125 * IN, (tg.length + 1.2) * IN, 10), mats.steel);
  const c = toWorld(tg.pos.x + tg.normal.x * tg.axisOffset, tg.pos.y + tg.normal.y * tg.axisOffset, tg.pivotHeight);
  axle.position.set(c.x, c.y, c.z);
  axle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(tg.tangent.x, 0, -tg.tangent.y));
  grp.add(axle);
  grp.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return grp;
}

// ---------------------------------------------------------------- Loaders

/** Corner Loader: aluminum frame, polycarbonate walls, alliance-colored rim and a chute toward the field. Approximate design. */
export function loaderModel(l: LoaderGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const F = l.footprint;
  const Hh = 12;
  const sx = Math.sign(l.corner.x);
  const sy = Math.sign(l.corner.y);
  const cx = l.corner.x - sx * (F / 2);
  const cy = l.corner.y - sy * (F / 2);
  const allianceCol = l.alliance === 'red' ? PALETTE.red : PALETTE.blue;
  const post = new THREE.BoxGeometry(0.5 * IN, Hh * IN, 0.5 * IN);
  for (const [dx, dy] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const m = new THREE.Mesh(post, mats.aluminum);
    const w = toWorld(cx + dx * (F / 2 - 0.25), cy + dy * (F / 2 - 0.25), Hh / 2);
    m.position.set(w.x, w.y, w.z);
    grp.add(m);
  }
  // polycarbonate walls on the two field-facing sides, alliance rim on top
  for (const [nx, ny] of [
    [-sx, 0],
    [0, -sy],
  ]) {
    const along = nx !== 0 ? 'y' : 'x';
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(F * IN, (Hh - 1) * IN), mats.polycarbonate);
    const w = toWorld(cx + nx * (F / 2), cy + ny * (F / 2), Hh / 2 + 0.5);
    panel.position.set(w.x, w.y, w.z);
    if (along === 'y') panel.rotation.y = Math.PI / 2;
    grp.add(panel);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(F * IN, 0.75 * IN, 0.3 * IN), mats.plastic(allianceCol));
    const r = toWorld(cx + nx * (F / 2), cy + ny * (F / 2), Hh - 0.375);
    rim.position.set(r.x, r.y, r.z);
    if (along === 'y') rim.rotation.y = Math.PI / 2;
    grp.add(rim);
  }
  // base plate
  const base = new THREE.Mesh(new THREE.BoxGeometry(F * IN, 0.25 * IN, F * IN), mats.powderCoat);
  const b = toWorld(cx, cy, 0.125);
  base.position.set(b.x, b.y, b.z);
  grp.add(base);
  // chute: a sloped tray from the box toward the dispense point
  const chuteLen = 5;
  const chute = new THREE.Mesh(new THREE.BoxGeometry(chuteLen * IN, 0.2 * IN, 3.6 * IN), mats.plastic(allianceCol));
  const mid = { x: l.corner.x + l.outward.x * (F * Math.SQRT2 + chuteLen / 2 - 1), y: l.corner.y + l.outward.y * (F * Math.SQRT2 + chuteLen / 2 - 1) };
  const cw = toWorld(mid.x, mid.y, 1.6);
  chute.position.set(cw.x, cw.y, cw.z);
  chute.rotation.y = Math.atan2(l.outward.y, l.outward.x);
  chute.rotateZ(-0.35);
  grp.add(chute);
  grp.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== mats.polycarbonate) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return grp;
}

// ---------------------------------------------------------------- Perimeter

/** Field perimeter: aluminum top/bottom rails and posts every tile, polycarbonate panels, corner posts. */
export function perimeterModel(mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const T = PERIMETER_THICKNESS;
  const H = PERIMETER_HEIGHT;
  const len = 2 * HALF + 2 * T;
  const railH = 1.0;
  const rails: THREE.BufferGeometry[] = [];
  const posts: THREE.BufferGeometry[] = [];
  const panels: THREE.BufferGeometry[] = [];
  for (const side of [0, 1, 2, 3]) {
    const rot = (side * Math.PI) / 2;
    const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      geo.translate(x * IN, y * IN, z * IN);
      geo.rotateY(rot);
      return geo;
    };
    const off = -(HALF + T / 2);
    rails.push(place(new THREE.BoxGeometry(len * IN, railH * IN, T * IN), 0, railH / 2, off));
    rails.push(place(new THREE.BoxGeometry(len * IN, railH * IN, T * IN), 0, H - railH / 2, off));
    for (let k = -3; k <= 3; k++) posts.push(place(new THREE.BoxGeometry(0.8 * IN, (H - 2 * railH) * IN, T * 0.8 * IN), k * TILE, H / 2, off));
    panels.push(place(new THREE.PlaneGeometry(2 * HALF * IN, (H - 2 * railH) * IN), 0, H / 2, -HALF - 0.1));
  }
  const railMesh = new THREE.Mesh(mergeGeometries(rails), mats.aluminum);
  const postMesh = new THREE.Mesh(mergeGeometries(posts), mats.aluminumDark);
  railMesh.castShadow = railMesh.receiveShadow = true;
  postMesh.castShadow = true;
  const panelMesh = new THREE.Mesh(mergeGeometries(panels), mats.polycarbonate);
  panelMesh.renderOrder = 2;
  grp.add(railMesh, postMesh, panelMesh);
  // corner posts
  for (const [x, z] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(T * 1.4 * IN, (H + 0.3) * IN, T * 1.4 * IN), mats.aluminumDark);
    c.position.set(x * (HALF + T / 2) * IN, ((H + 0.3) / 2) * IN, z * (HALF + T / 2) * IN);
    c.castShadow = true;
    grp.add(c);
  }
  return grp;
}
