// The sky.
//
// "Sky and lighting next." The sky was one flat colour, the same as the fog, so the world ended in a grey-blue
// wall. Now: a dome round the camera, deeper blue overhead fading to a pale haze at the horizon that is the
// fog's own colour (so the far distance melts into it instead of stopping); a layer of clouds drifting across
// it; a glow where the sun is. Rain is a low grey overcast, night a dark sky with stars. All of it is three
// meshes drawn with no lighting and no fog, behind everything: a few hundred triangles and one texture.
//
// The colours of the light come from here too (Sky.lighting), so the sun, the fill from the sky and the haze
// agree with what is drawn: a warmer sun, a bluer sky fill, a ground bounce of grass.
//
// `window.__flatSky = true` before load for the old flat colour.

import * as THREE from 'three';

const R = 1100;          // the dome's radius, m: inside the camera's far plane (1400)
const CLOUD_H = 0.16;    // how far up the dome the clouds' plane is, as a fraction: lower is flatter

/** Day, rain and night: overhead, horizon (and the fog), the light. */
const LOOKS = {
  day: { top: 0x3f74b8, mid: 0x7fa6d2, horizon: 0xb7c7d6, sun: 0xfff0d6, sunI: 1.9, sky: 0xc2daf2, ground: 0x56603f, hemiI: 1.15, clouds: 0.85, cover: 0.42 },
  rain: { top: 0x55606c, mid: 0x67717c, horizon: 0x76808a, sun: 0xe8eef4, sunI: 0.55, sky: 0x9aa6b2, ground: 0x3f463a, hemiI: 0.95, clouds: 0.95, cover: 0.85 },
  night: { top: 0x02040b, mid: 0x07101f, horizon: 0x0d1626, sun: 0x9fb6ff, sunI: 0.32, sky: 0x7d8fb8, ground: 0x1c2230, hemiI: 0.42, clouds: 0.25, cover: 0.35 },
  nightRain: { top: 0x020306, mid: 0x05080d, horizon: 0x070a10, sun: 0x9fb6ff, sunI: 0.32, sky: 0x7d8fb8, ground: 0x1c2230, hemiI: 0.42, clouds: 0.3, cover: 0.85 },
};

/** Clouds: soft white shapes on transparent, drawn once, tiling. `cover` 0..1: how much of the sky. */
function cloudTexture(cover) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  let seed = 77;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const puffs = Math.round(60 + cover * 220);
  for (let k = 0; k < puffs; k++) {
    // Clumped: a few centres, puffs round them, so it reads as clouds rather than noise.
    const cx = r() * S, cy = r() * S, n = 4 + Math.floor(r() * 8), spread = 20 + r() * 50;
    for (let j = 0; j < n; j++) {
      const px = cx + (r() - 0.5) * spread * 2, py = cy + (r() - 0.5) * spread, rad = 14 + r() * 34;
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          const g = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rad);
          g.addColorStop(0, `rgba(255,255,255,${0.16 + 0.1 * cover})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          x.fillStyle = g;
          x.fillRect(px + ox - rad, py + oy - rad, rad * 2, rad * 2);
        }
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round glow, for the sun. */
function glowTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,250,235,1)');
  g.addColorStop(0.06, 'rgba(255,246,220,0.95)');
  g.addColorStop(0.2, 'rgba(255,236,200,0.35)');
  g.addColorStop(1, 'rgba(255,230,190,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Sky {
  /** `sunDir`: the direction the sunlight comes from (towards the sun), any length. */
  constructor(scene, { night = false, rain = false } = {}, sunDir = new THREE.Vector3(110, 175, 80)) {
    this.scene = scene;
    this.look = LOOKS[night ? (rain ? 'nightRain' : 'night') : (rain ? 'rain' : 'day')];
    this.night = night;
    this.group = new THREE.Group();
    this.group.name = 'sky';
    if (window.__flatSky) return;
    this.sunDir = sunDir.clone().normalize();
    this._dome();
    this._clouds();
    if (!night && !rain) this._sun();
    if (night && !rain) this._stars();
    // Behind everything, and never in the way of anything.
    this.group.traverse((o) => { o.renderOrder = -10; o.frustumCulled = false; });
    scene.add(this.group);
  }

  /** The colours the lights and the fog should be, to match. */
  get lighting() {
    const l = this.look;
    return { fog: l.horizon, sun: l.sun, sunI: l.sunI, sky: l.sky, ground: l.ground, hemiI: l.hemiI };
  }

  _dome() {
    const l = this.look;
    const geo = new THREE.SphereGeometry(R, 32, 16);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const top = new THREE.Color(l.top), mid = new THREE.Color(l.mid), hor = new THREE.Color(l.horizon);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const e = Math.max(0, pos.getY(i) / R);       // 0 at the horizon, 1 overhead
      if (e < 0.22) c.copy(hor).lerp(mid, Math.pow(e / 0.22, 0.8));
      else c.copy(mid).lerp(top, Math.min(1, (e - 0.22) / 0.78));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    this.dome = new THREE.Mesh(geo, mat);
    this.group.add(this.dome);
  }

  /**
   * A flat layer of cloud seen in perspective: a big disc high up, textured by where each point is on it
   * (so the clouds shrink toward the horizon as real ones do), faded out toward its rim so it never shows an
   * edge, and drifting slowly downwind.
   */
  _clouds() {
    const l = this.look;
    const geo = new THREE.CircleGeometry(R * 0.98, 48, 0, Math.PI * 2);
    geo.rotateX(Math.PI / 2);   // facing down
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const col = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, pos.getX(i) / 380, pos.getZ(i) / 380);
      const d = Math.hypot(pos.getX(i), pos.getZ(i)) / R;
      const fade = Math.max(0, 1 - Math.pow(d, 2.2));
      col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
      col[i * 4 + 3] = fade;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const tint = new THREE.Color(l.clouds, l.clouds, l.clouds);
    if (this.night) tint.setRGB(0.16, 0.19, 0.26);
    const mat = new THREE.MeshBasicMaterial({
      map: cloudTexture(l.cover), color: tint, transparent: true, vertexColors: true, vertexAlphas: true,
      side: THREE.DoubleSide, fog: false, depthWrite: false,
    });
    this.cloudMat = mat;
    this.clouds = new THREE.Mesh(geo, mat);
    this.clouds.position.y = R * CLOUD_H;
    this.group.add(this.clouds);
  }

  _sun() {
    const m = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffffff, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    this.sunSprite = new THREE.Sprite(m);
    this.sunSprite.scale.setScalar(R * 0.34);
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(R * 0.9);
    this.group.add(this.sunSprite);
  }

  _stars() {
    const n = 900;
    const pos = new Float32Array(n * 3);
    let seed = 5;
    const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, e = Math.asin(0.08 + r() * 0.92);
      pos[i * 3] = Math.cos(a) * Math.cos(e) * R * 0.95;
      pos[i * 3 + 1] = Math.sin(e) * R * 0.95;
      pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * R * 0.95;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85, depthWrite: false }));
    this.group.add(stars);
  }

  /** Every frame: round the camera, and the clouds drift. */
  update(camera, dt) {
    if (!this.dome) return;
    this.group.position.copy(camera.position);
    if (this.cloudMat && this.cloudMat.map) {
      this.cloudMat.map.offset.x += dt * 0.0035;
      this.cloudMat.map.offset.y += dt * 0.0012;
    }
  }
}
