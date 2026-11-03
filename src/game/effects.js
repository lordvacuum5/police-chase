// Skid marks and light bars.
//
// Both are pooled into fixed-size buffers that are written in place. Nothing
// here allocates during play, which matters on a machine where a garbage
// collection pause is visible as a dropped frame.

import * as THREE from 'three';
import { clamp01 } from '../util/math.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, -500, 0);

/** A ring buffer of quads laid down where the tyres are sliding. */
export class SkidMarks {
  constructor(scene, maxQuads = 2600) {
    this.max = maxQuads;
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxQuads * 6 * 3);
    this.alphas = new Float32Array(maxQuads * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, maxQuads * 6);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uColour: { value: new THREE.Color(0x0a0a0c) } },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColour;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(uColour, vAlpha * 0.55);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.geo = geo;
    this.dirty = false;
  }

  /** Lay a strip between two contact points of a given width. */
  add(from, to, width, intensity) {
    if (from.distanceToSquared(to) < 0.0009) return;
    _n.subVectors(to, from);
    _n.y = 0;
    const len = _n.length();
    if (len < 1e-4) return;
    _n.set(-_n.z / len, 0, _n.x / len).multiplyScalar(width * 0.5);

    const i = this.head * 18;
    const p = this.positions;
    // At the tyre's contact, just above it. These were laid at a fixed
    // 4.5 cm over sea level, which is the road on the flat maps -- and on
    // Haldon Vale's hills was under the ground, and down in the quarry, whose
    // floor is below zero, was a set of marks in the air: "all the tyre tracks
    // ... are at the normal ground level, so they're basically floating".
    const write = (o, v) => { p[o] = v.x; p[o + 1] = v.y + 0.045; p[o + 2] = v.z; };

    // Two triangles: (fromL, fromR, toR) and (fromL, toR, toL).
    _a.copy(from).add(_n); write(i + 0, _a); write(i + 9, _a);   // fromL
    _b.copy(from).sub(_n); write(i + 3, _b);                     // fromR
    _b.copy(to).sub(_n);   write(i + 6, _b); write(i + 12, _b);  // toR
    _a.copy(to).add(_n);   write(i + 15, _a);                    // toL

    const ai = this.head * 6;
    const a = clamp01(intensity);
    for (let k = 0; k < 6; k++) this.alphas[ai + k] = a;

    this.head = (this.head + 1) % this.max;
    this.dirty = true;
  }

  /** Fade the whole buffer slowly so marks do not accumulate forever. */
  update(dt) {
    if (this.dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.alpha.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear() {
    this.alphas.fill(0);
    this.geo.attributes.alpha.needsUpdate = true;
    this.head = 0;
  }
}

/**
 * Flashing light bars for every police car in one pair of instanced draws.
 * Off lamps are scaled to nothing rather than recoloured, which avoids needing
 * per-instance colour support in the material.
 */
export class LightBars {
  constructor(scene, capacity = 16) {
    this.capacity = capacity;
    const geo = new THREE.BoxGeometry(0.26, 0.12, 0.22);

    const mk = (colour) => {
      const m = new THREE.InstancedMesh(
        geo,
        new THREE.MeshBasicMaterial({ color: colour, toneMapped: false }),
        capacity,
      );
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    };

    this.red = mk(0xff2418);
    this.blue = mk(0x2f7dff);
    this.time = 0;
    this.count = 0;

    // A soft halo round each lit lamp. A lit box on its own reads as a coloured
    // brick on the roof; the halo is what makes it read as a light. Drawn as
    // additive points, so they cost one draw per colour however many cars.
    const halo = haloTexture();
    const glow = (colour) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
      geo.setDrawRange(0, 0);
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        color: colour, map: halo, size: 2.4, sizeAttenuation: true, transparent: true,
        opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      pts.frustumCulled = false;
      scene.add(pts);
      return pts;
    };
    this.glowRed = glow(0xff3a2a);
    this.glowBlue = glow(0x3f8cff);
    this._nRed = 0;
    this._nBlue = 0;
  }

  /** How strong the halo is: faint by day, much stronger in the dark. */
  setGlow(opacity, size) {
    for (const p of [this.glowRed, this.glowBlue]) {
      p.material.opacity = opacity;
      p.material.size = size;
    }
  }

  begin(dt) {
    this.time += dt;
    this.count = 0;
    this._nRed = 0;
    this._nBlue = 0;
  }

  /**
   * Place one car's pair of lamps. `offsets` are body-local positions.
   * The pattern is a double-blink alternating side to side.
   *
   * `basis` is the pose the car is being drawn in this frame, which is not
   * quite where the physics left it (see the interpolation in Game._render).
   * A light bar that ignores that sits a few centimetres off the roof it is
   * bolted to, and at speed it swims.
   */
  place(vehicle, offsets, phaseOffset = 0, basis = null) {
    if (this.count >= this.capacity) return;
    const t = (this.time * 3.4 + phaseOffset) % 1;
    const leftOn = t < 0.16 || (t > 0.24 && t < 0.40);
    const rightOn = (t > 0.50 && t < 0.66) || (t > 0.74 && t < 0.90);

    const i = this.count++;
    for (let k = 0; k < 2; k++) {
      const quat = basis ? basis.quaternion : vehicle.quaternion;
      _a.copy(offsets[k]).applyQuaternion(quat).add(basis ? basis.position : vehicle.position);
      _q.copy(quat);
      const on = k === 0 ? leftOn : rightOn;
      const mesh = k === 0 ? this.red : this.blue;
      _s.setScalar(on ? 1 : 0.0001);
      _m.compose(on ? _a : _zero, _q, _s);
      mesh.setMatrixAt(i, _m);
      if (on) {
        const pts = k === 0 ? this.glowRed : this.glowBlue;
        const n = k === 0 ? this._nRed++ : this._nBlue++;
        pts.geometry.attributes.position.setXYZ(n, _a.x, _a.y, _a.z);
      }
    }
  }

  end() {
    this.red.count = this.count;
    this.blue.count = this.count;
    this.red.instanceMatrix.needsUpdate = true;
    this.blue.instanceMatrix.needsUpdate = true;
    for (const [pts, n] of [[this.glowRed, this._nRed], [this.glowBlue, this._nBlue]]) {
      pts.geometry.setDrawRange(0, n);
      pts.geometry.attributes.position.needsUpdate = true;
    }
  }
}

