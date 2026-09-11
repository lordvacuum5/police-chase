// A tiny geometry builder.
//
// Everything visible in the game is generated at runtime -- there are no model
// files to load. To keep the draw call count low enough for integrated
// graphics, whole categories of object (a car body, a whole district of roads)
// are baked into one buffer here and drawn as a single mesh with vertex
// colours instead of one material per part.

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.uv = [];
  }

  get vertexCount() { return this.pos.length / 3; }

  /** Keep the UV array in step with however many vertices were just pushed. */
  _padUV(count) {
    for (let i = 0; i < count; i++) this.uv.push(0, 0);
  }

  /**
   * A flat textured quad, used for vehicle decals -- livery markings, wordmarks
   * and chevrons that would be impossible to express as geometry.
   *
   * Corners are given in order round the quad; the winding is corrected against
   * `outward` so the caller does not have to reason about it. UVs follow their
   * corners through any flip.
   */
  addDecalQuad(corners, outward, uvRect, tint = 0xffffff) {
    const [a, b, c, d] = corners;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    let quad = [a, b, c, d];
    let uvs = [
      [uvRect[0], uvRect[1]], [uvRect[2], uvRect[1]],
      [uvRect[2], uvRect[3]], [uvRect[0], uvRect[3]],
    ];
    if (nx * outward.x + ny * outward.y + nz * outward.z < 0) {
      quad = [a, d, c, b];
      uvs = [uvs[0], uvs[3], uvs[2], uvs[1]];
      nx = -nx; ny = -ny; nz = -nz;
    }

    _c.set(tint);
    const tri = (i0, i1, i2) => {
      for (const i of [i0, i1, i2]) {
        const p = quad[i];
        this.pos.push(p.x, p.y, p.z);
        this.norm.push(nx, ny, nz);
        this.col.push(_c.r, _c.g, _c.b);
        this.uv.push(uvs[i][0], uvs[i][1]);
      }
    };
    tri(0, 1, 2);
    tri(0, 2, 3);
    return this;
  }

  /** Append raw triangle data, transformed by `matrix` and tinted `color`. */
  addGeometry(geo, matrix, color) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position.array;
    const n = g.attributes.normal ? g.attributes.normal.array : null;

    _nm.getNormalMatrix(matrix);
    _c.set(color);
    const r = _c.r, gg = _c.g, b = _c.b;

    for (let i = 0; i < p.length; i += 3) {
      _v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      this.pos.push(_v.x, _v.y, _v.z);
      if (n) {
        _v.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(_nm).normalize();
        this.norm.push(_v.x, _v.y, _v.z);
      } else {
        this.norm.push(0, 1, 0);
      }
      this.col.push(r, gg, b);
    }
    if (g !== geo) g.dispose();
    return this;
  }

  /** Axis-aligned box, optionally rotated about Y. */
  addBox(w, h, d, x, y, z, color, rotY = 0) {
    const geo = new THREE.BoxGeometry(w, h, d);
    _m.makeRotationY(rotY).setPosition(x, y, z);
    this.addGeometry(geo, _m, color);
    geo.dispose();
    return this;
  }

  /**
   * A box whose top face is scaled in -- the workhorse for car cabins,
   * building crowns and anything that should not read as a plain cube.
   */
  addTaperedBox(w, h, d, x, y, z, color, topX = 1, topZ = 1, rotY = 0, shiftZ = 0) {
    const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
    const tw = hw * topX, td = hd * topZ;
    // 8 corners: bottom 0-3, top 4-7
    const v = [
      [-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd],
      [-tw, hh, -td + shiftZ], [tw, hh, -td + shiftZ], [tw, hh, td + shiftZ], [-tw, hh, td + shiftZ],
    ];
    const faces = [
      [0, 1, 2], [0, 2, 3],       // bottom
      [4, 6, 5], [4, 7, 6],       // top
      [0, 5, 1], [0, 4, 5],       // -Z
      [2, 7, 3], [2, 6, 7],       // +Z
      [1, 6, 2], [1, 5, 6],       // +X
      [3, 4, 0], [3, 7, 4],       // -X
    ];

    _m.makeRotationY(rotY).setPosition(x, y, z);
    _nm.getNormalMatrix(_m);
    _c.set(color);

    const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();

    for (const f of faces) {
      a.fromArray(v[f[0]]).applyMatrix4(_m);
      b.fromArray(v[f[1]]).applyMatrix4(_m);
      cc.fromArray(v[f[2]]).applyMatrix4(_m);
      ab.subVectors(b, a); ac.subVectors(cc, a);
      nrm.crossVectors(ab, ac).normalize();
      for (const pt of [a, b, cc]) {
        this.pos.push(pt.x, pt.y, pt.z);
        this.norm.push(nrm.x, nrm.y, nrm.z);
        this.col.push(_c.r, _c.g, _c.b);
      }
    }
    return this;
  }

  /**
   * Flat quad on the ground plane, given four XZ corners at height y.
   *
   * The corners are re-wound if necessary so the quad always faces upwards.
   * Callers describe their corners in whatever order is natural for them --
   * a road ribbon walks left-edge-then-right-edge, a block plate goes round
   * clockwise -- and a back-facing ground polygon is simply invisible, which
   * is a maddening thing to debug.
   */
  addQuadY(x0, z0, x1, z1, x2, z2, x3, z3, y, color) {
    _c.set(color);
    // Shoelace: positive means the corners already wind the right way.
    const area = (x0 * z1 - x1 * z0) + (x1 * z2 - x2 * z1)
               + (x2 * z3 - x3 * z2) + (x3 * z0 - x0 * z3);
    if (area < 0) {
      const tx = x1, tz = z1;
      x1 = x3; z1 = z3;
      x3 = tx; z3 = tz;
    }

    const push = (x, z) => {
      this.pos.push(x, y, z);
      this.norm.push(0, 1, 0);
      this.col.push(_c.r, _c.g, _c.b);
    };
    push(x0, z0); push(x2, z2); push(x1, z1);
    push(x0, z0); push(x3, z3); push(x2, z2);
    return this;
  }

  /**
   * A flat ribbon along a polyline -- roads, kerbs and lane markings are all
   * built with this. `offset` shifts the ribbon sideways from the centreline,
   * which is how lane markings and pavements are placed.
   */
  addRibbon(points, width, y, color, offset = 0) {
    if (points.length < 2) return this;
    const left = [], right = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];

      // Direction of the segment either side of this vertex.
      let d1x = p.x - prev.x, d1z = p.z - prev.z;
      let l1 = Math.hypot(d1x, d1z);
      if (l1 < 1e-6) { d1x = next.x - p.x; d1z = next.z - p.z; l1 = Math.hypot(d1x, d1z) || 1; }
      d1x /= l1; d1z /= l1;
      let d2x = next.x - p.x, d2z = next.z - p.z;
      let l2 = Math.hypot(d2x, d2z);
      if (l2 < 1e-6) { d2x = d1x; d2z = d1z; l2 = 1; }
      d2x /= l2; d2z /= l2;

      // Left normals on the XZ plane, and the mitre direction between them.
      const n1x = -d1z, n1z = d1x;
      const n2x = -d2z, n2z = d2x;
      let mx = n1x + n2x, mz = n1z + n2z;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { mx = n1x; mz = n1z; } else { mx /= ml; mz /= ml; }

      // A mitre has to be *longer* than the half-width to reach the corner,
      // by 1/cos of the half-turn. Without this the ribbon pinches in at every
      // bend and leaves a notch of bare ground showing on the outside of it --
      // which is what made the town's roads look like they did not join up.
      // Capped so a hairpin does not fire a spike off into the distance.
      const scale = Math.min(2.6, 1 / Math.max(0.30, mx * n1x + mz * n1z));
      const hw = width * 0.5 * scale;
      const cx = p.x + mx * offset * scale, cz = p.z + mz * offset * scale;
      left.push({ x: cx + mx * hw, z: cz + mz * hw });
      right.push({ x: cx - mx * hw, z: cz - mz * hw });
    }

    for (let i = 0; i < points.length - 1; i++) {
      this.addQuadY(
        left[i].x, left[i].z,
        left[i + 1].x, left[i + 1].z,
        right[i + 1].x, right[i + 1].z,
        right[i].x, right[i].z,
        y, color,
      );
    }
    return this;
  }

  /**
   * A vertical wall following a polyline: the face of a kerb, or anything else
   * that is a line on the ground with a height to it.
   *
   * Double sided, because a kerb is seen from the road on one side and from
   * the footway on the other and neither is worth a second call.
   */
  addWall(points, y0, y1, color, offset = 0) {
    if (points.length < 2) return this;
    _c.set(color);
    const edge = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      let dx = next.x - prev.x, dz = next.z - prev.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      edge.push({ x: p.x - dz * offset, z: p.z + dx * offset });
    }

    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i], b = edge[i + 1];
      let nx = -(b.z - a.z), nz = b.x - a.x;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const quad = [
        [a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z],
        [a.x, y0, a.z], [b.x, y1, b.z], [a.x, y1, a.z],
      ];
      for (const side of [1, -1]) {
        const order = side > 0 ? quad : [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]];
        for (const v of order) {
          this.pos.push(v[0], v[1], v[2]);
          this.norm.push(nx * side, 0, nz * side);
          this.col.push(_c.r, _c.g, _c.b);
        }
      }
    }
    return this;
  }

  /** Dashed version of addRibbon, for centre lines. */
  addDashedRibbon(points, width, y, color, dash = 3, gap = 5, offset = 0) {
    let carry = 0;
    let on = true;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      let t = 0;
      while (t < segLen) {
        const span = on ? dash - carry : gap - carry;
        const step = Math.min(span, segLen - t);
        if (on && step > 0.15) {
          const t0 = t / segLen, t1 = (t + step) / segLen;
          const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
          const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
          this.addRibbon([p0, p1], width, y, color, offset);
        }
        t += step;
        carry += step;
        if (carry >= (on ? dash : gap) - 1e-6) { on = !on; carry = 0; }
      }
    }
    return this;
  }

  build() {
    this._padUV(this.vertexCount - this.uv.length / 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Concatenate several builders into one geometry with one material group each,
 * so a car can carry its painted bodywork and its textured decals in a single
 * mesh instead of two.
 */
export function buildGrouped(builders) {
  const live = builders.filter((b) => b.vertexCount > 0);
  for (const b of live) b._padUV(b.vertexCount - b.uv.length / 2);

  let total = 0;
  for (const b of live) total += b.vertexCount;

  const pos = new Float32Array(total * 3);
  const norm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  const g = new THREE.BufferGeometry();
  let v = 0;
  live.forEach((b, i) => {
    pos.set(b.pos, v * 3);
    norm.set(b.norm, v * 3);
    col.set(b.col, v * 3);
    uv.set(b.uv, v * 2);
    g.addGroup(v, b.vertexCount, i);
    v += b.vertexCount;
  });

  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  g.userData.groupCount = live.length;
  return g;
}

/** Standard material for everything built with vertex colours. */
export function vertexColorMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true }, opts));
}

export function shinyVertexMaterial(opts = {}) {
  return new THREE.MeshPhongMaterial(Object.assign({
    vertexColors: true, shininess: 45, specular: 0x333333,
  }, opts));
}
