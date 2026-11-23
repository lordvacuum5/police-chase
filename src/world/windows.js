// Windows on every wall.
//
// "Windows on every wall, lit at night." A Wexbury house had a door and two windows on its front and
// nothing anywhere else, so from a side street or behind, every house was a blank box. Now each wall gets
// a row of windows a floor, flat panels (two triangles each) a few centimetres proud of the wall, drawn
// into the building's own mesh. And a share of them, chosen by where they are, is copied into a second,
// unlit mesh in warm light, a hair further out, shown only at night (Weather._apply, `setNight`).

import * as THREE from 'three';
import { MeshBuilder } from '../util/meshbuild.js';

const GLASS = 0x16202a;
const WARM = 0xffc56b;
const WIN_W = 0.95, WIN_H = 1.15;
/** One window for about this much wall, m, and how many of them are lit at night. */
const EVERY = 3.0;
const LIT = 0.35;

function hash(x, z) {
  let h = Math.imul(Math.round(x * 7) ^ 0x2545f491, 0x85ebca6b) ^ Math.imul(Math.round(z * 7) + 0x68e31da4, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function quad(b, cx, cy, cz, nx, nz, w, h, colour) {
  const tx = -nz, tz = nx, hw = w * 0.5, hh = h * 0.5;
  const c = [
    { x: cx - tx * hw, y: cy - hh, z: cz - tz * hw },
    { x: cx + tx * hw, y: cy - hh, z: cz + tz * hw },
    { x: cx + tx * hw, y: cy + hh, z: cz + tz * hw },
    { x: cx - tx * hw, y: cy + hh, z: cz - tz * hw },
  ];
  b.addDecalQuad(c, { x: nx, y: 0, z: nz }, [0, 0, 0, 0], colour);
}

/**
 * Windows round a house of frontage `w`, depth `d`, height `h`, standing at (x, z), turned `rot`, whose
 * front faces (fx, fz). `front`: 'house' -- its upper windows and door are there already (towngen), so
 * only the ground floor either side of the door; 'shop' -- its glazed front is, so only the floor above;
 * 'all'. Dark ones into `b`; lit ones into `lit`, a MeshBuilder.
 */
export function addWindows(b, lit, x, z, w, h, d, rot, fx, fz, front = 'all') {
  const ox = Math.cos(rot), oz = -Math.sin(rot);
  const floors = h > 5.5 ? [1.5, Math.min(h - 1.6, 4.6)] : [1.5];
  // Front, back, and the two ends: [outward x, z, half-depth to the wall, length of the wall].
  const faces = [
    [fx, fz, d * 0.5, w, 'front'], [-fx, -fz, d * 0.5, w, 'back'],
    [ox, oz, w * 0.5, d, 'side'], [-ox, -oz, w * 0.5, d, 'side'],
  ];
  for (const [nx, nz, off, len, kind] of faces) {
    const n = Math.max(1, Math.floor(len / EVERY));
    // Along the wall: the horizontal at right angles to the way it faces.
    const tx = -nz, tz = nx;
    for (const y of floors) {
      // A house's front already has its upper windows and its door; a shop's its glazed front below.
      if (kind === 'front' && front === 'house' && y > 2) {
        // Its own two, lit or not like any other (towngen puts them at a quarter of the frontage either side).
        for (const sgn of [-1, 1]) {
          const cx = x + nx * (off + 0.13) + tx * sgn * w * 0.28, cz = z + nz * (off + 0.13) + tz * sgn * w * 0.28;
          if (lit && hash(cx, cz + y) < LIT) quad(lit, cx, h * 0.55, cz, nx, nz, w * 0.2, h * 0.16, WARM);
        }
        continue;
      }
      if (kind === 'front' && front === 'shop' && y < 2) continue;
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * (len / n);
        // Not over the door, which is in the middle of the front.
        if (kind === 'front' && front === 'house' && y < 2 && Math.abs(along) < 1.2) continue;
        const cx = x + nx * (off + 0.05) + tx * along, cz = z + nz * (off + 0.05) + tz * along;
        quad(b, cx, y, cz, nx, nz, WIN_W, WIN_H, GLASS);
        if (lit && hash(cx, cz + y) < LIT) quad(lit, cx + nx * 0.02, y, cz + nz * 0.02, nx, nz, WIN_W * 0.92, WIN_H * 0.92, WARM);
      }
    }
  }
}

/** The lit windows as a mesh, hidden by day: `mesh.userData.setNight(on)` shows it. */
export function litWindows(lit) {
  if (!lit || !lit.vertexCount) return null;
  const geo = lit.build();
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  // A soft warm glow round each, a little out from the wall: "night glow", as the street lamps' bloom.
  const p = geo.attributes.position, nq = p.count / 6;
  const centres = new Float32Array(nq * 3);
  for (let i = 0; i < nq; i++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 6; k++) { x += p.getX(i * 6 + k); y += p.getY(i * 6 + k); z += p.getZ(i * 6 + k); }
    centres[i * 3] = x / 6; centres[i * 3 + 1] = y / 6; centres[i * 3 + 2] = z / 6;
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(centres, 3));
  const glow = new THREE.Points(cg, new THREE.PointsMaterial({
    color: 0xffb860, map: glowSpot(), size: 3.2, sizeAttenuation: true, transparent: true,
    opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  m.add(glow);
  m.name = 'windows-lit';
  m.visible = false;
  m.userData.setNight = (on) => { m.visible = on; };
  return m;
}

let spot = null;
function glowSpot() {
  if (spot) return spot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.3)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  spot = new THREE.CanvasTexture(c);
  return spot;
}

export { MeshBuilder };
