import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildGoals, buildLoaders, buildToggles } from '../../field/geometry';
import { toWorld } from '../../physics/frames';
import type { SceneFrame } from '../../sim/frame';
import type { FieldScene } from './FieldScene';

/**
 * Official CAD swap-in. When public/models/manifest.json lists GLB files (made from
 * the official STEP files with scripts/cad/step_to_glb.py), they replace the
 * procedural models. Each element has a fixed reference frame (docs/CAD.md):
 *
 *  - pin:      origin at the Pin's center, long axis +Y; the half named first in
 *              its type (R in "RY") is the −Y half. One file per type, or one file
 *              for all types.
 *  - cup:      origin at the Cup's center, axis +Y, gray half toward +Y.
 *  - goal:     origin on the floor at the Goal's axis, +Y up.
 *  - toggle:   origin on the rotation axis at the bar's middle, +Z along the
 *              axis, +X toward the field, yellow face toward the field (yellow detent).
 *  - loader:   authored for the red Loader in the (−x, −y) corner, origin at
 *              that field corner on the floor; the other corners are rotated copies.
 *  - perimeter: whole perimeter, origin at the field center on the floor.
 *
 * Every entry may carry a fix-up transform { file, rotate: [x, y, z] degrees,
 * translate: [x, y, z] meters, scale } applied to the loaded model, so CAD
 * exported in a different frame can be aligned without re-exporting.
 */

type Entry = string | { file: string; rotate?: [number, number, number]; translate?: [number, number, number]; scale?: number };

interface Manifest {
  elements?: {
    pin?: Entry | Record<string, Entry>;
    cup?: Entry;
    goal?: Partial<Record<'alliance-red' | 'alliance-blue' | 'neutral' | 'midfield', Entry>>;
    toggle?: Entry;
    loader?: Partial<Record<'red' | 'blue', Entry>>;
    perimeter?: Entry;
  };
}

export interface CadOverrides {
  /** Elements that were replaced, for the UI. */
  replaced: string[];
  syncObjects(frame: SceneFrame): void;
  pickables(): THREE.Object3D[];
  pickHit(h: THREE.Intersection): string | null;
}

/** Bake a loaded model into (geometry, material) pairs in the model's root frame, for instancing. */
function flatten(root: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  root.updateMatrixWorld(true);
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    out.push({ geometry: g, material: Array.isArray(m.material) ? m.material[0] : m.material });
  });
  return out;
}

class InstancedSet {
  meshes: THREE.InstancedMesh[];
  ids: string[] = [];
  constructor(parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[], capacity: number, scene: THREE.Scene) {
    this.meshes = parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    });
  }
  begin() {
    this.ids = [];
  }
  push(id: string, mtx: THREE.Matrix4) {
    const i = this.ids.length;
    for (const m of this.meshes) if (i < m.instanceMatrix.count) m.setMatrixAt(i, mtx);
    this.ids.push(id);
  }
  end() {
    for (const m of this.meshes) {
      m.count = Math.min(this.ids.length, m.instanceMatrix.count);
      m.instanceMatrix.needsUpdate = true;
    }
  }
}

