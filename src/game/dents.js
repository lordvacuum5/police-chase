// Dents where a car was hit.
//
// "Do the crash dents, single player only." On a hard knock the body's surface nearest the hit is pushed
// in, more for a harder one, up to DENT_DEEPEST from where it was made; nothing else about the car
// changes. All the work is at the moment of the hit, never per frame -- "it's pretty on the edge already of
// lagging" -- and only for the player's car and cars within DENT_NEAR of it, with nobody else playing.
// A car's geometry is shared between every car of its kind, so a dented one gets its own copy first.
// Repaired (Vehicle.repair), it has the shared one back.
import * as THREE from 'three';

/** Knocks under this, m/s, leave no mark; this is how deep a knock of DENT_HARD m/s goes, m; never further in than this from the original; over this radius, m. */
const DENT_FROM = 7;
const DENT_HARD = 30;
const DENT_DEEP = 0.34;
const DENT_DEEPEST = 0.55;
const DENT_RADIUS = 1.0;
/** How much of a dent's depth varies from point to point, so it looks crumpled. */
const DENT_ROUGH = 0.4;
/** Only these: the player's own car, and any within this many metres of it. */
const DENT_NEAR = 70;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Dents {
  constructor(game) {
    this.game = game;
    this.dented = new Set();
  }

  /** After each frame's physics: any new hard knocks, and anything mended. */
  update(online) {
    const g = this.game, p = g.player;
    if (!p) return;
    for (const v of g.vehicles) {
      const h = v.lastHit;
      if (h && h.at !== v._dentAt) {
        v._dentAt = h.at;
        if (!this.dented.has(v)) v._dentRepairs = v.repairs || 0;
        if (!online && !window.__noDents && !h.ground && h.dv >= DENT_FROM && v.view && !v.isAircraft
          && (v === p || Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z) < DENT_NEAR)) {
          this._dent(v, h);
        }
      }
    }
    for (const v of this.dented) {
      if (!g.vehicles.includes(v)) { this.dented.delete(v); continue; }
      if ((v.repairs || 0) !== v._dentRepairs) this.mend(v);
    }
  }

  /** The shared geometry back on every part of it. */
  mend(v) {
    if (v.view) {
      v.view.traverse((o) => {
        if (o.isMesh && o.userData.dentFrom) {
          o.geometry.dispose();
          o.geometry = o.userData.dentFrom;
          o.userData.dentFrom = null;
          o.userData.dentRest = null;
        }
      });
    }
    this.dented.delete(v);
  }

  _dent(v, h) {
    const view = v.view;
    // The way the car was knocked, in its own frame: it moved away from what hit it, so what hit it is
    // the other way, and the dent goes in the way it was knocked.
    _q.copy(v.quaternion).invert();
    _d.set(h.x, h.y, h.z).applyQuaternion(_q);
    if (_d.lengthSq() < 1e-6) return;
    _d.normalize();
    // Where that line from the middle leaves the body's box.
    const dims = v.spec.dims;
    const hx = dims.w * 0.5, hy = dims.h * 0.5, hz = dims.l * 0.5;
    const t = Math.min(
      Math.abs(_d.x) > 1e-3 ? hx / Math.abs(_d.x) : Infinity,
      Math.abs(_d.y) > 1e-3 ? hy / Math.abs(_d.y) : Infinity,
      Math.abs(_d.z) > 1e-3 ? hz / Math.abs(_d.z) : Infinity,
    );
    const cy = (v.spec.colliderY === undefined ? 0.1 : v.spec.colliderY) + hy * 0.2;
    _p.set(-_d.x * t, cy - _d.y * t, (v.spec.colliderZ || 0) - _d.z * t);
    const depth = Math.min(DENT_DEEP * 1.6, DENT_DEEP * (h.dv - DENT_FROM) / (DENT_HARD - DENT_FROM));
    const radius = DENT_RADIUS * (0.8 + 0.4 * Math.min(1, h.dv / DENT_HARD));
    if (depth <= 0.005) return;
    view.updateMatrixWorld(true);
    const at = new THREE.Vector3(), dir = new THREE.Vector3();
    view.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      // The point and the push, from the car's frame into this part's.
      const toPart = new THREE.Matrix4().copy(o.matrixWorld).invert().multiply(view.matrixWorld);
      at.copy(_p).applyMatrix4(toPart);
      dir.copy(_d).transformDirection(toPart);
      const scale = new THREE.Vector3().setFromMatrixScale(toPart).x || 1;
      const r = radius * scale, deep = depth * scale, most = DENT_DEEPEST * scale;
      if (!o.userData.dentFrom) {
        // Only parts that reach the place at all are worth copying.
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        if (o.geometry.boundingBox.distanceToPoint(at) > r) return;
        o.userData.dentFrom = o.geometry;
        o.geometry = o.geometry.clone();
        o.userData.dentRest = o.geometry.attributes.position.array.slice();
      }
      const pos = o.geometry.attributes.position, rest = o.userData.dentRest;
      const a = pos.array;
      const hit = new Uint8Array(pos.count);
      let moved = false;
      for (let i = 0; i < a.length; i += 3) {
        const dx = a[i] - at.x, dy = a[i + 1] - at.y, dz = a[i + 2] - at.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r) continue;
        const k = 1 - Math.sqrt(d2) / r;
        // Crumpled, not smooth: a smooth one read as the car's own styling. The roughness goes by where the
        // point was made, so two points made in the same place (a seam) go the same way and nothing splits.
        const push = deep * k * k * (1 - DENT_ROUGH + 2 * DENT_ROUGH * rough(rest[i], rest[i + 1], rest[i + 2], scale));
        let nx = a[i] + dir.x * push, ny = a[i + 1] + dir.y * push, nz = a[i + 2] + dir.z * push;
        // No deeper than DENT_DEEPEST from where it was made.
        const ox = nx - rest[i], oy = ny - rest[i + 1], oz = nz - rest[i + 2];
        const off = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (off > most) { const s = most / off; nx = rest[i] + ox * s; ny = rest[i + 1] + oy * s; nz = rest[i + 2] + oz * s; }
        a[i] = nx; a[i + 1] = ny; a[i + 2] = nz;
        hit[i / 3] = 1;
        moved = true;
      }
      if (moved) {
        pos.needsUpdate = true;
        shadeAgain(o.geometry, hit);
      }
    });
    this.dented.add(v);
  }
}

