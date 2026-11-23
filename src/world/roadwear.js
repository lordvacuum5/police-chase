// Wear on the roads.
//
// "Road detail next." The tarmac has a grain now (world/groundtex.js), but no road is the same all the way
// across: the lanes are polished darker where the tyres run, grime gathers along the kerbs, and there are
// cracks, patched trenches and drains. All of that depends on where across the road a point is, which the
// tarmac's world-position mapping does not know. So this is one more layer over the carriageway, laid
// along every road between its junction mouths, mapped across it (0 at one edge, 1 at the other) and along
// it, with a see-through texture: paler dust and polish, which is what shows on tarmac this dark (darkening alone did not). One mesh and one texture for the whole map.
//
// Tyre tracks at a sixth and a third of the way across each half of the road. Once across every road: twice
// across on the wide ones put a kerb's drain down the middle. The first cracks (26 a repeat, up to 0.45
// strong) looked like lightning and the patches like holes: now 9, about 0.15, and the patches half as dark.
//
// `window.__noRoadWear = true` before load leaves it out.

import * as THREE from 'three';
import { sliceLine } from './junctions.js';

/** Metres of road one repeat of the texture covers. */
const WEAR_TILE = 24;
/** Metres at each end of a road over which the wear fades in and out. */
const FADE = 6;
const W = 256, H = 1024;

let tex = null;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function wearTexture() {
  if (tex) return tex;
  const r = rng(301);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.clearRect(0, 0, W, H);
  // Lighter marks, not darker: on tarmac this dark, darkening did not show at all. Dust and grit gather
  // along the kerbs.
  for (const side of [0, 1]) {
    const g = x.createLinearGradient(side ? W : 0, 0, side ? W * 0.85 : W * 0.15, 0);
    g.addColorStop(0, 'rgba(150,140,120,0.34)');
    g.addColorStop(1, 'rgba(150,140,120,0)');
    x.fillStyle = g;
    x.fillRect(side ? W * 0.85 : 0, 0, W * 0.15, H);
  }
  // Tyre tracks: two in each lane, polished paler than the road between them, soft-edged, wandering.
  for (const u of [1 / 6, 2 / 6, 4 / 6, 5 / 6]) {
    let cx = u * W;
    for (let y = 0; y < H; y += 4) {
      cx += (r() - 0.5) * 0.6;
      cx += (u * W - cx) * 0.02;
      const a = 0.12 + 0.05 * Math.sin(y * 0.013 + u * 9) + r() * 0.03;
      const g = x.createLinearGradient(cx - 14, 0, cx + 14, 0);
      g.addColorStop(0, 'rgba(170,170,165,0)');
      g.addColorStop(0.5, `rgba(170,170,165,${a})`);
      g.addColorStop(1, 'rgba(170,170,165,0)');
      x.fillStyle = g;
      x.fillRect(cx - 14, y, 28, 4);
    }
  }
  // Patches: a trench dug and filled across a lane, or a square of newer, blacker tarmac, with a pale seam
  // of sealant round it.
  for (let k = 0; k < 4; k++) {
    const px = r() * W * 0.7, py = r() * H, pw = W * (0.15 + r() * 0.35), ph = 30 + r() * 90;
    x.fillStyle = `rgba(0,0,0,${0.14 + r() * 0.1})`;
    x.fillRect(px, py, pw, ph);
    x.strokeStyle = 'rgba(175,175,170,0.18)';
    x.lineWidth = 2;
    x.strokeRect(px, py, pw, ph);
  }
  // Cracks: thin pale lines that wander (the dust in them), mostly near the edges and along the joint in the middle.
  for (let k = 0; k < 9; k++) {
    let px = [r() * W * 0.14, W * 0.5 + (r() - 0.5) * 20, W - r() * W * 0.14][k % 3];
    let py = r() * H;
    x.strokeStyle = `rgba(165,160,150,${0.1 + r() * 0.1})`;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(px, py);
    const n = 4 + Math.floor(r() * 8);
    for (let j = 0; j < n; j++) {
      px += (r() - 0.5) * 6;
      py += 3 + r() * 7;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  // Drains: a grating by each kerb, once a repeat: a pale frame and bars over black.
  for (const side of [0, 1]) {
    const gx = side ? W - 24 : 6, gy = 120 + side * H * 0.5;
    x.fillStyle = 'rgba(170,170,170,0.3)';
    x.fillRect(gx - 2, gy - 2, 22, 38);
    x.fillStyle = 'rgba(0,0,0,0.6)';
    x.fillRect(gx, gy, 18, 34);
    x.fillStyle = 'rgba(150,150,150,0.35)';
    for (let b = 0; b < 6; b++) x.fillRect(gx + 2, gy + 3 + b * 5, 14, 2);
  }
  tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** The wear layer for every road in `graph`, `y` metres up: one mesh, or null if there is nothing to draw. */
export function buildRoadWear(graph, y = 0.035) {
  if (window.__noRoadWear) return null;
  const pos = [], uv = [], nor = [], col = [], idx = [];
  for (const e of graph.edges) {
    if (e.cut || e.elevated) continue;
    // Nor an alley's stub into the street it joins (see buildRoadMeshes).
    if (e.kind === 'alley' && e.length < 15 && (graph.nodes[e.a].edges.length < 2 || graph.nodes[e.b].edges.length < 2)) continue;
    const line = sliceLine(e.points, e.trimA || 0, e.length - (e.trimB || 0));
    if (!line || line.length < 2) continue;
    const half = e.width * 0.5;
    // Once across, whatever the width: twice across put a kerb's drain and dust down the middle of the
    // wide roads.
    const lanes = 1;
    // A different stretch of the texture for each road, so neighbours do not match.
    let along = (e.id * 7.31) % WEAR_TILE;
    const start = along;
    let total = 0;
    for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    const base = pos.length / 3;
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      if (i > 0) along += Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z);
      const nx = -dz, nz = dx;
      pos.push(p.x + nx * half, y, p.z + nz * half, p.x - nx * half, y, p.z - nz * half);
      uv.push(0, along / WEAR_TILE, lanes, along / WEAR_TILE);
      nor.push(0, 1, 0, 0, 1, 0);
      // Faded in and out over the first and last FADE metres: stopping square at a junction mouth drew a
      // hard line across the road.
      const d = along - start, f = Math.max(0, Math.min(1, d / FADE, (total - d) / FADE));
      col.push(1, 1, 1, f, 1, 1, 1, f);
      if (i > 0) {
        const k = base + (i - 1) * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  const t = wearTexture();
  const m = new THREE.MeshLambertMaterial({
    map: t, transparent: true, depthWrite: false, vertexColors: true, vertexAlphas: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'road-wear';
  mesh.receiveShadow = true;
  return mesh;
}