export async function applyCadOverrides(fs: FieldScene): Promise<CadOverrides | null> {
  const base = import.meta.env?.BASE_URL ?? '/';
  let manifest: Manifest;
  try {
    const r = await fetch(`${base}models/manifest.json`);
    if (!r.ok) return null;
    manifest = (await r.json()) as Manifest;
  } catch {
    return null;
  }
  const el = manifest.elements ?? {};
  if (!Object.keys(el).length) return null;
  const loader = new GLTFLoader();
  const replaced: string[] = [];
  const files = new Map<string, Promise<THREE.Object3D>>();
  const load = async (e: Entry): Promise<THREE.Object3D | null> => {
    const spec = typeof e === 'string' ? { file: e } : e;
    try {
      if (!files.has(spec.file)) files.set(spec.file, loader.loadAsync(`${base}models/${spec.file}`).then((g) => g.scene));
      const holder = new THREE.Group();
      const s = (await files.get(spec.file)!).clone();
      if (spec.scale) s.scale.setScalar(spec.scale);
      if (spec.rotate) s.rotation.set(...(spec.rotate.map((d) => (d * Math.PI) / 180) as [number, number, number]));
      if (spec.translate) s.position.set(...spec.translate);
      holder.add(s);
      holder.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
      });
      return holder;
    } catch (err) {
      console.warn(`[cad] could not load ${spec.file}:`, err);
      return null;
    }
  };
  const scene = fs.scene;

  // ---- Pins and Cups (instanced per type)
  const pinSets = new Map<string, InstancedSet>();
  let cupSet: InstancedSet | null = null;
  if (el.pin) {
    const entries: [string, Entry][] = typeof el.pin === 'string' || 'file' in (el.pin as object) ? [['*', el.pin as Entry]] : Object.entries(el.pin as Record<string, Entry>);
    for (const [type, e] of entries) {
      const m = await load(e);
      if (m) pinSets.set(type.toUpperCase(), new InstancedSet(flatten(m), 80, scene));
    }
  }
  if (el.cup) {
    const m = await load(el.cup);
    if (m) cupSet = new InstancedSet(flatten(m), 80, scene);
  }
  const pinsComplete = pinSets.has('*') || ['RY', 'BY', 'YY', 'RB'].every((t) => pinSets.has(t));
  if (pinSets.size && pinsComplete && cupSet) {
    fs.hideProceduralObjects();
    replaced.push('pins', 'cups');
  } else if (pinSets.size || cupSet) {
    console.warn('[cad] Pins and Cups are only swapped together and for every Pin type; keeping the procedural ones.');
    for (const s of [...pinSets.values(), ...(cupSet ? [cupSet] : [])]) for (const m of s.meshes) scene.remove(m);
    pinSets.clear();
    cupSet = null;
  }

  // ---- Goals
  if (el.goal) {
    for (const g of buildGoals()) {
      const key: 'alliance-red' | 'alliance-blue' | 'neutral' | 'midfield' = g.type === 'alliance' ? (g.allianceColor === 'blue' ? 'alliance-blue' : 'alliance-red') : g.type;
      const e = el.goal[key];
      if (!e) continue;
      const m = await load(e);
      const host = fs.goalObject(g.id);
      if (!m || !host) continue;
      host.children.forEach((c) => (c.visible = false));
      host.add(m);
      if (!replaced.includes('goals')) replaced.push('goals');
    }
  }

  // ---- Toggles (the model rides in the physics-synced bar group)
  if (el.toggle) {
    const proto = await load(el.toggle);
    if (proto) {
      for (const tg of buildToggles()) {
        const host = fs.toggleObject(tg.id);
        if (!host) continue;
        host.children.forEach((c) => (c.visible = false));
        host.add(proto.clone());
      }
      replaced.push('toggles');
    }
  }

  // ---- Loaders (authored for the red wall (−x): origin on the wall's inner face behind the Loader; turned 180° for blue)
  if (el.loader) {
    for (const l of buildLoaders()) {
      const e = el.loader[l.alliance];
      if (!e) continue;
      const m = await load(e);
      if (!m) continue;
      const proc = scene.getObjectByName(`loader:${l.id}`);
      if (proc) proc.visible = false;
      const w = toWorld(l.wall.x, l.wall.y);
      m.rotation.y = l.alliance === 'red' ? 0 : Math.PI;
      m.position.set(w.x, 0, w.z);
      scene.add(m);
      if (!replaced.includes('loaders')) replaced.push('loaders');
    }
  }

  // ---- Perimeter
  if (el.perimeter) {
    const m = await load(el.perimeter);
    if (m) {
      const proc = scene.getObjectByName('perimeter');
      if (proc) proc.visible = false;
      scene.add(m);
      replaced.push('perimeter');
    }
  }

  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  if (replaced.length) console.info(`[cad] official models in use: ${replaced.join(', ')}`);
  return {
    replaced,
    syncObjects(frame) {
      if (!cupSet || !pinSets.size) return;
      for (const s of pinSets.values()) s.begin();
      cupSet.begin();
      for (const o of frame.objects) {
        if (!o.p || !o.q) continue;
        q.set(o.q.x, o.q.y, o.q.z, o.q.w);
        p.set(o.p.x, o.p.y, o.p.z);
        mtx.compose(p, q, one);
        if (o.kind === 'cup') cupSet.push(o.id, mtx);
        else {
          const type = o.colors!.map((c) => c[0].toUpperCase()).join('');
          (pinSets.get(type) ?? pinSets.get('*') ?? pinSets.get(type.split('').reverse().join('')))?.push(o.id, mtx);
        }
      }
      for (const s of pinSets.values()) s.end();
      cupSet.end();
    },
    pickables() {
      return [...[...pinSets.values()].flatMap((s) => s.meshes), ...(cupSet?.meshes ?? [])];
    },
    pickHit(h) {
      if (h.instanceId === undefined) return null;
      for (const s of [...pinSets.values(), ...(cupSet ? [cupSet] : [])]) if (s.meshes.includes(h.object as THREE.InstancedMesh)) return s.ids[h.instanceId] ?? null;
      return null;
    },
  };
}
