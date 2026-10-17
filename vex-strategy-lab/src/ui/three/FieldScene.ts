import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { IN } from '../../core/units';
import type { Vec2 } from '../../core/vec';
import { buildGoals, buildLoaders, buildToggles, CUP, HALF, loadZones, PIN, TILE } from '../../field/geometry';
import type { MatchSim } from '../../sim/match';
import { toWorld } from '../../physics/frames';
import type { HalfColor } from '../../rules/ruleset';
import type { StepInfo } from '../../planner/model';
import type { CameraMode } from '../store';
import { createMaterials, PALETTE, type MaterialLibrary } from './assets/materials';
import { fieldTextures } from './assets/textures';
import { cupHalfGeometry, goalModel, loaderModel, perimeterModel, pinHalfGeometry, toggleBarModel, toggleMountModel } from './assets/elements';
import { robotModel, type RobotModel } from './assets/robot';
import { applyCadOverrides, type CadOverrides } from './cad';

/**
 * Three.js view of the simulation. Geometry is built from the same field model
 * the physics uses; every frame it copies body poses from the MatchSim snapshot.
 *
 * Rendering: physically based materials lit by an environment map (reflections on
 * plastic, aluminum and polycarbonate), a shadow-casting key light, ACES filmic
 * tone mapping. Pins and Cups are instanced (one draw call per half type), so a
 * full field of 119 objects stays cheap. Official CAD models listed in
 * public/models/manifest.json replace the procedural ones when present.
 */

export const COLORS = {
  red: new THREE.Color(PALETTE.red),
  blue: new THREE.Color(PALETTE.blue),
  yellow: new THREE.Color(PALETTE.yellow),
};

const halfColor = (c: HalfColor) => (c === 'red' ? COLORS.red : c === 'blue' ? COLORS.blue : COLORS.yellow);

export interface PickInfo {
  kind: 'object' | 'robot' | 'goal' | 'toggle';
  id: string;
}

