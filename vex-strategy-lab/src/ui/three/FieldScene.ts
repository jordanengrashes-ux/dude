import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { IN } from '../../core/units';
import type { Vec2 } from '../../core/vec';
import { buildGoals, buildLoaders, buildToggles, CUP, HALF, LOAD_ZONE_SIZE, PERIMETER_HEIGHT, PERIMETER_THICKNESS, PIN, TAPE_WIDTH, TILE } from '../../field/geometry';
import type { RobotConfig } from '../../robot/config';
import type { MatchSim } from '../../sim/match';
import { toWorld } from '../../physics/frames';
import type { HalfColor } from '../../rules/ruleset';
import type { StepInfo } from '../../planner/model';
import type { CameraMode } from '../store';

/**
 * Three.js view of the simulation. Geometry is built from the same field model
 * the physics uses; every frame it copies body poses from the MatchSim snapshot.
 * Pins and Cups are drawn as instanced half-cylinders (one draw call per material).
 */

export const COLORS = {
  red: new THREE.Color('#d9534f'),
  blue: new THREE.Color('#3b82f6'),
  yellow: new THREE.Color('#e8c21b'),
  tile: new THREE.Color('#3a3b3d'),
  wall: new THREE.Color('#9aa0a6'),
  gray: new THREE.Color('#6b6e72'),
  white: new THREE.Color('#f2f2f2'),
};

const halfColor = (c: HalfColor) => (c === 'red' ? COLORS.red : c === 'blue' ? COLORS.blue : COLORS.yellow);

