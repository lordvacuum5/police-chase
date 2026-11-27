// A car's model with fewer triangles, made from the model itself when the game loads.
//
// "It's very obvious to the human eye that it's suddenly becoming really detailed." The far traffic was one made-up shape
// for every car. This is the car's own model with its points gathered into cells of a few centimetres: at the distance it
// is used a cell is about a pixel. The paint is the instance's, everything else (glass, lamps, trim, a livery) has its
// colour baked into its points, with the same roughness and metal, so it is lit as the real one is.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _col = new THREE.Color(), _tex = new THREE.Color(), _inv = new THREE.Matrix4(), _nm = new THREE.Matrix3();

/** A texture's pixels, small: each is the average of what is round it. */
const pixelCache = new Map();
function pixels(tex) {
  if (!tex || !tex.image) return null;
  if (pixelCache.has(tex.image)) return pixelCache.get(tex.image);
  let out = null;
  try {
    const S = Math.min(256, tex.image.width), c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(tex.image, 0, 0, S, S);
    out = { d: x.getImageData(0, 0, S, S).data, S };
  } catch (e) { /* its plain colour, then */ }
  pixelCache.set(tex.image, out);
  return out;
}

function sample(p, flip, u, v, out) {
  const w = (t) => t - Math.floor(t);
  const i = Math.min(p.S - 1, Math.floor(w(u) * p.S)), j = Math.min(p.S - 1, Math.floor((flip ? 1 - w(v) : w(v)) * p.S)), k = (j * p.S + i) * 4;
  out[0] = p.d[k] / 255; out[1] = p.d[k + 1] / 255; out[2] = p.d[k + 2] / 255;
  return out;
}

/** Where the wheels are as the car stands, in the body's own frame, and how far its middle is off the road. */
export function standing(spec) {
  const sus = spec.suspension;
  const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
  // Settled as far into the springs as a remote car's (Game: compression 0.6 of rest).
  const wy = sus.mountY - (sus.rest - sus.rest * 0.6);
  return {
    wheels: [
      [spec.trackFront / 2, wy, a, true], [-spec.trackFront / 2, wy, a, true],
      [spec.trackRear / 2, wy, -b, false], [-spec.trackRear / 2, wy, -b, false],
    ],
    bodyY: spec.wheelRadius - wy,
  };
}

/**
 * `root` (a model, drawn with its wheels `wheelGeo` by the `spec`) in cells of `cell` metres. Attributes: position, normal,
 * color (linear), surf (how much of the colour is the instance's paint, roughness, metal).
 */
