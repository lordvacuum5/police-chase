// Cars far off -- the traffic's and the parked -- in fewer triangles, and the shadows of every car near.
//
// "It's very obvious to the human eye that it's suddenly becoming really detailed. The good thing about the lights was ... it
// faded so well." From FADE0 to FADE1 the car's own model in cells of a few centimetres (game/carlod.js) comes up over the
// real one a pixel at a time, and past FADE1 it is all there is; coarser again further off, always a cell to a pixel or so.
// Past GROW_FROM it is drawn a little larger and lighter the further off, from nothing at GROW_FROM: a few pixels of a dark
// car on dark tarmac could not be seen ("it's hard to see the civilian cars until the last moment").
//
// Shadows: every car near the player cast one from its whole model, 48,000 triangles for the Runner's. Cast from the same
// model in coarser cells instead, one draw a kind, and drawn for nothing but the shadow map.
import * as THREE from 'three';
import { simplifyCar, carLodMaterial } from './carlod.js';

/** The real car alone nearer than the first, m; its stand-in alone past the second. */
export const FADE0 = 60, FADE1 = 84;
/** Each stand-in's cells, m, and how far off it is used to. */
const LEVELS = [[0.11, 125], [0.19, 230], [0.34, Infinity]];
const GROW_FROM = 150, GROWN = 600, GROW = 0.35, LIFT = 0.3;
/** Cells of what a car's shadow is cast from, m: a traffic model's, and the others'. */
const CAST = 0.2, CAST_FINE = 0.14;
const CAST_WITHIN = 150;

const _s = new THREE.Vector3(), _c = new THREE.Color(), _white = new THREE.Color(0xdfe6ee), _m = new THREE.Matrix4(), _p = new THREE.Vector3();

class Batch {
  constructor(scene, geo, mat, name, shadow) {
    this.scene = scene; this.geo = geo; this.mat = mat; this.name = name; this.shadow = shadow;
    this.n = 0;
    this._make(32);
  }

  _make(cap) {
    const old = this.mesh;
    const g = this.geo.clone();
    this.cap = cap;
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    if (!this.shadow) g.setAttribute('lodFade', this.fade);
    const m = this.mesh = new THREE.InstancedMesh(g, this.mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (!this.shadow) { m.setColorAt(0, _c.set(0xffffff)); m.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    m.name = this.name;
    m.frustumCulled = false;
    m.castShadow = !!this.shadow;
    m.count = 0;
    // For the shadow map only: nothing of it in the picture.
    if (this.shadow) { m.onBeforeShadow = () => { m.count = this.n; }; m.onBeforeRender = () => { m.count = 0; }; m.onAfterShadow = () => {}; }
    if (old) {
      m.instanceMatrix.array.set(old.instanceMatrix.array);
      if (!this.shadow) m.instanceColor.array.set(old.instanceColor.array);
      this.scene.remove(old);
      old.geometry.dispose();
      old.dispose();
    }
    this.scene.add(m);
  }

  add(matrix, colour, fade) {
    if (this.n >= this.cap) {
      const was = this.fade.array;
      this._make(this.cap * 2);
      this.fade.array.set(was);
    }
    this.mesh.setMatrixAt(this.n, matrix);
    if (!this.shadow) { this.mesh.setColorAt(this.n, colour); this.fade.array[this.n] = fade; }
    this.n++;
  }

  /** What has been added since `begin` is what is drawn. */
  end() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (!this.n) return;
    // Only as much of the buffers as is used.
    const send = (a, size) => { a.clearUpdateRanges(); a.addUpdateRange(0, this.n * size); a.needsUpdate = true; };
    send(m.instanceMatrix, 16);
    if (!this.shadow) { send(m.instanceColor, 3); send(this.fade, 1); }
  }
}

export class FarCars {
  /** Stand-ins for `models` (Game.carModels) of `kinds`, and shadow casters for all of them; `specs` theirs, `wheels` the wheel's geometry. */
  constructor(scene, models, specs, wheels, kinds) {
    this.scene = scene;
    this.kinds = {};
    this.casters = {};
    const mat = carLodMaterial(), dark = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    for (const k of Object.keys(models || {})) {
      if (!models[k] || !specs[k]) continue;
      const light = kinds.includes(k);
      if (light) {
        const root = models[k].scene;
        this.kinds[k] = LEVELS.map(([cell], i) => new Batch(scene, simplifyCar(root, specs[k], wheels, cell), mat, 'far-cars', false, i));
      }
      const cast = simplifyCar(models[k].scene, specs[k], null, light ? CAST : CAST_FINE);
      for (const a of ['color', 'surf']) cast.deleteAttribute(a);
      this.casters[k] = new Batch(scene, cast, dark, 'car-shadows', true);
    }
    this.night = false;
  }

  /** Whether a car of this kind has a stand-in, and whether its shadow is cast here. */
  has(kind) { return !!this.kinds[kind]; }
  casts(kind) { return !!this.casters[kind]; }

  /** Start of a frame's drawing: `camera`'s view, `night`, and whether there are shadows, round `sun` (the player). */
  begin(camera, night, sun) {
    this.camera = camera;
    this.night = night;
    this.sun = sun;
    for (const l of Object.values(this.kinds)) for (const b of l) b.n = 0;
    for (const b of Object.values(this.casters)) b.n = 0;
  }

  /** A car of `kind` at `pos`, `quat`, its paint `hex`, `d` metres from the camera, `share` of it; nothing nearer than FADE0. */
  add(kind, pos, quat, hex, d, share = 1) {
    const levels = this.kinds[kind];
    if (!levels || d <= FADE0) return;
    const u = Math.min(1, Math.max(0, (d - GROW_FROM) / (GROWN - GROW_FROM))), k = 1 + GROW * u;
    // Larger about the road under it, not its middle, which would sink it.
    _p.copy(pos);
    if (u) _p.y += GROW * u * 0.55;
    _m.compose(_p, quat, _s.set(k, k, k));
    _c.setHex(hex === undefined ? 0x8d939a : hex);
    if (u && !this.night) _c.lerp(_white, LIFT * u);
    let i = 0;
    while (d > LEVELS[i][1]) i++;
    levels[i].add(_m, _c, Math.min(1, (d - FADE0) / (FADE1 - FADE0)) * share);
  }

  /** A car's shadow, if it is near enough the player to be in the map. */
  cast(kind, pos, quat) {
    const b = this.casters[kind];
    if (!b || !this.sun || Math.abs(pos.x - this.sun.x) > CAST_WITHIN || Math.abs(pos.z - this.sun.z) > CAST_WITHIN) return;
    b.add(_m.compose(pos, quat, _s.set(1, 1, 1)));
  }

  end() {
    for (const l of Object.values(this.kinds)) for (const b of l) b.end();
    for (const b of Object.values(this.casters)) b.end();
  }
}