function fieldTexture(): THREE.CanvasTexture {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const s = px / (2 * HALF);
  const X = (x: number) => (x + HALF) * s;
  const Y = (y: number) => (HALF - y) * s;
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, px, px);
  // tiles
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      g.fillStyle = (i + j) % 2 ? '#3c3d40' : '#38393b';
      g.fillRect(i * TILE * s + 1, j * TILE * s + 1, TILE * s - 2, TILE * s - 2);
    }
  // load zones
  for (const l of buildLoaders()) {
    const sx = Math.sign(l.corner.x);
    const sy = Math.sign(l.corner.y);
    g.fillStyle = l.alliance === 'red' ? 'rgba(217,83,79,0.28)' : 'rgba(59,130,246,0.28)';
    g.fillRect(Math.min(X(sx * HALF), X(sx * (HALF - LOAD_ZONE_SIZE))), Math.min(Y(sy * HALF), Y(sy * (HALF - LOAD_ZONE_SIZE))), LOAD_ZONE_SIZE * s, LOAD_ZONE_SIZE * s);
  }
  // Autonomous Line: diagonals to the Midfield square, and the Midfield square
  g.strokeStyle = '#f2f2f2';
  g.lineWidth = TAPE_WIDTH * s;
  const M = TILE;
  g.beginPath();
  for (const [a, b] of [
    [-1, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
  ]) {
    g.moveTo(X(a * HALF), Y(b * HALF));
    g.lineTo(X(a * M), Y(b * M));
  }
  g.rect(X(-M), Y(M), 2 * M * s, 2 * M * s);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

export interface PickInfo {
  kind: 'object' | 'robot' | 'goal' | 'toggle';
  id: string;
}

export class FieldScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private pinHalves!: THREE.InstancedMesh;
  private cupClear!: THREE.InstancedMesh;
  private cupGray!: THREE.InstancedMesh;
  private robots = new Map<string, { chassis: THREE.Group; carriage: THREE.Group }>();
  private toggleMeshes = new Map<string, THREE.Mesh>();
  private objIndex: string[] = [];
  private routeGroup = new THREE.Group();
  private trailGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  private selectionRing: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private gridHelper: THREE.Group;
  private zoneGroup = new THREE.Group();
  private goalMeshes = new Map<string, THREE.Object3D>();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor('#0d0d0d');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.02, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#333333', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(1.5, 4, 2);
    this.scene.add(sun);
    this.buildField();
    this.buildObjects();
    this.scene.add(this.routeGroup, this.trailGroup, this.labelGroup, this.zoneGroup);
    this.selectionRing = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.006, 8, 32), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.selectionRing.rotation.x = Math.PI / 2;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);
    this.gridHelper = this.buildGrid();
    this.scene.add(this.gridHelper);
    this.setCamera('iso');
  }

  private buildGrid(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: '#7a7f86', transparent: true, opacity: 0.6 });
    for (let k = -3; k <= 3; k++) {
      const v = k * TILE * IN;
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v, 0.003, -HALF * IN), new THREE.Vector3(v, 0.003, HALF * IN)]), mat));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-HALF * IN, 0.003, v), new THREE.Vector3(HALF * IN, 0.003, v)]), mat));
    }
    for (let k = -3; k <= 3; k++) {
      const lbl = this.textSprite(`${(k * TILE).toFixed(0)}"`, '#c3c2b7', 0.06);
      lbl.position.set(k * TILE * IN, 0.01, (HALF + 3) * IN);
      g.add(lbl);
    }
    g.visible = false;
    return g;
  }

  private buildField() {
    const S = 2 * HALF * IN;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ map: fieldTexture(), roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(S + 1.2, S + 1.2), new THREE.MeshStandardMaterial({ color: '#141414' }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.002;
    this.scene.add(outer);
    const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, metalness: 0.4, roughness: 0.5 });
    const h = PERIMETER_HEIGHT * IN;
    const t = PERIMETER_THICKNESS * IN;
    for (const [x, z, w, d] of [
      [-(HALF * IN + t / 2), 0, t, S + 2 * t],
      [HALF * IN + t / 2, 0, t, S + 2 * t],
      [0, -(HALF * IN + t / 2), S, t],
      [0, HALF * IN + t / 2, S, t],
    ]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, h / 2, z);
      this.scene.add(m);
    }
    // alliance stations
    for (const [x, col] of [
      [-(HALF + 6) * IN, COLORS.red],
      [(HALF + 6) * IN, COLORS.blue],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.004, 1.6), new THREE.MeshBasicMaterial({ color: col }));
      m.position.set(x, 0.002, 0);
      this.scene.add(m);
    }
    // goals
    for (const g of buildGoals()) {
      const grp = new THREE.Group();
      const col = g.type === 'alliance' ? (g.allianceColor === 'red' ? COLORS.red : COLORS.blue) : g.type === 'midfield' ? new THREE.Color('#8a8d91') : new THREE.Color('#b9bcc0');
      const base = new THREE.Mesh(new THREE.CylinderGeometry(g.baseRadius * IN, g.baseRadius * IN, 0.5 * IN, 32), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }));
      base.position.y = 0.25 * IN;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(g.postRadius * IN, g.postRadius * IN, g.height * IN, 24, 1, true),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
      );
      post.position.y = (g.height / 2) * IN;
      grp.add(base, post);
      const p = toWorld(g.pos.x, g.pos.y);
      grp.position.set(p.x, 0, p.z);
      grp.userData.pick = { kind: 'goal', id: g.id } satisfies PickInfo;
      this.scene.add(grp);
      this.goalMeshes.set(g.id, grp);
      const lbl = this.textSprite(g.id.replace('G-', ''), '#f0efec', 0.05);
      lbl.position.set(p.x, (g.height + 9) * IN, p.z);
      this.labelGroup.add(lbl);
    }
    // loaders
    for (const l of buildLoaders()) {
      const F = l.footprint * IN;
      const m = new THREE.Mesh(new THREE.BoxGeometry(F, 12 * IN, F), new THREE.MeshStandardMaterial({ color: l.alliance === 'red' ? '#7a2e2c' : '#24477e', transparent: true, opacity: 0.85 }));
      const c = toWorld(l.corner.x - Math.sign(l.corner.x) * (l.footprint / 2), l.corner.y - Math.sign(l.corner.y) * (l.footprint / 2), 6);
      m.position.set(c.x, c.y, c.z);
      this.scene.add(m);
    }
    // toggles: triangular prism, cap split into three colored sectors (yellow up = 0°, red +120°, blue −120°)
    for (const tg of buildToggles()) {
      const r = (tg.size / Math.sqrt(3)) * IN;
      const th = 0.5 * IN;
      const geo = new THREE.BufferGeometry();
      const pos: number[] = [];
      const col: number[] = [];
      const vert = (k: number) => {
        const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
        return [r * Math.cos(a), r * Math.sin(a)];
      };
      const sectorColor = [COLORS.yellow, COLORS.red, COLORS.blue];
      for (const z of [-th, th]) {
        for (let k = 0; k < 3; k++) {
          // sector around vertex k: centroid, midpoint(k-1,k), vertex k, midpoint(k,k+1)
          const v = vert(k);
          const vp = vert((k + 2) % 3);
          const vn = vert((k + 1) % 3);
          const m1 = [(v[0] + vp[0]) / 2, (v[1] + vp[1]) / 2];
          const m2 = [(v[0] + vn[0]) / 2, (v[1] + vn[1]) / 2];
          for (const tri of [
            [[0, 0], m1, v],
            [[0, 0], v, m2],
          ]) {
            for (const p of tri) {
              pos.push(p[0], p[1], z);
              col.push(sectorColor[k].r, sectorColor[k].g, sectorColor[k].b);
            }
          }
        }
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.userData.pick = { kind: 'toggle', id: tg.id } satisfies PickInfo;
      this.scene.add(mesh);
      this.toggleMeshes.set(tg.id, mesh);
    }
  }

  private buildObjects() {
    const pinGeo = new THREE.CylinderGeometry((PIN.diameter / 2) * IN, (PIN.diameter / 2) * IN * 0.92, PIN.half * IN, 16);
    this.pinHalves = new THREE.InstancedMesh(pinGeo, new THREE.MeshStandardMaterial({ roughness: 0.5 }), 200);
    this.pinHalves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const cupGeo = new THREE.CylinderGeometry((CUP.diameter / 2) * IN, (CUP.diameter / 2) * IN, CUP.half * IN, 24, 1, true);
    this.cupClear = new THREE.InstancedMesh(cupGeo, new THREE.MeshStandardMaterial({ color: '#dfe7ef', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }), 120);
    this.cupGray = new THREE.InstancedMesh(cupGeo, new THREE.MeshStandardMaterial({ color: '#55585c', side: THREE.DoubleSide }), 120);
    this.scene.add(this.pinHalves, this.cupGray, this.cupClear);
  }

  private robotMesh(id: string, alliance: 'red' | 'blue', cfg: RobotConfig) {
    const c = cfg.chassis;
    const grp = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: '#b8bcc2', metalness: 0.6, roughness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: alliance === 'red' ? COLORS.red : COLORS.blue, roughness: 0.6 });
    const L = c.lengthIn * IN;
    const W = c.widthIn * IN;
    const railW = ((c.widthIn - c.slotWidthIn) / 2) * IN;
    const railH = (c.frameHeightIn - c.groundClearanceIn) * IN;
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(L, railH, railW), metal);
      rail.position.set(0, c.groundClearanceIn * IN + railH / 2, s * (W / 2 - railW / 2));
      grp.add(rail);
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(L * 0.9, 0.025, railW * 0.6), accent);
      bumper.position.set(-L * 0.02, c.frameHeightIn * IN + 0.012, s * (W / 2 - railW / 2));
      grp.add(bumper);
    }
    const rearLen = L - c.slotDepthIn * IN;
    const rear = new THREE.Mesh(new THREE.BoxGeometry(rearLen, railH, c.slotWidthIn * IN), metal);
    rear.position.set(-L / 2 + rearLen / 2, c.groundClearanceIn * IN + railH / 2, 0);
    grp.add(rear);
    const towerH = (c.towerHeightIn - c.frameHeightIn) * IN;
    const towerX = L / 2 - c.slotDepthIn * IN - 0.75 * IN;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.0 * IN, towerH, 0.5 * IN), metal);
      post.position.set(towerX, c.frameHeightIn * IN + towerH / 2, s * ((c.slotWidthIn / 2 + 0.5) * IN));
      grp.add(post);
    }
    // rack (visual)
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.4 * IN, towerH, 0.4 * IN), new THREE.MeshStandardMaterial({ color: '#d0a050' }));
    rack.position.set(towerX + 0.6 * IN, c.frameHeightIn * IN + towerH / 2, 0);
    grp.add(rack);
    const rw = (cfg.drivetrain.wheelDiameterIn / 2) * IN;
    const wheelGeo = new THREE.CylinderGeometry(rw, rw, 1.0 * IN, 20);
    const wheelMat = new THREE.MeshStandardMaterial({ color: '#202124', roughness: 0.9 });
    for (const [x, lat] of [
      [cfg.drivetrain.wheelBaseIn / 2, cfg.drivetrain.trackWidthIn / 2],
      [-cfg.drivetrain.wheelBaseIn / 2, cfg.drivetrain.trackWidthIn / 2],
      [cfg.drivetrain.wheelBaseIn / 2, -cfg.drivetrain.trackWidthIn / 2],
      [-cfg.drivetrain.wheelBaseIn / 2, -cfg.drivetrain.trackWidthIn / 2],
    ]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.x = Math.PI / 2;
      w.position.set(x * IN, rw, -lat * IN);
      grp.add(w);
    }
    grp.userData.pick = { kind: 'robot', id } satisfies PickInfo;
    // carriage (moves on the rack)
    const car = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5 * IN, cfg.rack.carriageHeightIn * IN, 5 * IN), new THREE.MeshStandardMaterial({ color: '#e0e0e0', metalness: 0.3 }));
    plate.position.set(-2.35 * IN, (cfg.rack.carriageHeightIn / 2) * IN, 0);
    car.add(plate);
    for (const s of [-1, 1]) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(2.6 * IN, 0.4 * IN, 0.3 * IN), accent);
      finger.position.set(-1.1 * IN, 1.0 * IN, s * 1.7 * IN);
      car.add(finger);
    }
    const lbl = this.textSprite(id, '#f0efec', 0.06);
    lbl.position.set(0, (c.towerHeightIn + 5) * IN, 0);
    grp.add(lbl);
    this.scene.add(grp, car);
    this.robots.set(id, { chassis: grp, carriage: car });
  }

  textSprite(text: string, color: string, height: number): THREE.Sprite {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const fs = 48;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    c.width = w;
    c.height = fs + 20;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(13,13,13,0.7)';
    ctx.fillRect(0, 0, w, c.height);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set((height * w) / c.height, height, 1);
    s.renderOrder = 10;
    return s;
  }

  setCamera(mode: CameraMode) {
    const c = this.camera;
    if (mode === 'overhead') c.position.set(0, 4.6, 0.001);
    else if (mode === 'iso') c.position.set(-2.4, 2.6, 2.9);
    else if (mode === 'side') c.position.set(0, 0.9, 4.2);
    this.controls.target.set(0, 0, 0);
    this.controls.enableRotate = true;
    this.controls.update();
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setVisibility(v: { labels: boolean; grid: boolean; route: boolean; trails: boolean; zones: boolean }) {
    this.labelGroup.visible = v.labels;
    this.gridHelper.visible = v.grid;
    this.routeGroup.visible = v.route;
    this.trailGroup.visible = v.trails;
    this.zoneGroup.visible = v.zones;
  }

  /** Planned route overlay: path polylines, numbered waypoints, pickup/scoring markers. */
  setRoute(steps: StepInfo[] | null, alliance: 'red' | 'blue') {
    this.routeGroup.clear();
    if (!steps) return;
    const col = alliance === 'red' ? '#ff8a80' : '#82b1ff';
    const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 });
    steps.forEach((s, i) => {
      if (s.path.length > 1) {
        const pts = s.path.map((p) => {
          const w = toWorld(p.x, p.y, 0.4);
          return new THREE.Vector3(w.x, w.y, w.z);
        });
        this.routeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      }
      const e = toWorld(s.endPos.x, s.endPos.y, 0.5);
      const kind = s.action.type;
      const markerCol = kind === 'place' ? '#ffd54f' : kind === 'pick' || kind === 'load' ? '#80cbc4' : kind === 'toggle' ? '#ce93d8' : kind === 'park' ? '#ffffff' : '#9e9e9e';
      const m = new THREE.Mesh(kind === 'place' ? new THREE.OctahedronGeometry(0.03) : new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: markerCol }));
      m.position.set(e.x, 0.05, e.z);
      this.routeGroup.add(m);
      const lbl = this.textSprite(String(i + 1), markerCol, 0.045);
      lbl.position.set(e.x, 0.12, e.z);
      this.routeGroup.add(lbl);
    });
  }

  setTrails(trails: { id: string; alliance: 'red' | 'blue'; pts: Vec2[] }[]) {
    this.trailGroup.clear();
    for (const t of trails) {
      if (t.pts.length < 2) continue;
      const pts = t.pts.map((p) => {
        const w = toWorld(p.x, p.y, 0.2);
        return new THREE.Vector3(w.x, w.y, w.z);
      });
      this.trailGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: t.alliance === 'red' ? '#d9534f' : '#3b82f6', transparent: true, opacity: 0.55 })));
    }
  }

  /** Copy the physical state into the scene. */
  sync(sim: MatchSim, selection: PickInfo | null) {
    const snap = sim.snapshot();
    for (const r of snap.robots) {
      if (!this.robots.has(r.id)) {
        const sr = sim.robot(r.id)!;
        this.robotMesh(r.id, sr.alliance, sr.cfg);
      }
      const m = this.robots.get(r.id)!;
      m.chassis.position.set(r.chassis.p.x, r.chassis.p.y, r.chassis.p.z);
      m.chassis.quaternion.set(r.chassis.q.x, r.chassis.q.y, r.chassis.q.z, r.chassis.q.w);
      m.carriage.position.set(r.carriage.p.x, r.carriage.p.y, r.carriage.p.z);
      m.carriage.quaternion.set(r.carriage.q.x, r.carriage.q.y, r.carriage.q.z, r.carriage.q.w);
    }
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let ip = 0;
    let ic = 0;
    this.objIndex = [];
    for (const o of snap.objects) {
      if (!o.p || !o.q) continue;
      q.set(o.q.x, o.q.y, o.q.z, o.q.w);
      up.set(0, 1, 0).applyQuaternion(q);
      const obj = sim.objects.objects.get(o.id)!;
      const halfOff = ((o.kind === 'pin' ? PIN.half : CUP.half) / 2) * IN;
      for (const sign of [-1, 1]) {
        p.set(o.p.x + up.x * halfOff * sign, o.p.y + up.y * halfOff * sign, o.p.z + up.z * halfOff * sign);
        mtx.compose(p, q, one);
        if (o.kind === 'pin') {
          this.pinHalves.setMatrixAt(ip, mtx);
          // local −Y half = colors[0], +Y half = colors[1]
          this.pinHalves.setColorAt(ip, halfColor(obj.colors![sign < 0 ? 0 : 1]));
          ip++;
        } else {
          // local +Y half = gray, −Y half = clear
          if (sign > 0) this.cupGray.setMatrixAt(ic, mtx);
          else this.cupClear.setMatrixAt(ic, mtx);
        }
      }
      if (o.kind === 'cup') ic++;
      this.objIndex.push(o.id);
    }
    this.pinHalves.count = ip;
    this.cupGray.count = ic;
    this.cupClear.count = ic;
    this.pinHalves.instanceMatrix.needsUpdate = true;
    if (this.pinHalves.instanceColor) this.pinHalves.instanceColor.needsUpdate = true;
    this.cupGray.instanceMatrix.needsUpdate = true;
    this.cupClear.instanceMatrix.needsUpdate = true;
    for (const t of snap.toggles) {
      const m = this.toggleMeshes.get(t.id)!;
      const tb = sim.field.toggles.find((x) => x.geom.id === t.id)!;
      const tp = tb.body.translation();
      m.position.set(tp.x, tp.y, tp.z);
      m.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
    }
    // selection marker
    this.selectionRing.visible = false;
    if (selection) {
      let pos: { x: number; y: number; z: number } | null = null;
      if (selection.kind === 'object') {
        const b = sim.objects.objects.get(selection.id)?.body;
        if (b) pos = b.translation();
      } else if (selection.kind === 'robot') {
        const r = sim.robot(selection.id);
        if (r) pos = r.body.chassis.translation();
      } else if (selection.kind === 'goal') {
        const g = this.goalMeshes.get(selection.id);
        if (g) pos = g.position;
      }
      if (pos) {
        this.selectionRing.visible = true;
        this.selectionRing.position.set(pos.x, 0.01, pos.z);
        this.selectionRing.scale.setScalar(selection.kind === 'robot' ? 3.5 : 1);
      }
    }
  }

  /** Pick the object under a canvas pixel. */
  pick(x: number, y: number, sim: MatchSim | null): PickInfo | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.pinHalves, this.cupGray, this.cupClear, ...this.scene.children.filter((c) => c.userData.pick)], true);
    for (const h of hits) {
      if (h.object === this.pinHalves && h.instanceId !== undefined) {
        const pins = sim ? [...sim.objects.objects.values()].filter((o) => o.body && o.kind === 'pin') : [];
        const o = pins[Math.floor(h.instanceId / 2)];
        if (o) return { kind: 'object', id: o.id };
      }
      if ((h.object === this.cupGray || h.object === this.cupClear) && h.instanceId !== undefined) {
        const cups = sim ? [...sim.objects.objects.values()].filter((o) => o.body && o.kind === 'cup') : [];
        const o = cups[h.instanceId];
        if (o) return { kind: 'object', id: o.id };
      }
      let n: THREE.Object3D | null = h.object;
      while (n) {
        if (n.userData.pick) return n.userData.pick as PickInfo;
        n = n.parent;
      }
    }
    return null;
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.controls.dispose();
  }
}