export class FieldScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly mats: MaterialLibrary;
  private keyLight: THREE.DirectionalLight;
  private pinTop!: THREE.InstancedMesh;
  private pinBottom!: THREE.InstancedMesh;
  private cupGray!: THREE.InstancedMesh;
  private cupClear!: THREE.InstancedMesh;
  private pinIds: string[] = [];
  private cupIds: string[] = [];
  private robots = new Map<string, RobotModel>();
  private toggleMeshes = new Map<string, THREE.Object3D>();
  private routeGroup = new THREE.Group();
  private trailGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  private selectionRing: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private gridHelper: THREE.Group;
  private zoneGroup = new THREE.Group();
  private goalMeshes = new Map<string, THREE.Object3D>();
  private showLabels = true;
  /** CAD replacements loaded from public/models (null until loaded / when absent). */
  cad: CadOverrides | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#0e0f10');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();
    this.mats = createMaterials();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.02, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight('#dfe8f2', '#2a2b2d', 0.35));
    this.keyLight = new THREE.DirectionalLight('#fff6ea', 2.4);
    this.keyLight.position.set(1.4, 4.2, 1.9);
    this.keyLight.castShadow = true;
    const sc = this.keyLight.shadow.camera;
    sc.left = sc.bottom = -2.35;
    sc.right = sc.top = 2.35;
    sc.near = 1;
    sc.far = 9;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0003;
    this.keyLight.shadow.normalBias = 0.015;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    const fill = new THREE.DirectionalLight('#cfe0ff', 0.55);
    fill.position.set(-3, 2.5, -2);
    this.scene.add(fill);

    this.buildField();
    this.buildObjects();
    this.scene.add(this.routeGroup, this.trailGroup, this.labelGroup, this.zoneGroup);
    this.selectionRing = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.006, 8, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    this.selectionRing.rotation.x = Math.PI / 2;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);
    this.gridHelper = this.buildGrid();
    this.scene.add(this.gridHelper);
    this.setCamera('iso');
    void applyCadOverrides(this).then((o) => (this.cad = o));
  }

  private buildGrid(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: '#9aa0a6', transparent: true, opacity: 0.7, toneMapped: false });
    for (let k = -3; k <= 3; k++) {
      const v = k * TILE * IN;
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v, 0.004, -HALF * IN), new THREE.Vector3(v, 0.004, HALF * IN)]), mat));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-HALF * IN, 0.004, v), new THREE.Vector3(HALF * IN, 0.004, v)]), mat));
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
    const { map, bump } = fieldTextures();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 1.2, roughness: 0.94, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(S + 6, S + 6), new THREE.MeshStandardMaterial({ color: '#1a1b1d', roughness: 0.85 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.003;
    outer.receiveShadow = true;
    this.scene.add(outer);
    const perimeter = perimeterModel(this.mats);
    perimeter.name = 'perimeter';
    this.scene.add(perimeter);
    // alliance stations
    for (const [x, col] of [
      [-(HALF + 10) * IN, PALETTE.red],
      [(HALF + 10) * IN, PALETTE.blue],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.004, 1.8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }));
      m.position.set(x, 0.002, 0);
      this.scene.add(m);
    }
    // goals
    for (const g of buildGoals()) {
      const grp = goalModel(g, this.mats);
      grp.userData.pick = { kind: 'goal', id: g.id } satisfies PickInfo;
      this.scene.add(grp);
      this.goalMeshes.set(g.id, grp);
      const p = toWorld(g.pos.x, g.pos.y);
      const lbl = this.textSprite(g.id.replace('G-', ''), '#f0efec', 0.05);
      lbl.position.set(p.x, (g.height + 9) * IN, p.z);
      this.labelGroup.add(lbl);
    }
    for (const l of buildLoaders()) {
      const m = loaderModel(l, this.mats);
      m.name = `loader:${l.id}`;
      this.scene.add(m);
    }
    // toggles: rotating bar (synced to physics) + static wall-top brackets
    for (const tg of buildToggles()) {
      this.scene.add(toggleMountModel(tg, this.mats));
      const bar = toggleBarModel(tg, this.mats);
      bar.userData.pick = { kind: 'toggle', id: tg.id } satisfies PickInfo;
      const p = toWorld(tg.pos.x + tg.normal.x * tg.axisOffset, tg.pos.y + tg.normal.y * tg.axisOffset, tg.pivotHeight);
      bar.position.set(p.x, p.y, p.z);
      this.scene.add(bar);
      this.toggleMeshes.set(tg.id, bar);
    }
    // overlays: Load Zones (protected areas) — shown with the "zones" toggle
    for (const z of loadZones()) {
      const [x0, y0, x1, y1] = z.aabb;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry((x1 - x0) * IN, (y1 - y0) * IN),
        new THREE.MeshBasicMaterial({ color: z.alliance === 'red' ? PALETTE.red : PALETTE.blue, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      const c = toWorld((x0 + x1) / 2, (y0 + y1) / 2, 0.08);
      m.position.set(c.x, c.y, c.z);
      this.zoneGroup.add(m);
    }
  }

  private buildObjects() {
    const pinMat = this.mats.pinPlastic;
    this.pinTop = new THREE.InstancedMesh(pinHalfGeometry(1), pinMat, 120);
    this.pinBottom = new THREE.InstancedMesh(pinHalfGeometry(-1), pinMat, 120);
    this.cupGray = new THREE.InstancedMesh(cupHalfGeometry(1, true), this.mats.cupGray, 120);
    this.cupClear = new THREE.InstancedMesh(cupHalfGeometry(-1, false), this.mats.cupClear, 120);
    for (const m of [this.pinTop, this.pinBottom, this.cupGray, this.cupClear]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = m !== this.cupClear;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
    }
    this.cupClear.renderOrder = 3;
    this.scene.add(this.pinTop, this.pinBottom, this.cupGray, this.cupClear);
  }

  /** Hide the procedural Pin / Cup instancing (CAD instancing replaces it; see cad.ts). */
  hideProceduralObjects() {
    for (const m of [this.pinTop, this.pinBottom, this.cupGray, this.cupClear]) m.visible = false;
  }

  goalObject(id: string) {
    return this.goalMeshes.get(id) ?? null;
  }

  toggleObject(id: string) {
    return this.toggleMeshes.get(id) ?? null;
  }

  private ensureRobot(sim: MatchSim, id: string): RobotModel {
    let m = this.robots.get(id);
    if (!m) {
      const sr = sim.robot(id)!;
      m = robotModel(id, sr.alliance, sr.cfg, this.mats);
      m.chassis.userData.pick = { kind: 'robot', id } satisfies PickInfo;
      const lbl = this.textSprite(id, '#f0efec', 0.06);
      lbl.position.set(0, (sr.cfg.chassis.towerHeightIn + 5) * IN, 0);
      lbl.visible = this.showLabels;
      m.chassis.add(lbl);
      this.scene.add(m.chassis, m.carriage);
      this.robots.set(id, m);
    }
    return m;
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
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
    s.scale.set((height * w) / c.height, height, 1);
    s.renderOrder = 10;
    s.userData.isLabel = true;
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

  setVisibility(v: { labels: boolean; grid: boolean; route: boolean; trails: boolean; zones: boolean; shadows?: boolean }) {
    this.showLabels = v.labels;
    this.labelGroup.visible = v.labels;
    for (const m of this.robots.values()) m.chassis.traverse((o) => o.userData.isLabel && (o.visible = v.labels));
    this.gridHelper.visible = v.grid;
    this.routeGroup.visible = v.route;
    this.trailGroup.visible = v.trails;
    this.zoneGroup.visible = v.zones;
    const sh = v.shadows ?? true;
    if (this.renderer.shadowMap.enabled !== sh) {
      this.renderer.shadowMap.enabled = sh;
      this.keyLight.castShadow = sh;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
      });
    }
  }

  /** Planned route overlay: path polylines, numbered waypoints, pickup/scoring markers. */
  setRoute(steps: StepInfo[] | null, alliance: 'red' | 'blue') {
    this.routeGroup.clear();
    if (!steps) return;
    const col = alliance === 'red' ? '#ff8a80' : '#82b1ff';
    const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9, toneMapped: false });
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
      const m = new THREE.Mesh(kind === 'place' ? new THREE.OctahedronGeometry(0.03) : new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: markerCol, toneMapped: false }));
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
      this.trailGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: t.alliance === 'red' ? '#e66767' : '#3987e5', transparent: true, opacity: 0.6, toneMapped: false })));
    }
  }

  /** Copy the physical state into the scene. */
  sync(sim: MatchSim, selection: PickInfo | null) {
    const snap = sim.snapshot();
    for (const r of snap.robots) {
      const m = this.ensureRobot(sim, r.id);
      m.chassis.position.set(r.chassis.p.x, r.chassis.p.y, r.chassis.p.z);
      m.chassis.quaternion.set(r.chassis.q.x, r.chassis.q.y, r.chassis.q.z, r.chassis.q.w);
      m.carriage.position.set(r.carriage.p.x, r.carriage.p.y, r.carriage.p.z);
      m.carriage.quaternion.set(r.carriage.q.x, r.carriage.q.y, r.carriage.q.z, r.carriage.q.w);
      const sr = sim.robot(r.id);
      if (sr) m.setLift(sr.body.holderHeight() - sr.cfg.rack.holderMinHeightIn);
    }
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let ip = 0;
    let ic = 0;
    this.pinIds = [];
    this.cupIds = [];
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
          // local −Y half = colors[0], +Y half = colors[1]
          const mesh = sign < 0 ? this.pinBottom : this.pinTop;
          mesh.setMatrixAt(ip, mtx);
          mesh.setColorAt(ip, halfColor(obj.colors![sign < 0 ? 0 : 1]));
        } else {
          // local +Y half = gray, −Y half = clear
          (sign > 0 ? this.cupGray : this.cupClear).setMatrixAt(ic, mtx);
        }
      }
      if (o.kind === 'pin') {
        this.pinIds.push(o.id);
        ip++;
      } else {
        this.cupIds.push(o.id);
        ic++;
      }
    }
    this.pinTop.count = this.pinBottom.count = ip;
    this.cupGray.count = this.cupClear.count = ic;
    for (const m of [this.pinTop, this.pinBottom, this.cupGray, this.cupClear]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.cad?.syncObjects(sim, snap);
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
  pick(x: number, y: number, _sim: MatchSim | null): PickInfo | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const objs = [this.pinTop, this.pinBottom, this.cupGray, this.cupClear].filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects([...objs, ...(this.cad?.pickables() ?? []), ...this.scene.children.filter((c) => c.userData.pick)], true);
    for (const h of hits) {
      if ((h.object === this.pinTop || h.object === this.pinBottom) && h.instanceId !== undefined) {
        const id = this.pinIds[h.instanceId];
        if (id) return { kind: 'object', id };
      }
      if ((h.object === this.cupGray || h.object === this.cupClear) && h.instanceId !== undefined) {
        const id = this.cupIds[h.instanceId];
        if (id) return { kind: 'object', id };
      }
      const cadHit = this.cad?.pickHit(h);
      if (cadHit) return { kind: 'object', id: cadHit };
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
