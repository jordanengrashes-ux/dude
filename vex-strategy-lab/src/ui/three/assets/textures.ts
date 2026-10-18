import * as THREE from 'three';
import { HALF, TAPE_WIDTH, tapeStrips, TILE } from '../../../field/geometry';
import { Rng } from '../../../core/rng';

/**
 * Procedural textures (no image downloads): foam field tiles with interlocking
 * edges and white tape, the 0.5"-pitch hole pattern of VEX structure, and
 * alliance license plates.
 */

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

/** Field floor: 6 × 6 foam tiles (600 mm) with puzzle-edge seams, foam grain and tape lines. */
export function fieldTextures(px = 2048): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const { c, g } = canvas(px, px);
  const { c: cb, g: gb } = canvas(px, px);
  const s = px / (2 * HALF);
  const X = (x: number) => (x + HALF) * s;
  const Y = (y: number) => (HALF - y) * s;
  const rng = new Rng(7);
  // tiles with slight per-tile shade variation
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      const v = 86 + Math.round((rng.next() - 0.5) * 6);
      g.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
      g.fillRect(i * TILE * s, j * TILE * s, TILE * s, TILE * s);
    }
  gb.fillStyle = '#808080';
  gb.fillRect(0, 0, px, px);
  // foam grain: fine speckle in both color and bump
  const img = g.getImageData(0, 0, px, px);
  const bimg = gb.getImageData(0, 0, px, px);
  for (let k = 0; k < img.data.length; k += 4) {
    const n = (rng.next() - 0.5) * 10;
    img.data[k] += n;
    img.data[k + 1] += n;
    img.data[k + 2] += n;
    const b = 128 + (rng.next() - 0.5) * 40;
    bimg.data[k] = bimg.data[k + 1] = bimg.data[k + 2] = b;
  }
  g.putImageData(img, 0, 0);
  gb.putImageData(bimg, 0, 0);
  // interlocking seams: a dark groove with alternating tabs every ~2" along each tile edge
  const seam = (x0: number, y0: number, x1: number, y1: number) => {
    const horiz = y0 === y1;
    const len = horiz ? Math.abs(x1 - x0) : Math.abs(y1 - y0);
    const tab = 2.0; // in
    const depth = 0.7; // in
    for (const [ctx, col, w] of [
      [g, 'rgba(25,26,28,0.85)', 0.12],
      [gb, '#303030', 0.16],
    ] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w * s;
      ctx.beginPath();
      let flip = 1;
      for (let d = 0; d < len - 1e-6; d += tab) {
        const a = d;
        const b = Math.min(len, d + tab);
        const off = flip * depth * 0.5;
        if (horiz) {
          const yy = y0 + off;
          ctx.moveTo(X(x0 + a), Y(yy));
          ctx.lineTo(X(x0 + b), Y(yy));
          ctx.lineTo(X(x0 + b), Y(y0 - off));
        } else {
          const xx = x0 + off;
          ctx.moveTo(X(xx), Y(y0 + a));
          ctx.lineTo(X(xx), Y(y0 + b));
          ctx.lineTo(X(x0 - off), Y(y0 + b));
        }
        flip = -flip;
      }
      ctx.stroke();
    }
  };
  for (let k = -2; k <= 2; k++) {
    seam(-HALF, k * TILE, HALF, k * TILE);
    seam(k * TILE, -HALF, k * TILE, HALF);
  }
  // vinyl tape: the Autonomous Line's two strips, the Midfield diamond, the Quadrant
  // diagonal and the colored Load Zone L's
  const tapeCol = { white: '#f1f1ee', red: '#c8352f', blue: '#2f6fd0' } as const;
  for (const [ctx, bumpCol] of [
    [g, null],
    [gb, '#9a9a9a'],
  ] as const) {
    ctx.lineWidth = TAPE_WIDTH * s;
    ctx.lineCap = 'square';
    for (const t of tapeStrips()) {
      ctx.strokeStyle = bumpCol ?? tapeCol[t.color];
      ctx.beginPath();
      ctx.moveTo(X(t.a.x), Y(t.a.y));
      ctx.lineTo(X(t.b.x), Y(t.b.y));
      ctx.stroke();
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(cb);
  bump.anisotropy = 8;
  return { map, bump };
}

/**
 * Hole pattern of VEX structural metal: square holes on a 0.5" pitch. Returned as
 * an alpha map (white = metal) to cut real holes with alphaTest; `repeat` is set
 * per use so one tile = 0.5" × 0.5".
 */
export function holeAlpha(): THREE.CanvasTexture {
  const { c, g } = canvas(64, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#000000';
  const h = 64 * (0.182 / 0.5); // 0.182" square holes
  g.fillRect(32 - h / 2, 32 - h / 2, h, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Alliance license plate with the robot's id. */
export function licensePlate(text: string, alliance: 'red' | 'blue'): THREE.CanvasTexture {
  const { c, g } = canvas(512, 128);
  g.fillStyle = alliance === 'red' ? '#c8202f' : '#1f5fd1';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#ffffff';
  g.font = '700 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** V5 Brain touchscreen showing a minimal dashboard. */
export function brainScreen(label: string): THREE.CanvasTexture {
  const { c, g } = canvas(256, 160);
  const grd = g.createLinearGradient(0, 0, 0, 160);
  grd.addColorStop(0, '#0f2236');
  grd.addColorStop(1, '#081420');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#d6e6f5';
  g.font = '600 28px system-ui, sans-serif';
  g.fillText(label, 14, 40);
  g.fillStyle = '#5fb3ff';
  g.font = '500 18px system-ui, sans-serif';
  g.fillText('Program running', 14, 74);
  g.fillStyle = '#2b4a66';
  g.fillRect(14, 96, 228, 10);
  g.fillStyle = '#3fd27a';
  g.fillRect(14, 96, 170, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