/**
 * New normals for the moved points only, from the faces that touch them. computeVertexNormals over the whole
 * body took 36 ms on the runner (26,641 points), a hitch you could see, and on an imported model it also
 * smoothed every hard edge the model was made with.
 */
function shadeAgain(geo, hit) {
  const pos = geo.attributes.position.array, nrm = geo.attributes.normal;
  if (!nrm) { geo.computeVertexNormals(); return; }
  const acc = new Float32Array(hit.length * 3);
  const idx = geo.index ? geo.index.array : null;
  const faces = idx ? idx.length : pos.length / 3;
  for (let f = 0; f < faces; f += 3) {
    const i0 = idx ? idx[f] : f, i1 = idx ? idx[f + 1] : f + 1, i2 = idx ? idx[f + 2] : f + 2;
    if (!hit[i0] && !hit[i1] && !hit[i2]) continue;
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    const ux = pos[i1 * 3] - ax, uy = pos[i1 * 3 + 1] - ay, uz = pos[i1 * 3 + 2] - az;
    const vx = pos[i2 * 3] - ax, vy = pos[i2 * 3 + 1] - ay, vz = pos[i2 * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (hit[i0]) { acc[i0 * 3] += cx; acc[i0 * 3 + 1] += cy; acc[i0 * 3 + 2] += cz; }
    if (hit[i1]) { acc[i1 * 3] += cx; acc[i1 * 3 + 1] += cy; acc[i1 * 3 + 2] += cz; }
    if (hit[i2]) { acc[i2 * 3] += cx; acc[i2 * 3 + 1] += cy; acc[i2 * 3 + 2] += cz; }
  }
  const n = nrm.array;
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i]) continue;
    const x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-12) { n[i * 3] = x / l; n[i * 3 + 1] = y / l; n[i * 3 + 2] = z / l; }
  }
  nrm.needsUpdate = true;
}

/** 0..1, smooth, the same for the same place, rising and falling every 30 cm or so. */
function rough(x, y, z, scale) {
  const k = 1 / scale;
  return 0.5 + 0.5 * Math.sin(x * k * 19 + 1.3) * Math.sin(y * k * 23 + 0.4) * Math.sin(z * k * 17 + 2.1);
}
