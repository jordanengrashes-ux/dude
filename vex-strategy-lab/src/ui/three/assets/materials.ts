import * as THREE from 'three';

/**
 * Physically based material library for the field, game elements and robots.
 * Colors are the alliance/element colors used across the app; surface parameters
 * (roughness, clearcoat, transmission-like transparency) imitate the real
 * materials: injection-molded plastic, polycarbonate, anodized and bare
 * aluminum, powder-coated steel, foam tiles and rubber.
 */

export const PALETTE = {
  red: '#c8202f',
  blue: '#1f5fd1',
  yellow: '#f2c200',
  gray: '#585c61',
  neutralGoal: '#c9ccd1',
  aluminum: '#c7cbd1',
  steel: '#3a3d42',
  rubber: '#1b1c1e',
  foam: '#55585d',
  tape: '#f4f4f2',
} as const;

export interface MaterialLibrary {
  plastic(color: THREE.ColorRepresentation): THREE.MeshPhysicalMaterial;
  /** Pin plastic; per-instance colors multiply a white base. */
  pinPlastic: THREE.MeshPhysicalMaterial;
  cupGray: THREE.MeshPhysicalMaterial;
  cupClear: THREE.MeshPhysicalMaterial;
  polycarbonate: THREE.MeshPhysicalMaterial;
  aluminum: THREE.MeshStandardMaterial;
  aluminumDark: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  powderCoat: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  blackPlastic: THREE.MeshStandardMaterial;
  bolt: THREE.MeshStandardMaterial;
}

export function createMaterials(): MaterialLibrary {
  const cache = new Map<string, THREE.MeshPhysicalMaterial>();
  const plastic = (color: THREE.ColorRepresentation) => {
    const key = new THREE.Color(color).getHexString();
    let m = cache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.35 });
      cache.set(key, m);
    }
    return m;
  };
  return {
    plastic,
    pinPlastic: new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.36, clearcoat: 0.4, clearcoatRoughness: 0.3, sheen: 0.2 }),
    cupGray: new THREE.MeshPhysicalMaterial({ color: PALETTE.gray, roughness: 0.55, clearcoat: 0.15, side: THREE.DoubleSide }),
    cupClear: new THREE.MeshPhysicalMaterial({
      color: '#eef4f8',
      roughness: 0.06,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      specularIntensity: 1,
    }),
    polycarbonate: new THREE.MeshPhysicalMaterial({
      color: '#e3edf5',
      roughness: 0.04,
      clearcoat: 1,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    aluminum: new THREE.MeshStandardMaterial({ color: PALETTE.aluminum, metalness: 0.85, roughness: 0.32 }),
    aluminumDark: new THREE.MeshStandardMaterial({ color: '#8e939a', metalness: 0.8, roughness: 0.4 }),
    steel: new THREE.MeshStandardMaterial({ color: '#9aa0a8', metalness: 0.9, roughness: 0.28 }),
    powderCoat: new THREE.MeshStandardMaterial({ color: PALETTE.steel, metalness: 0.35, roughness: 0.7 }),
    rubber: new THREE.MeshStandardMaterial({ color: PALETTE.rubber, roughness: 0.92 }),
    blackPlastic: new THREE.MeshStandardMaterial({ color: '#18191b', roughness: 0.5, metalness: 0.05 }),
    bolt: new THREE.MeshStandardMaterial({ color: '#2b2d31', metalness: 0.8, roughness: 0.35 }),
  };
}
