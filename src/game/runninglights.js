// Traffic's running lights, far off: white to the front, red to the rear, a few pixels each whatever the distance.
//
// "When driving fast it's hard to see the civilian cars until the last moment." A dark car on dark tarmac 300 m off is six
// pixels of nearly the same colour, and at 240 km/h that is four seconds away. Near, the car is plain enough without.
import * as THREE from 'three';

/** Not nearer than this, m, full by the second; gone by the third from the fourth, where the haze has the car. */
const NEAR = 60, NEAR_FULL = 110, FAR = 900, FAR_FULL = 620;
const MAX = 160;

export class RunningLights {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 4);
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 32, 32);
    this.mesh = new THREE.Points(g, new THREE.PointsMaterial({
      size: 8, sizeAttenuation: false, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, depthWrite: false, fog: false,
    }));
    this.mesh.name = 'running-lights';
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Every frame: the cars (`{ v }`) as drawn, from `camera`. */
  update(cars, camera) {
    let n = 0;
    const p = this.pos, col = this.col, cp = camera.position;
    for (const { v } of cars) {
      if (n >= MAX - 2) break;
      if (!v.view || !v.view.visible || v.disabled) continue;
      const q = v.view.position, dx = cp.x - q.x, dy = cp.y - q.y, dz = cp.z - q.z, d = Math.hypot(dx, dy, dz);
      if (d < NEAR || d > FAR) continue;
      const f = v.forward, l = v.left, toward = f.x * dx + f.z * dz > 0 ? 1 : -1;
      const a = Math.min((d - NEAR) / (NEAR_FULL - NEAR), (FAR - d) / (FAR - FAR_FULL), 1) * (toward > 0 ? 0.95 : 0.9);
      // Clear of the bodywork, or it hides them.
      const s = v.spec.dims, end = (s.l * 0.5 + 0.35) * toward, side = s.w * 0.34;
      for (const k of [-1, 1]) {
        p[n * 3] = q.x + f.x * end + l.x * side * k;
        p[n * 3 + 1] = q.y + f.y * end + 0.12;
        p[n * 3 + 2] = q.z + f.z * end + l.z * side * k;
        col[n * 4] = 1;
        col[n * 4 + 1] = toward > 0 ? 0.97 : 0.12;
        col[n * 4 + 2] = toward > 0 ? 0.88 : 0.08;
        col[n * 4 + 3] = a;
        n++;
      }
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
