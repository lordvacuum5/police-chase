// Traffic far off, as a simple shape of a car.
//
// "The lights are good in the dark, but not good in the day ... maybe just like almost just an outline of the car." Past
// FROM the real body (5,600 triangles) is swapped for this: a body, a cabin, dark glass and dark sills in the car's own
// paint, 92 triangles, all of them in one draw. A few pixels of a dark car on dark tarmac is what could not be seen, so the
// paint is lifted a little, and the shape drawn a little larger, the further off it is.
import * as THREE from 'three';

/** The real car inside the first of these, m; this outside the second; as it was between, so it does not flicker at the line. */
export const FROM = 112, BACK = 104;
/** Larger by this much at GROWN m, and lifted towards white by this share of the way. */
const GROW = 0.35, GROWN = 600, LIFT = 0.3;
const MAX = 320;

/** A car 1 wide, 1 high and 1 long, standing on y = 0, nose along +z: paint white (the instance's own), glass and sills dark. */
function carGeometry() {
  const pos = [], col = [];
  const quad = (a, b, c, d, k) => { for (const q of [a, b, c, a, c, d]) { pos.push(...q); col.push(k, k, k); } };
  // A prism along z: its outline [z, y] anticlockwise from the side, half width at the bottom and the top of it.
  const slab = (z0, z1, zt0, zt1, y0, y1, w0, w1, sideK, topK, endK) => {
    const P = (x, y, z) => [x, y, z];
    for (const s of [1, -1]) {
      const a = P(s * w0, y0, z0), b = P(s * w0, y0, z1), c = P(s * w1, y1, zt1), d = P(s * w1, y1, zt0);
      if (s > 0) quad(a, d, c, b, sideK); else quad(a, b, c, d, sideK);
    }
    quad(P(-w1, y1, zt0), P(-w1, y1, zt1), P(w1, y1, zt1), P(w1, y1, zt0), topK);
    quad(P(-w0, y0, z1), P(w0, y0, z1), P(w1, y1, zt1), P(-w1, y1, zt1), endK);
    quad(P(w0, y0, z0), P(-w0, y0, z0), P(-w1, y1, zt0), P(w1, y1, zt0), endK);
  };
  // The wheels and sills, the body, its shoulder, the glass, the roof.
  for (const z of [-0.31, 0.31]) slab(z - 0.075, z + 0.075, z - 0.075, z + 0.075, 0, 0.3, 0.48, 0.48, 0.06, 0.06, 0.06);
  slab(-0.47, 0.47, -0.48, 0.48, 0.14, 0.26, 0.45, 0.46, 0.1, 0.1, 0.1);
  slab(-0.48, 0.48, -0.5, 0.5, 0.26, 0.5, 0.48, 0.5, 1, 1, 0.92);
  slab(-0.5, 0.5, -0.47, 0.46, 0.5, 0.64, 0.5, 0.46, 1, 1, 0.8);
  slab(-0.42, 0.24, -0.3, 0.1, 0.64, 0.94, 0.45, 0.38, 0.16, 1, 0.2);
  slab(-0.3, 0.1, -0.28, 0.08, 0.94, 1, 0.38, 0.35, 1, 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _white = new THREE.Color(0xdfe6ee);

export class FarCars {
  constructor(scene) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(carGeometry(), mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.set(0xffffff));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = 'far-cars';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** Every frame: the cars `{ v, paint }` marked far (Game._cullTraffic, `v._far`), where they are drawn, from `camera`. */
  update(cars, camera, night) {
    let n = 0;
    for (const { v, paint } of cars) {
      if (n >= MAX) break;
      if (!v._far || !v.view) continue;
      const p = v.view.position, d = p.distanceTo(camera.position), u = Math.min(1, Math.max(0, (d - FROM) / (GROWN - FROM)));
      const k = 1 + GROW * u, s = v.spec.dims;
      // Its wheels on the road: the body's middle is this far over them.
      _p.copy(v.wheels[0].pos);
      const low = _p.y - (v.spec.suspension.rest - v.wheels[0].compression) - v.spec.wheelRadius;
      _p.set(0, low, 0).applyQuaternion(v.view.quaternion).add(p);
      _s.set(s.w * k, (s.h + 0.22) * k, s.l * k);
      _m.compose(_p, v.view.quaternion, _s);
      this.mesh.setMatrixAt(n, _m);
      _c.setHex(paint === undefined ? 0x8d939a : paint);
      if (!night) _c.lerp(_white, LIFT * (0.35 + 0.65 * u));
      this.mesh.setColorAt(n, _c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}