/**
 * Hazard lights: four amber lamps at a car's corners, blinking together, for a
 * car that has pulled over and stopped (game/suspects.js `_pullOver`).
 *
 * Where the corners are is measured once per car from its drawn body, with
 * the body put back at the origin for the measurement -- generated and
 * imported bodies are all different shapes, and a lamp floating off the
 * bumper is worse than none.
 */
export class HazardLights {
  constructor(scene, capacity = 24) {
    this.capacity = capacity;
    this.time = 0;
    this.count = 0;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.2, 0.1, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xffa21a, toneMapped: false }),
      capacity * 4,
    );
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    scene.add(this.mesh);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3));
    geo.setDrawRange(0, 0);
    this.glow = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffa21a, map: haloTexture(), size: 1.6, sizeAttenuation: true, transparent: true,
      opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.glow.frustumCulled = false;
    scene.add(this.glow);
    this._box = new THREE.Box3();
  }

  begin(dt) {
    this.time += dt;
    this.count = 0;
  }

  /** The four corners of `v`'s body, body-local, cached on the car. */
  _corners(v) {
    if (v._hazardCorners) return v._hazardCorners;
    const view = v.view;
    const pos = view.position.clone(), quat = view.quaternion.clone();
    view.position.set(0, 0, 0);
    view.quaternion.identity();
    view.updateMatrixWorld(true);
    const b = this._box.setFromObject(view);
    view.position.copy(pos);
    view.quaternion.copy(quat);
    view.updateMatrixWorld(true);
    const y = b.min.y + (b.max.y - b.min.y) * 0.42;
    const x = b.max.x - 0.14, x0 = b.min.x + 0.14;
    v._hazardCorners = [
      new THREE.Vector3(x, y, b.max.z - 0.04), new THREE.Vector3(x0, y, b.max.z - 0.04),
      new THREE.Vector3(x, y, b.min.z + 0.04), new THREE.Vector3(x0, y, b.min.z + 0.04),
    ];
    return v._hazardCorners;
  }

  /** One car's hazards, at the pose it is drawn in this frame. */
  place(v, basis) {
    if (this.count >= this.capacity) return;
    // About 1.5 flashes a second, like the real thing; every car in step is
    // fine -- nobody counts them.
    if ((this.time * 1.5) % 1 > 0.5) return;
    const corners = this._corners(v);
    const pts = this.glow.geometry.attributes.position;
    for (let k = 0; k < 4; k++) {
      const n = this.count * 4 + k;
      _a.copy(corners[k]).applyQuaternion(basis.quaternion).add(basis.position);
      _m.compose(_a, basis.quaternion, _s.setScalar(1));
      this.mesh.setMatrixAt(n, _m);
      pts.setXYZ(n, _a.x, _a.y, _a.z);
    }
    this.count++;
  }

  end() {
    this.mesh.count = this.count * 4;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, this.count * 4);
    this.glow.geometry.attributes.position.needsUpdate = true;
  }
}

/** A round, soft-edged spot for the halo points. */
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