export function simplifyCar(root, spec, wheelGeo, cell) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const cells = new Map(), verts = new Map(), tris = new Map();
  const cellOf = (x, y, z) => {
    const ix = Math.round(x / cell), iy = Math.round(y / cell), iz = Math.round(z / cell);
    const k = `${ix},${iy},${iz}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { id: cells.size, x: 0, y: 0, z: 0, n: 0 }));
    c.x += x; c.y += y; c.z += z; c.n++;
    return c;
  };
  const rgb = [0, 0, 0];
  const w = [0, 1, 2].map(() => new THREE.Vector3()), m = [0, 1, 2].map(() => new THREE.Vector3());
  const add = (geo, mat, matrix) => {
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, C = geo.attributes.color, I = geo.index;
    const paint = mat && mat.name === 'paint' ? 1 : 0;
    const map = U && mat && pixels(mat.map), mr = U && mat && pixels(mat.roughnessMap), mm = U && mat && pixels(mat.metalnessMap);
    const flip = mat && mat.map && mat.map.flipY;
    _nm.getNormalMatrix(matrix);
    const n = I ? I.count : P.count, mirrored = matrix.determinant() < 0;
    const ix = [0, 0, 0], cs = [null, null, null];
    for (let t = 0; t + 2 < n; t += 3) {
      ix[0] = I ? I.getX(t) : t; ix[1] = I ? I.getX(t + 1) : t + 1; ix[2] = I ? I.getX(t + 2) : t + 2;
      if (mirrored) { const s = ix[0]; ix[0] = ix[2]; ix[2] = s; }
      // Which cells its corners fall in first: most of a model's triangles are inside one or two, and are dropped,
      // and everything else asked of them below (normals, the textures' colours) was being worked out for nothing.
      // "The American map loads much worse": FarCars, all of this, took 1.4 s of every map's load. (Keys as numbers
      // rather than strings measured slower: 2.4 s against 1.1-1.6 s for every car at every cell size it uses.)
      for (let k = 0; k < 3; k++) {
        w[k].fromBufferAttribute(P, ix[k]).applyMatrix4(matrix);
        cs[k] = cellOf(w[k].x, w[k].y, w[k].z);
      }
      if (cs[0] === cs[1] || cs[1] === cs[2] || cs[0] === cs[2]) continue;
      let u = 0, vv = 0, r = 0, g = 0, bl = 0;
      for (let k = 0; k < 3; k++) {
        const i = ix[k];
        if (N) m[k].fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
        if (U) { u += U.getX(i) / 3; vv += U.getY(i) / 3; }
        if (C) { r += C.getX(i) / 3; g += C.getY(i) / 3; bl += C.getZ(i) / 3; }
      }
      _col.setRGB(1, 1, 1);
      if (C) _col.setRGB(r, g, bl);
      if (map) { sample(map, flip, u, vv, rgb); _col.multiply(_tex.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)); }
      if (mat && mat.color && !paint) _col.multiply(mat.color);
      if (paint) _col.setRGB(1, 1, 1);
      let rough = mat && mat.roughness !== undefined ? mat.roughness : 1, metal = mat && mat.metalness !== undefined ? mat.metalness : 0;
      if (mr) rough *= sample(mr, flip, u, vv, rgb)[1];
      if (mm) metal *= sample(mm, flip, u, vv, rgb)[2];
      const q = (x) => Math.round(x * 12), look = `${q(_col.r)},${q(_col.g)},${q(_col.b)},${paint},${q(rough)},${q(metal)}`;
      const vs = cs.map((c, k) => {
        const d = m[k], ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
        const face = ax > ay && ax > az ? (d.x > 0 ? 0 : 1) : ay > az ? (d.y > 0 ? 2 : 3) : (d.z > 0 ? 4 : 5);
        const key = `${c.id}|${face}|${look}`;
        let o = verts.get(key);
        if (!o) verts.set(key, (o = { c, nx: 0, ny: 0, nz: 0, r: _col.r, g: _col.g, b: _col.b, paint, rough, metal, i: -1 }));
        o.nx += d.x; o.ny += d.y; o.nz += d.z;
        return o;
      });
      // One triangle between the same three cells facing the same way.
      let a = 0;
      for (let k = 1; k < 3; k++) if (cs[k].id < cs[a].id) a = k;
      const i0 = cs[a].id, i1 = cs[(a + 1) % 3].id, i2 = cs[(a + 2) % 3].id;
      const key = `${i0},${i1},${i2}`;
      if (!tris.has(key)) tris.set(key, vs);
    }
  };
  root.traverse((o) => {
    if (o.isMesh && o.geometry) add(o.geometry, Array.isArray(o.material) ? null : o.material, new THREE.Matrix4().multiplyMatrices(_inv, o.matrixWorld));
  });
  if (wheelGeo) {
    const rs = spec.wheelRadius / 0.34, at = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const [x, y, z, front] of standing(spec).wheels) {
      const width = !front && spec.wheelWidthRear ? spec.wheelWidthRear : spec.wheelWidth;
      add(wheelGeo, null, new THREE.Matrix4().compose(at.set(x, y, z), q, sc.set(width / 0.26, rs, rs)));
    }
  }
  for (const c of cells.values()) { c.x /= c.n; c.y /= c.n; c.z /= c.n; }
  const pos = [], nor = [], col = [], surf = [], index = [];
  for (const [A, B, C] of tris.values()) {
    _a.set(B.c.x - A.c.x, B.c.y - A.c.y, B.c.z - A.c.z);
    _b.set(C.c.x - A.c.x, C.c.y - A.c.y, C.c.z - A.c.z);
    _v.crossVectors(_a, _b);
    if (_v.lengthSq() < 1e-12) continue;
    _n.set(A.nx + B.nx + C.nx, A.ny + B.ny + C.ny, A.nz + B.nz + C.nz);
    for (const o of _v.dot(_n) < 0 ? [A, C, B] : [A, B, C]) {
      if (o.i < 0) {
        o.i = pos.length / 3;
        pos.push(o.c.x, o.c.y, o.c.z);
        _n.set(o.nx, o.ny, o.nz);
        if (_n.lengthSq() < 1e-9) _n.copy(_v);
        _n.normalize();
        nor.push(_n.x, _n.y, _n.z);
        col.push(o.r, o.g, o.b);
        surf.push(o.paint, o.rough, o.metal);
      }
      index.push(o.i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 3));
  g.setIndex(index);
  return g;
}

/** One material for all of them: the paint the instance's, and `lodFade` of its pixels drawn. */
export function carLodMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 surf;\nattribute float lodFade;\nvarying vec3 vSurf;\nvarying float vLodFade;')
      .replace('#include <color_vertex>', `
        vColor = vec4(color, 1.0);
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, surf.x);
        #endif
        vSurf = surf; vLodFade = lodFade;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;\nvarying float vLodFade;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLodFade < 0.999 && fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715)))) >= vLodFade) discard;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurf.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurf.z;');
  };
  mat.customProgramCacheKey = () => 'car-lod';
  return mat;
}
