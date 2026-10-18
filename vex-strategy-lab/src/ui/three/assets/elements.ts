import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { IN } from '../../../core/units';
import { CUP, GOAL_SOCKET, HALF, LOADER, PERIMETER_HEIGHT, PERIMETER_THICKNESS, PIN, socketLift, TILE, type GoalGeom, type LoaderGeom, type ToggleGeom } from '../../../field/geometry';
import { toggleSection } from '../../../physics/field';
import { toWorld } from '../../../physics/frames';
import { PALETTE, type MaterialLibrary } from './materials';

/**
 * Procedural models of the Override field and game elements, built from the same
 * dimensions the physics uses (Pin: 6.5", 3.0" ridge tapering to 1.3" tips; Cup:
 * 6.5" hourglass, 3.15" rims; Goal sockets at 3.25 / 5.8 / 8.7"; 25.8" Toggle bars;
 * 11.5" walls). Fine details (edge
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
 * Pin's tip (+1: +Y end, the middle ridge at −Y). Turned from PIN.profile: the 3.0"
 * ridge, the taper, and a rounded 1.3" tip.
 */
export function pinHalfGeometry(outer: 1 | -1): THREE.BufferGeometry {
  const H = PIN.half / 2;
  const prof: [number, number][] = [[0, -H], ...PIN.profile.map(([r, d]) => [r, d - H] as [number, number])];
  const [rt] = PIN.profile[PIN.profile.length - 1];
  prof.push([rt - 0.1, H], [0, H]);
  return lathe(prof, 40, outer === -1);
}

// ---------------------------------------------------------------- Cups

/**
 * One Cup half (3.25"), centered on its own midpoint, open end at `outer`: a conical
 * shell from the 3.15" rim (rolled lip) to the 1.9" waist, closed by its share of
 * the middle web. A Pin half nests inside with its ridge on the rim.
 */
export function cupHalfGeometry(outer: 1 | -1, _ledge: boolean): THREE.BufferGeometry {
  const H = CUP.half / 2;
  const ro = CUP.diameter / 2;
  const rw = CUP.waistDiameter / 2;
  const t = CUP.wall;
  const prof: [number, number][] = [
    [0, -H + CUP.web],
    [rw - t, -H + CUP.web],
    [ro - t, H - 0.03],
    [ro - t + 0.03, H],
    [ro + 0.03, H - 0.02],
    [ro + 0.04, H - 0.1],
    [ro, H - 0.17],
    [rw, -H],
    [0, -H],
  ];
  return lathe(prof, 48, outer === -1);
}

// ---------------------------------------------------------------- Goals

/**
 * Goal: octagonal column on a powder-coated Field Element Plate. The column's
 * inradius equals the physics post radius; it flares into a hollow conical socket
 * (the physics socket colliders) that the first Pin's lower half drops into.
 */
export function goalModel(g: GoalGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const oct = 1 / Math.cos(Math.PI / 8);
  const rc = g.postRadius * oct; // circumradius from the inradius
  const plateR = g.baseRadius * oct;
  const plateT = 0.19;
  const H = g.height;
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
  // octagonal column with a base flange, up to where the socket flares out
  const flare = Math.max(plateT + 0.3, H - GOAL_SOCKET.depth - 0.1);
  const prof: [number, number][] = [
    [rc + 0.32, plateT],
    [rc + 0.32, plateT + 0.22],
    [rc + 0.04, plateT + 0.36],
    [rc, plateT + 0.42],
    [rc, flare],
    [0, flare],
  ];
  const col = new THREE.Mesh(lathe(prof, 8), colMat);
  col.rotation.y = Math.PI / 8;
  grp.add(col);
  // round conical socket on top, the same bore as the physics (physics/elementShapes.ts):
  // it follows the first Pin's cone, which drops in until its band sits on the rim
  const prof0 = PIN.profile;
  const rIn = prof0[2][0] + GOAL_SOCKET.clearance;
  const rOut = rIn + GOAL_SOCKET.rimWidth;
  const socketBottom = Math.max(GOAL_SOCKET.plate, H + socketLift() - PIN.half - 0.08);
  const rb = prof0[prof0.length - 1][0] + GOAL_SOCKET.clearance;
  const sockMat = mats.plastic(colColor);
  const socket = new THREE.Mesh(
    lathe(
      [
        [g.postRadius, flare],
        [rOut, H - 0.07],
        [rOut - 0.05, H],
        [rIn + 0.03, H],
        [rIn, H - 0.04],
        [rb, socketBottom],
        [0, socketBottom],
      ],
      40,
    ),
    sockMat,
  );
  grp.add(socket);
  // dark socket floor so the bore reads as a hole
  const floor = new THREE.Mesh(new THREE.CircleGeometry(rb * IN, 24), mats.blackPlastic);
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

/**
 * Wall Loader: a clear tube the Drive Team drops Match Loads into, standing against
 * the Alliance Station wall on two aluminum side posts, with an alliance-colored
 * funnel on top and the opening at the bottom facing the field. Body footprint and
 * tube size from Appendix A; the funnel and posts are approximate.
 */
export function loaderModel(l: LoaderGeom, mats: MaterialLibrary): THREE.Group {
  const grp = new THREE.Group();
  const D = l.halfSize.x * 2;
  const W = l.halfSize.y * 2;
  const Hh = l.height;
  const open = LOADER.openingHeight;
  const tubeR = LOADER.tubeDiameter / 2 + 0.06;
  const allianceCol = l.alliance === 'red' ? PALETTE.red : PALETTE.blue;
  const at = (x: number, y: number, z: number) => toWorld(l.pos.x + x, l.pos.y + y, z);
  // side posts either side of the opening, and a back plate against the wall
  const post = new THREE.BoxGeometry(D * IN, Hh * IN, 0.35 * IN);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(post, mats.aluminum);
    const w = at(0, s * (W / 2 - 0.175), Hh / 2);
    m.position.set(w.x, w.y, w.z);
    grp.add(m);
  }
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.2 * IN, Hh * IN, W * IN), mats.powderCoat);
  const bw = toWorld(l.wall.x - l.outward.x * 0.1, l.wall.y, Hh / 2);
  back.position.set(bw.x, bw.y, bw.z);
  grp.add(back);
  // the tube from the top of the opening up
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(tubeR * IN, tubeR * IN, (Hh - open) * IN, 24, 1, true), mats.polycarbonate);
  const tw = at(0, 0, (Hh + open) / 2);
  tube.position.set(tw.x, tw.y, tw.z);
  grp.add(tube);
  // funnel on top and a colored band at the opening
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry((tubeR + 1.2) * IN, tubeR * IN, 2 * IN, 24, 1, true), mats.plastic(allianceCol));
  (funnel.material as THREE.Material).side = THREE.DoubleSide;
  const fw = at(0, 0, Hh + 1);
  funnel.position.set(fw.x, fw.y, fw.z);
  grp.add(funnel);
  const band = new THREE.Mesh(new THREE.BoxGeometry(D * IN, 0.4 * IN, W * IN), mats.plastic(allianceCol));
  const nw = at(0, 0, open + 0.2);
  band.position.set(nw.x, nw.y, nw.z);
  grp.add(band);
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
