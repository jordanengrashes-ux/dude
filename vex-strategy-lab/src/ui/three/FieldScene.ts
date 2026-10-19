import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { IN } from '../../core/units';
import type { Vec2 } from '../../core/vec';
import { buildGoals, buildLoaders, buildToggles, CUP, HALF, loadZones, PIN, TILE } from '../../field/geometry';
import type { SceneFrame } from '../../sim/frame';
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

/** First person: tilted down so the claw is in view at the bottom of the screen (rad), and its vertical field of view (deg). */
const FP_PITCH = -0.5;
const FP_FOV = 70;
/**
 * 3rd person: the camera aims at (and circles) a point over the robot — this far behind
 * its middle (0: the middle, front to back) and this high up (in) with the arm down,
 * rising with the arm — in the middle of the view.
 */
const CHASE_FOCUS_BACK_IN = 0;
const CHASE_FOCUS_HEIGHT = 14;
/** 3rd person camera: distance from that point (m) and how steeply it looks down at it (rad): up over the robot. */
const CHASE_DIST = 0.78;
const CHASE_PITCH = 0.785;

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
  /** 3rd-person camera: the robot it follows and its distance (m). */
  private chaseId: string | null = null;
  private chaseDist = CHASE_DIST;
  /** 3rd person: angle around the robot (rad, 0 = behind it) and above it. */
  private chaseYaw = 0;
  private chasePitch = CHASE_PITCH;
  /** Zoomed all the way in: the robot's-eye view, looking around with fpYaw / fpPitch. */
  firstPerson = false;
  private fpYaw = 0;
  private fpPitch = FP_PITCH;
  private chaseLook = new THREE.Vector3();
  private chaseInit = false;
  private chaseT = 0;
  /** Heading the 3rd-person camera is turned to (follows the robot's, smoothed). */
  private camHeading = 0;
  /** Pointer drag on the canvas (a drag is not a click: no claw toggle, no inspect). */
  private drag = { x: 0, y: 0, moved: 0, active: false, endedAt: -1e9 };
  private mode: CameraMode = 'iso';
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
    // 3rd person: scroll zooms; all the way in switches to first person, out again back
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'chase') return;
        e.preventDefault();
        if (this.firstPerson) {
          if (e.deltaY > 0) {
            this.firstPerson = false;
            this.chaseDist = 0.6;
            this.chaseInit = false;
          }
          return;
        }
        const d = this.chaseDist * Math.exp(e.deltaY * 0.001);
        if (d < 0.5) {
          this.firstPerson = true;
          this.fpYaw = 0;
          this.fpPitch = FP_PITCH;
          this.chaseInit = false;
        } else this.chaseDist = Math.min(3, d);
      },
      { passive: false },
    );
    // drag to look around (3rd person: orbit the robot; first person: turn your head)
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, active: true, endedAt: this.drag.endedAt };
    });
    // cursor locked to the view (while driving): moving the mouse looks around
    canvas.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked || this.mode !== 'chase') return;
      this.look(e.movementX, e.movementY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.pointerLocked) return;
      if (!this.drag.active || !e.buttons) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.mode !== 'chase' || this.drag.moved < 4) return;
      this.look(dx, dy);
    });
    window.addEventListener('pointerup', () => {
      if (this.drag.active && this.drag.moved >= 4) this.drag.endedAt = performance.now();
      this.drag.active = false;
    });
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

  private ensureRobot(fr: SceneFrame['robots'][number]): RobotModel {
    let m = this.robots.get(fr.id);
    if (!m) {
      m = robotModel(fr.id, fr.alliance, fr.cfg, this.mats);
      m.chassis.userData.pick = { kind: 'robot', id: fr.id } satisfies PickInfo;
      const lbl = this.textSprite(fr.id, '#f0efec', 0.06);
      lbl.position.set(0, (fr.cfg.chassis.towerHeightIn + 5) * IN, 0);
      lbl.visible = this.showLabels;
      m.chassis.add(lbl);
      this.scene.add(m.chassis, m.carriage);
      this.robots.set(fr.id, m);
    }
    return m;
  }

  /** Drop robot models (e.g. a different robot set after a rebuild or joining a room). */
  resetRobots() {
    for (const m of this.robots.values()) this.scene.remove(m.chassis, m.carriage);
    this.robots.clear();
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
    this.mode = mode;
    this.controls.enabled = mode !== 'chase';
    this.chaseInit = false;
    this.showOwnFrame();
    if (mode === 'chase') return;
    if (this.camera.fov !== 42) {
      this.camera.fov = 42;
      this.camera.updateProjectionMatrix();
    }
    const followed = this.chaseId ? this.robots.get(this.chaseId) : undefined;
    followed?.chassis.traverse((o) => o.userData.isLabel && (o.visible = this.showLabels));
    const c = this.camera;
    if (mode === 'overhead') c.position.set(0, 4.6, 0.001);
    else if (mode === 'iso') c.position.set(-2.4, 2.6, 2.9);
    else if (mode === 'side') c.position.set(0, 0.9, 4.2);
    this.controls.target.set(0, 0, 0);
    this.controls.enableRotate = true;
    this.controls.update();
  }

  private aligner: { group: THREE.Group; ring: THREE.Mesh; zone: THREE.Mesh; dot: THREE.Mesh; line: THREE.Line } | null = null;
  private goalPos = new Map(buildGoals().map((g) => [g.id, g.pos]));

  /**
   * Aligner over the Goal (or loose Cup / Pin) the followed robot would drop on: a
   * ring on the opening, a disc showing how far off its axis a drop still goes in,
   * and a dot where the held piece's axis is now (dropped from the claw to the rim).
   * White: not lined up; orange: lined up but too low to clear the rim; green: open
   * the claw now and it drops in.
   */
  private updateAligner(frame: SceneFrame) {
    const r = this.chaseId ? frame.robots.find((x) => x.id === this.chaseId) : undefined;
    const a = r?.align ?? null;
    if (!this.aligner) {
      const mat = (opacity: number) => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity, toneMapped: false, depthTest: false, side: THREE.DoubleSide });
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9 * IN, 0.1 * IN, 10, 40), mat(0.85));
      ring.rotation.x = Math.PI / 2;
      const zone = new THREE.Mesh(new THREE.CircleGeometry(1 * IN, 40), mat(0.28));
      zone.rotation.x = -Math.PI / 2;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22 * IN, 20), mat(0.95));
      dot.rotation.x = -Math.PI / 2;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, toneMapped: false, depthTest: false }));
      for (const o of [ring, zone, dot, line]) {
        o.renderOrder = 11;
        group.add(o);
      }
      this.scene.add(group);
      this.aligner = { group, ring, zone, dot, line };
    }
    const al = this.aligner;
    const g = a ? (a.at ?? this.goalPos.get(a.goal)) : undefined;
    al.group.visible = !!(a && g);
    if (!a || !g) return;
    const color = a.state === 2 ? '#39d353' : a.state === 1 ? '#ff9f1a' : '#ffffff';
    for (const o of [al.ring, al.zone, al.dot]) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
    (al.line.material as THREE.LineBasicMaterial).color.set(color);
    const w = toWorld(g.x, g.y, a.top + 0.05);
    al.ring.position.set(w.x, w.y, w.z);
    // the opening: a Goal socket's bore or a loose piece's rim
    al.ring.scale.setScalar(a.at ? 0.85 : 0.7);
    al.zone.position.set(w.x, w.y + 0.002, w.z);
    al.zone.scale.setScalar(Math.max(0.15, a.tol ?? 0.6));
    const f = a.from ?? g;
    const d = toWorld(f.x, f.y, a.top + 0.05);
    al.dot.position.set(d.x, d.y + 0.004, d.z);
    // a plumb line from the held piece down to where it would land
    const held = r!.carriage.p;
    const pts = [new THREE.Vector3(d.x, held.y, d.z), new THREE.Vector3(d.x, d.y, d.z)];
    al.line.geometry.setFromPoints(pts);
  }

  /** Robot the 3rd-person camera follows (null: none). */
  setFollow(id: string | null) {
    if (id !== this.chaseId) {
      this.chaseInit = false;
      this.showOwnFrame();
      const prev = this.chaseId ? this.robots.get(this.chaseId) : undefined;
      prev?.chassis.traverse((o) => o.userData.isLabel && (o.visible = this.showLabels));
    }
    this.chaseId = id;
  }

  /** First person: the followed robot's own towers, brace and lift bars (they'd fill the view) are hidden. */
  private fpHidden: THREE.Object3D[] = [];
  private hideOwnFrame(m: RobotModel | undefined) {
    if (this.fpHidden.length || !m) return;
    for (const o of m.chassis.children) {
      if (!o.visible || o.userData.isLabel || o.position.y < 4.5 * IN) continue;
      o.visible = false;
      this.fpHidden.push(o);
    }
  }
  private showOwnFrame() {
    for (const o of this.fpHidden) o.visible = true;
    this.fpHidden = [];
  }

  /** Turn the 3rd-person / first-person view by a mouse movement (px). */
  private look(dx: number, dy: number) {
    if (this.firstPerson) {
      this.fpYaw -= dx * 0.006;
      this.fpPitch = Math.max(-1.2, Math.min(0.6, this.fpPitch - dy * 0.005));
    } else {
      this.chaseYaw -= dx * 0.008;
      this.chasePitch = Math.max(0.08, Math.min(1.45, this.chasePitch + dy * 0.006));
    }
  }

  /** The cursor is locked to the 3D view (mouse look); Esc frees it. */
  get pointerLocked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.canvas;
  }

  /** Lock the cursor to the view for mouse look (3rd / 1st person only). True if it asked. */
  lockPointer(): boolean {
    if (this.mode !== 'chase' || this.pointerLocked || !this.canvas.requestPointerLock) return false;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined); // refused (e.g. right after Esc): stays unlocked
    } catch {
      return false;
    }
    return true;
  }

  unlockPointer() {
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** True right after a drag ended (the click that follows it is not a click); consumes it. */
  wasDrag(): boolean {
    const d = performance.now() - this.drag.endedAt < 300;
    this.drag.endedAt = -1e9;
    return d;
  }

  /** Camera back behind the robot (3rd person) / looking straight ahead (first person). */
  resetView() {
    this.chaseYaw = 0;
    this.chasePitch = CHASE_PITCH;
    this.fpYaw = 0;
    this.fpPitch = FP_PITCH;
  }

  /** Switch between the robot's-eye view and 3rd person (key / controller button). */
  toggleFirstPerson() {
    if (this.mode !== 'chase') return;
    this.firstPerson = !this.firstPerson;
    if (this.firstPerson) {
      this.fpYaw = 0;
      this.fpPitch = FP_PITCH;
    } else this.chaseDist = Math.max(this.chaseDist, 0.6);
    this.chaseInit = false;
  }

  /** Look around with a stick (x, y in -1..1, per animation frame). */
  orbitBy(x: number, y: number) {
    if (this.mode !== 'chase') return;
    if (this.firstPerson) {
      this.fpYaw -= x * 0.04;
      this.fpPitch = Math.max(-1.2, Math.min(0.6, this.fpPitch - y * 0.03));
    } else {
      this.chaseYaw -= x * 0.05;
      this.chasePitch = Math.max(0.08, Math.min(1.45, this.chasePitch + y * 0.035));
    }
  }

  /** Place the 3rd-person (or first-person) camera on the followed robot, smoothed. */
  private updateChase() {
    const m = this.chaseId ? this.robots.get(this.chaseId) : undefined;
    if (this.mode !== 'chase' || !m) return;
    const pos = m.chassis.position;
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(m.chassis.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    fwd.normalize();
    // your own name tag would sit right in front of the camera
    m.chassis.traverse((o) => o.userData.isLabel && (o.visible = false));
    const heading = Math.atan2(-fwd.z, fwd.x);
    // first person: a wide view, so the claw shows at the bottom and the field ahead above it
    const fov = this.firstPerson ? FP_FOV : 42;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (this.firstPerson) this.hideOwnFrame(m);
    else this.showOwnFrame();
    if (this.firstPerson) {
      // the robot's eye: above the chassis, behind the claw, looking ahead and down
      const eye = new THREE.Vector3(-3 * IN, 15 * IN, 0).applyQuaternion(m.chassis.quaternion).add(pos);
      const yaw = heading + this.fpYaw;
      const c = Math.cos(this.fpPitch);
      const dir = new THREE.Vector3(Math.cos(yaw) * c, Math.sin(this.fpPitch), -Math.sin(yaw) * c);
      const k = this.chaseInit ? 0.5 : 1;
      this.chaseInit = true;
      this.camera.position.lerp(eye, k);
      this.chaseLook.copy(this.camera.position).add(dir);
      this.camera.lookAt(this.chaseLook);
      return;
    }
    // 3rd person: the camera circles, and looks at, a point over the middle of the
    // robot, up high (not the claw) — it is the middle of the view. It turns with the robot smoothly (time-based, so it keeps up at
    // any frame rate) but never trails behind its position, so the robot stays framed.
    const now = performance.now();
    const dt = this.chaseInit ? Math.min(0.1, (now - this.chaseT) / 1000) : 1;
    this.chaseT = now;
    if (!this.chaseInit) this.camHeading = heading;
    let dh = heading - this.camHeading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.camHeading += dh * (1 - Math.exp(-dt * 7));
    const back = CHASE_FOCUS_BACK_IN * IN;
    // it rides up and down with the arm
    const lift = Math.max(0, m.carriage.position.y - pos.y - m.holderMinIn * IN);
    const pivot = new THREE.Vector3(pos.x - fwd.x * back, pos.y + CHASE_FOCUS_HEIGHT * IN + lift, pos.z - fwd.z * back);
    const d = this.chaseDist;
    const yaw = this.camHeading + Math.PI + this.chaseYaw; // 0 = behind the robot
    const horiz = d * Math.cos(this.chasePitch);
    const want = new THREE.Vector3(pivot.x + Math.cos(yaw) * horiz, pivot.y + d * Math.sin(this.chasePitch), pivot.z - Math.sin(yaw) * horiz);
    // backed against a wall (the start), the camera stays behind the robot, over the
    // wall; only far out (past the stands) does it rise instead
    const lim = HALF * IN + 0.9;
    // behind a wall it looks down over the wall and the Toggle bar on it
    const outside = Math.min(0.9, Math.max(0, Math.abs(want.x) - HALF * IN, Math.abs(want.z) - HALF * IN));
    want.y += outside * 0.8;
    const over = Math.max(0, Math.abs(want.x) - lim, Math.abs(want.z) - lim);
    want.x = Math.max(-lim, Math.min(lim, want.x));
    want.z = Math.max(-lim, Math.min(lim, want.z));
    want.y += over * 1.2;
    const k = this.chaseInit ? 1 - Math.exp(-dt * 14) : 1;
    this.chaseInit = true;
    this.camera.position.lerp(want, k);
    this.chaseLook.lerp(pivot, k);
    this.camera.lookAt(this.chaseLook);
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

  /** Draw one frame of the match (local physics or a team-mode snapshot). */
  sync(frame: SceneFrame, selection: PickInfo | null) {
    for (const r of frame.robots) {
      const m = this.ensureRobot(r);
      m.chassis.position.set(r.chassis.p.x, r.chassis.p.y, r.chassis.p.z);
      m.chassis.quaternion.set(r.chassis.q.x, r.chassis.q.y, r.chassis.q.z, r.chassis.q.w);
      m.carriage.position.set(r.carriage.p.x, r.carriage.p.y, r.carriage.p.z);
      m.carriage.quaternion.set(r.carriage.q.x, r.carriage.q.y, r.carriage.q.z, r.carriage.q.w);
      m.setLift(r.holderH - r.cfg.lift.holderMinHeightIn);
      m.setClaw(r.claw, r.rollers ?? 0);
    }
    this.updateAligner(frame);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let ip = 0;
    let ic = 0;
    this.pinIds = [];
    this.cupIds = [];
    for (const o of frame.objects) {
      if (!o.p || !o.q) continue;
      q.set(o.q.x, o.q.y, o.q.z, o.q.w);
      up.set(0, 1, 0).applyQuaternion(q);
      const halfOff = ((o.kind === 'pin' ? PIN.half : CUP.half) / 2) * IN;
      for (const sign of [-1, 1]) {
        p.set(o.p.x + up.x * halfOff * sign, o.p.y + up.y * halfOff * sign, o.p.z + up.z * halfOff * sign);
        mtx.compose(p, q, one);
        if (o.kind === 'pin') {
          // local −Y half = colors[0], +Y half = colors[1]
          const mesh = sign < 0 ? this.pinBottom : this.pinTop;
          mesh.setMatrixAt(ip, mtx);
          mesh.setColorAt(ip, halfColor(o.colors![sign < 0 ? 0 : 1]));
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
    this.cad?.syncObjects(frame);
    for (const t of frame.toggles) {
      const m = this.toggleMeshes.get(t.id);
      if (!m) continue;
      m.position.set(t.p.x, t.p.y, t.p.z);
      m.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
    }
    // selection marker
    this.selectionRing.visible = false;
    if (selection) {
      let pos: { x: number; y: number; z: number } | null = null;
      if (selection.kind === 'object') pos = frame.objects.find((o) => o.id === selection.id)?.p ?? null;
      else if (selection.kind === 'robot') pos = frame.robots.find((r) => r.id === selection.id)?.chassis.p ?? null;
      else if (selection.kind === 'goal') pos = this.goalMeshes.get(selection.id)?.position ?? null;
      if (pos) {
        this.selectionRing.visible = true;
        this.selectionRing.position.set(pos.x, 0.01, pos.z);
        this.selectionRing.scale.setScalar(selection.kind === 'robot' ? 3.5 : 1);
      }
    }
  }

  /** Pick the object under a canvas pixel. */
  pick(x: number, y: number): PickInfo | null {
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
    if (this.mode === 'chase') this.updateChase();
    else this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.controls.dispose();
  }
}
