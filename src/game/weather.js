// Time of day and weather: night, and rain.
//
// Chosen on the menu and fixed for the drive. Neither is decoration only.
//
//   night   dark sky and short fog; moonlight instead of sun; a real headlight
//           beam from your car, and every car's lamps and every street lamp
//           glowing; the police lights much brighter, and so much easier to
//           see coming -- as they are for real
//   rain    falling rain round the camera, a grey sky and closer fog, darker
//           wet roads, the sound of it, and 20% less grip for every car on
//           every surface, which the police drivers plan for as well
//
// Everything that glows is additive points or instanced quads: one draw per
// kind of light however many there are, because a real light per street lamp
// would be hundreds of lights and no phone would draw it.

import * as THREE from 'three';

const KEY = 'pc.conditions';

export function chosenConditions() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { night: !!c.night, rain: !!c.rain };
  } catch (e) {
    return { night: false, rain: false };
  }
}

export function setConditions(c) {
  try { localStorage.setItem(KEY, JSON.stringify({ night: !!c.night, rain: !!c.rain })); } catch (e) { /* blocked */ }
}

/** Grip in the wet, as a fraction of dry. */
const WET_GRIP = 0.8;

const RAIN_DROPS = 2600;
const RAIN_BOX = { x: 70, y: 36, z: 70 };

export class Weather {
  constructor(game, conditions = chosenConditions()) {
    this.game = game;
    this.night = conditions.night;
    this.rain = conditions.rain;
    this.lampGlows = null;
    this.carGlows = null;
    this.rainMesh = null;
    this.headlight = null;
    this._apply();
  }

  _apply() {
    const g = this.game;
    const { scene } = g;
    const hemi = scene.children.find((o) => o.isHemisphereLight);

    let sky = 0x8ea6bf, near = 200, far = 880, hemiI = 1.25, sunI = 1.75, sunCol = 0xfff4e2;
    if (this.rain) { sky = 0x6d7782; near = 70; far = 520; hemiI = 0.95; sunI = 0.55; }
    if (this.night) {
      sky = this.rain ? 0x070a10 : 0x0a1222;
      near = this.rain ? 30 : 60; far = this.rain ? 360 : 520;
      hemiI = 0.42; sunI = 0.32; sunCol = 0x9fb6ff;
    }
    scene.background = new THREE.Color(sky);
    scene.fog.color.setHex(sky);
    scene.fog.near = near;
    scene.fog.far = far;
    if (hemi) {
      hemi.intensity = hemiI;
      if (this.night) { hemi.color.setHex(0x7d8fb8); hemi.groundColor.setHex(0x1c2230); }
    }
    g.sun.intensity = sunI;
    g.sun.color.setHex(sunCol);

    // Wet: less grip for everyone, and darker, glossier-looking roads.
    g.sim.wetGrip = this.rain ? WET_GRIP : 1;
    if (this.rain) {
      const roads = scene.getObjectByName('roads');
      if (roads && roads.material && roads.material.color) roads.material.color.setScalar(0.72);
      const kerbs = scene.getObjectByName('pavements');
      if (kerbs && kerbs.material && kerbs.material.color) kerbs.material.color.setScalar(0.82);
      this._buildRain();
    }

    if (this.night) {
      g.lights.setGlow(1.0, 5.5);
      this._buildHeadlight();
      this._buildCarGlows();
    } else {
      g.lights.setGlow(this.rain ? 0.85 : 0.6, this.rain ? 3.2 : 2.4);
    }
  }

  /** Street lamps come on. Called once the props exist. */
  lightStreets(props) {
    if (!this.night || !props) return;
    const entry = props.byKind.get('lamp');
    if (!entry) return;
    const lamps = entry.list;
    this._lamps = lamps;
    const n = lamps.length;

    // A halo at each lantern...
    const pos = new Float32Array(n * 3);
    lamps.forEach((p, i) => this._lanternOf(p, pos, i));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const glow = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffd59a, map: softSpot(), size: 3.4, sizeAttenuation: true, transparent: true,
      opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    glow.frustumCulled = false;
    this.game.scene.add(glow);

    // ...and a pool of light on the ground under it.
    const pool = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xffc98a, map: softSpot(), transparent: true, opacity: 0.32,
        depthWrite: false, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      }),
      n,
    );
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(14, 1, 14);
    const v = new THREE.Vector3();
    lamps.forEach((p, i) => {
      v.set(pos[i * 3], (p.base || 0) + 0.05, pos[i * 3 + 2]);
      m.compose(v, q, s);
      pool.setMatrixAt(i, m);
    });
    pool.frustumCulled = false;
    this.game.scene.add(pool);
    this.lampGlows = { glow, pool, pos, down: new Uint8Array(n) };
  }

  _lanternOf(p, out, i) {
    const h = p.def.height;
    out[i * 3] = p.x + Math.sin(p.rot) * 0.86;
    out[i * 3 + 1] = (p.base || 0) + h - 0.34;
    out[i * 3 + 2] = p.z + Math.cos(p.rot) * 0.86;
  }

  _buildHeadlight() {
    const g = this.game;
    const spot = new THREE.SpotLight(0xfff2d8, 70, 120, 0.5, 0.55, 1);
    spot.castShadow = false;
    const target = new THREE.Object3D();
    g.scene.add(spot);
    g.scene.add(target);
    spot.target = target;
    this.headlight = { spot, target };
  }

  /** Head and tail lamp halos for every car on the road. */
  _buildCarGlows() {
    const mk = (colour, size, cap) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
      geo.setDrawRange(0, 0);
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        color: colour, map: softSpot(), size, sizeAttenuation: true, transparent: true,
        opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      pts.frustumCulled = false;
      this.game.scene.add(pts);
      return pts;
    };
    this.carGlows = { head: mk(0xfff0cf, 1.6, 64), tail: mk(0xff2a1a, 0.9, 64) };
  }

  _buildRain() {
    const pos = new Float32Array(RAIN_DROPS * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: this.night ? 0x7c8aa0 : 0xc4ced8, transparent: true, opacity: this.night ? 0.35 : 0.42,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    this.game.scene.add(lines);
    this.drops = new Float32Array(RAIN_DROPS * 3);
    for (let i = 0; i < RAIN_DROPS; i++) {
      this.drops[i * 3] = (Math.random() - 0.5) * RAIN_BOX.x;
      this.drops[i * 3 + 1] = Math.random() * RAIN_BOX.y;
      this.drops[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX.z;
    }
    this.rainMesh = lines;
  }

  update(dt) {
    const g = this.game;
    const cam = g.camera;

    if (this.rainMesh) {
      // Drops live in a box that travels with the camera, wrapped at its
      // edges, so there is always rain in shot however fast you drive.
      const d = this.drops;
      const pos = this.rainMesh.geometry.attributes.position.array;
      const fall = 19 * dt, driftX = 2.5 * dt;
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      const hx = RAIN_BOX.x * 0.5, hz = RAIN_BOX.z * 0.5;
      for (let i = 0; i < RAIN_DROPS; i++) {
        let x = d[i * 3] + driftX, y = d[i * 3 + 1] - fall, z = d[i * 3 + 2];
        if (y < 0) y += RAIN_BOX.y;
        // World-fixed drops, wrapped into a box round the camera: they fall
        // straight down past you rather than travelling with the car.
        x = cx - hx + ((((x - (cx - hx)) % RAIN_BOX.x) + RAIN_BOX.x) % RAIN_BOX.x);
        z = cz - hz + ((((z - (cz - hz)) % RAIN_BOX.z) + RAIN_BOX.z) % RAIN_BOX.z);
        d[i * 3] = x; d[i * 3 + 1] = y; d[i * 3 + 2] = z;
        const wy = cy - RAIN_BOX.y * 0.5 + y;
        const o = i * 6;
        pos[o] = x; pos[o + 1] = wy; pos[o + 2] = z;
        pos[o + 3] = x - 0.07; pos[o + 4] = wy + 0.75; pos[o + 5] = z;
      }
      this.rainMesh.geometry.attributes.position.needsUpdate = true;
    }

    if (this.headlight) {
      const p = g.player;
      const f = p.forward;
      const { spot, target } = this.headlight;
      spot.position.set(p.position.x + f.x * 2.0, p.position.y + 0.35, p.position.z + f.z * 2.0);
      target.position.set(p.position.x + f.x * 30, p.position.y - 1.2, p.position.z + f.z * 30);
      target.updateMatrixWorld();
    }

    if (this.carGlows) {
      const head = this.carGlows.head.geometry.attributes.position;
      const tail = this.carGlows.tail.geometry.attributes.position;
      let nh = 0, nt = 0;
      const v = new THREE.Vector3();
      for (const car of g.vehicles) {
        if (car.disabled || nh >= 62) continue;
        const lamps = lampsOf(car);
        for (const [x, y, z, rear] of lamps) {
          v.set(x, y, z).applyQuaternion(car.quaternion).add(car.position);
          if (rear) tail.setXYZ(nt++, v.x, v.y, v.z);
          else head.setXYZ(nh++, v.x, v.y, v.z);
        }
      }
      this.carGlows.head.geometry.setDrawRange(0, nh);
      this.carGlows.tail.geometry.setDrawRange(0, nt);
      head.needsUpdate = true;
      tail.needsUpdate = true;
    }

    // A lamp post that has been knocked over goes out.
    if (this.lampGlows && this._lamps) {
      const L = this.lampGlows;
      let changed = false;
      const m = new THREE.Matrix4();
      for (let i = 0; i < this._lamps.length; i++) {
        const down = this._lamps[i].down ? 1 : 0;
        if (down === L.down[i]) continue;
        L.down[i] = down;
        changed = true;
        L.pos[i * 3 + 1] = down ? -1000 : (this._lamps[i].base || 0) + this._lamps[i].def.height - 0.34;
        m.makeScale(down ? 0 : 14, 1, down ? 0 : 14);
        m.setPosition(L.pos[i * 3], (this._lamps[i].base || 0) + 0.05, L.pos[i * 3 + 2]);
        L.pool.setMatrixAt(i, m);
      }
      if (changed) {
        L.glow.geometry.attributes.position.needsUpdate = true;
        L.pool.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** How much brighter a light should be drawn, for things that draw their own. */
  get lightBoost() { return this.night ? 2.2 : this.rain ? 1.3 : 1; }
}

/**
 * Where a car's lamps are, in body space: two head, two tail. Worked out once
 * per body from its geometry's bounds -- the bodies are all different shapes
 * and none of them record where they put their lamps.
 */
function lampsOf(car) {
  const geo = car.view && car.view.geometry;
  if (!geo) return [];
  if (geo.userData.lampGlow) return geo.userData.lampGlow;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  const h = b.max.y - b.min.y;
  const yHead = b.min.y + h * (car.spec.body === 'van' || car.spec.body === 'suv' || car.spec.body === 'offroad' ? 0.30 : 0.32);
  const xs = (b.max.x - b.min.x) * 0.5 * 0.66;
  const zf = b.max.z - 0.02, zr = b.min.z + 0.02;
  const list = [
    [xs, yHead, zf, false], [-xs, yHead, zf, false],
    [xs * 1.1, yHead + h * 0.06, zr, true], [-xs * 1.1, yHead + h * 0.06, zr, true],
  ];
  geo.userData.lampGlow = list;
  return list;
}

let spotTex = null;
function softSpot() {
  if (spotTex) return spotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  spotTex = new THREE.CanvasTexture(c);
  return spotTex;
}
