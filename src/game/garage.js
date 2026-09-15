// The garage: a petrol station with a repair bay, one on each map.
//
// Pull into the bay, stop, and after three seconds of sitting still the car
// starts to mend -- slowly, a few percent a second, until it is back to 100%
// or you drive off. It works mid-chase too; nothing stops the police pulling
// in behind you, and sitting still next to a patrol car is how arrests happen.
//
// The site is found rather than authored, so the same code serves both maps:
// a straight stretch of ordinary road, a few hundred metres from where you
// start, with a lot's worth of clear ground beside it -- no road, no building,
// no tree. The ground under the lot is repainted as footway, so it is flat and
// level with the pavement you cross to get in, and the street furniture that
// would have stood across its entrance is never put there.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { WORLD_HALF, CELL, GRID_N, KERB_H, SURF_PAVED } from '../world/common.js';
import { clamp01 } from '../util/math.js';

/** The lot, in metres: along the road, and back from it. */
const LOT_L = 34;
const LOT_D = 24;
/** Footway between the carriageway and the lot. */
const GAP = 3;

/** The bay, in the lot's own frame: u along the road, v away from it. */
const BAY = { u0: 7.7, u1: 12.3, v0: 1.0, v1: 10.0 };

/** Seconds of sitting still before the work starts. */
const HOLD = 3;
/** Damage mended per second: a written-off car takes about twenty seconds. */
const RATE = 0.05;
/** Slower than this counts as stopped, in m/s (about 2 km/h). */
const STILL = 0.6;

const FORECOURT = 0x676a70;
const LINE_WHITE = 0xd8dadd;
const LINE_YELLOW = 0xe0b43a;

export class Garage {
  constructor(game) {
    this.game = game;
    this.site = this._findSite();
    this.stillFor = 0;
    this.repairing = false;
    this.state = 'away';        // away | damaged-wait | repairing | done | clean
    this._doneFor = 0;
    if (this.site) this._build(this.site);
  }

  // ------------------------------------------------------------ the site

  /** World position of a point in the lot's frame. */
  toWorld(u, v) {
    const s = this.site;
    return { x: s.cx + s.ax * u + s.nx * v, z: s.cz + s.az * u + s.nz * v };
  }

  /** A world position in the lot's frame. */
  toLocal(x, z) {
    const s = this.site;
    const dx = x - s.cx, dz = z - s.cz;
    return { u: dx * s.ax + dz * s.az, v: dx * s.nx + dz * s.nz };
  }

  /**
   * Is this point on the lot or across its entrance? Street furniture asks, so
   * nothing is stood in the way in.
   */
  covers(x, z, margin = 0) {
    if (!this.site) return false;
    const { u, v } = this.toLocal(x, z);
    return Math.abs(u) <= LOT_L * 0.5 + margin
      && v >= -(LOT_D * 0.5 + GAP + 2) - margin && v <= LOT_D * 0.5 + margin;
  }

  _findSite() {
    const game = this.game;
    const g = game.graph;
    const start = game.startPlace ? game.startPlace.position : { x: 0, z: 0 };

    // Everything solid, as circles in a coarse grid. Circles round a building's
    // box are generous, which only ever rules out a spot that was fine.
    const CELLS = 40;
    const solids = new Map();
    game.world.forEachCollider((c) => {
      const member = c.collisionGroups() >>> 16;
      if (!(member & (GROUP.BUILDING | GROUP.PROP))) return;
      const t = c.translation();
      let r = 3;
      try {
        const he = c.halfExtents();
        if (he) r = Math.hypot(he.x, he.z);
      } catch (e) {
        try { r = c.radius(); } catch (e2) { /* keep the guess */ }
      }
      const key = `${Math.floor(t.x / CELLS)},${Math.floor(t.z / CELLS)}`;
      if (!solids.has(key)) solids.set(key, []);
      solids.get(key).push({ x: t.x, z: t.z, r });
    });

    const clear = (cx, cz, ax, az, nx, nz, own) => {
      if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) return false;
      const reach = Math.hypot(LOT_L, LOT_D) * 0.5 + GAP + 4;
      // Solids anywhere on the lot or its entrance.
      const kx = Math.floor(cx / CELLS), kz = Math.floor(cz / CELLS);
      for (let j = kz - 2; j <= kz + 2; j++) {
        for (let i = kx - 2; i <= kx + 2; i++) {
          for (const s of solids.get(`${i},${j}`) || []) {
            const dx = s.x - cx, dz = s.z - cz;
            if (Math.abs(dx) > reach + s.r || Math.abs(dz) > reach + s.r) continue;
            const u = dx * ax + dz * az, v = dx * nx + dz * nz;
            if (Math.abs(u) < LOT_L * 0.5 + s.r + 1
              && v > -(LOT_D * 0.5 + GAP) - s.r && v < LOT_D * 0.5 + s.r + 1) return false;
          }
        }
      }
      // Any other road, or a bend in this one, anywhere near it.
      for (const e of g.edgesNear(cx, cz, reach + 20)) {
        if (e.dead) continue;
        const pad = e.width * 0.5 + 2;
        for (const seg of e.segs) {
          const steps = Math.max(1, Math.ceil(seg.len / 3));
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const dx = seg.a.x + (seg.b.x - seg.a.x) * t - cx;
            const dz = seg.a.z + (seg.b.z - seg.a.z) * t - cz;
            const u = dx * ax + dz * az, v = dx * nx + dz * nz;
            if (Math.abs(u) < LOT_L * 0.5 + pad && Math.abs(v) < LOT_D * 0.5 + pad) {
              // Its own road runs past the front, GAP metres off the lot.
              if (e === own && v < -(LOT_D * 0.5)) continue;
              return false;
            }
          }
        }
      }
      return true;
    };

    const KINDS = new Set(['street', 'avenue', 'dual', 'country', 'lane']);
    let best = null;
    for (const e of g.edges) {
      if (e.dead || e.turningHead || !KINDS.has(e.kind)) continue;
      if (e.length < LOT_L + 40) continue;
      for (let s = 20 + LOT_L * 0.5; s <= e.length - 20 - LOT_L * 0.5; s += 8) {
        const p = g.pointAt(e, s);
        // Straight along the whole frontage, or the lot would overhang a bend.
        const p0 = g.pointAt(e, s - LOT_L * 0.5), p1 = g.pointAt(e, s + LOT_L * 0.5);
        if (p0.tx * p1.tx + p0.tz * p1.tz < 0.985) continue;
        for (const side of [1, -1]) {
          const ax = p.tx * side, az = p.tz * side;
          const nx = -az, nz = ax;
          const off = e.width * 0.5 + GAP + LOT_D * 0.5;
          const cx = p.x + nx * off, cz = p.z + nz * off;
          const d = Math.hypot(cx - start.x, cz - start.z);
          // Somewhere you can find, but not so close it is the first thing you
          // drive into.
          if (d < 110 || d > 700) continue;
          const score = Math.abs(d - 280) + (e.kind === 'lane' || e.kind === 'country' ? 60 : 0);
          if (best && score >= best.score) continue;
          if (!clear(cx, cz, ax, az, nx, nz, e)) continue;
          best = { score, cx, cz, ax, az, nx, nz, edge: e, roadName: e.name };
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------ building it

  _build(site) {
    const game = this.game;
    const y0 = KERB_H;
    site.heading = Math.atan2(-site.az, site.ax);

    // Level, paved ground: the lot and the footway in front of it.
    const surface = game.world.__map && game.world.__map.surface;
    if (surface) {
      const r = Math.hypot(LOT_L, LOT_D + GAP * 2) * 0.5 + 2;
      const i0 = Math.max(0, Math.floor((site.cx - r + WORLD_HALF) / CELL));
      const i1 = Math.min(GRID_N - 1, Math.ceil((site.cx + r + WORLD_HALF) / CELL));
      const j0 = Math.max(0, Math.floor((site.cz - r + WORLD_HALF) / CELL));
      const j1 = Math.min(GRID_N - 1, Math.ceil((site.cz + r + WORLD_HALF) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = i * CELL - WORLD_HALF + CELL * 0.5, z = j * CELL - WORLD_HALF + CELL * 0.5;
          const { u, v } = this.toLocal(x, z);
          if (Math.abs(u) <= LOT_L * 0.5 && v >= -(LOT_D * 0.5 + GAP) && v <= LOT_D * 0.5) {
            surface[j * GRID_N + i] = SURF_PAVED;
          }
        }
      }
    }

    const group = new THREE.Group();
    group.name = 'garage';
    group.position.set(site.cx, 0, site.cz);
    group.rotation.y = site.heading;

    const b = new MeshBuilder();
    const L2 = LOT_L * 0.5, D2 = LOT_D * 0.5;
    const flat = new MeshBuilder();
    // Forecourt, out to the kerb line.
    flat.addQuadY(-L2, -D2 - GAP + 0.3, L2, -D2 - GAP + 0.3, L2, D2, -L2, D2, y0 + 0.006, FORECOURT);

    // The edge of the slab, where it stands proud of grass.
    b.addWall([
      { x: -L2, z: -D2 - GAP + 0.3 }, { x: -L2, z: D2 }, { x: L2, z: D2 }, { x: L2, z: -D2 - GAP + 0.3 },
    ], 0, y0 + 0.006, 0x4a4d52);

    // Shop.
    b.addBox(12, 4.2, 6.5, -10, y0 + 2.1, 8.25, 0xd9d4c7);
    b.addBox(12.2, 0.5, 6.7, -10, y0 + 4.35, 8.25, 0x2f7d4c);            // green fascia
    b.addBox(9, 1.6, 0.08, -10, y0 + 1.7, 4.96, 0x9fc3d6);                // window
    b.addBox(1.4, 2.3, 0.1, -5.6, y0 + 1.15, 4.95, 0x39434d);             // door

    // Canopy over the pumps, on four posts.
    const CU = -8, CV = -4.5;
    b.addBox(19, 0.7, 10, CU, y0 + 5.35, CV, 0xeeeeea);
    b.addBox(19.1, 0.35, 10.1, CU, y0 + 4.95, CV, 0x2f7d4c);
    for (const du of [-7.5, 7.5]) {
      for (const dv of [-3, 3]) b.addBox(0.45, 5, 0.45, CU + du, y0 + 2.5, CV + dv, 0xb9bcc0);
    }
    // Pump islands.
    for (const du of [-4, 4]) {
      b.addBox(1.4, 0.25, 4.2, CU + du, y0 + 0.125, CV, 0xa6a9ad);
      b.addBox(0.8, 1.5, 1.0, CU + du, y0 + 1.0, CV - 1.0, 0xe7e7e2);
      b.addBox(0.82, 0.3, 1.02, CU + du, y0 + 1.6, CV - 1.0, 0x2f7d4c);
      b.addBox(0.8, 1.5, 1.0, CU + du, y0 + 1.0, CV + 1.0, 0xe7e7e2);
      b.addBox(0.82, 0.3, 1.02, CU + du, y0 + 1.6, CV + 1.0, 0x2f7d4c);
    }

    // The workshop over the bay: open to the forecourt.
    const WU = (BAY.u0 + BAY.u1) * 0.5;
    b.addBox(0.4, 5.6, 12, 4.2, y0 + 2.8, 5.5, 0xcfcac0);
    b.addBox(0.4, 5.6, 12, 15.8, y0 + 2.8, 5.5, 0xcfcac0);
    b.addBox(12, 5.6, 0.4, 10, y0 + 2.8, 11.3, 0xbfb9ae);
    b.addBox(12.4, 0.4, 12.4, 10, y0 + 5.8, 5.5, 0x5b6068);
    b.addBox(12.4, 0.7, 0.3, 10, y0 + 5.35, -0.55, 0x2f7d4c);             // fascia over the door

    // Parking lines along the front of the shop, a little life on the forecourt.
    for (let u = -15.5; u <= -4.5; u += 2.75) {
      flat.addQuadY(u - 0.06, 2.2, u + 0.06, 2.2, u + 0.06, 4.6, u - 0.06, 4.6, y0 + 0.012, LINE_WHITE);
    }
    // The bay outline, painted.
    const line = (u0, v0, u1, v1) => flat.addQuadY(u0, v0, u1, v0, u1, v1, u0, v1, y0 + 0.014, LINE_YELLOW);
    line(BAY.u0 - 0.15, BAY.v0 - 0.15, BAY.u1 + 0.15, BAY.v0 + 0.05);
    line(BAY.u0 - 0.15, BAY.v1 - 0.05, BAY.u1 + 0.15, BAY.v1 + 0.15);
    line(BAY.u0 - 0.15, BAY.v0, BAY.u0 + 0.05, BAY.v1);
    line(BAY.u1 - 0.05, BAY.v0, BAY.u1 + 0.15, BAY.v1);

    // Sign by the road.
    const SU = -L2 + 1.5, SV = -D2 - GAP + 1.2;
    b.addBox(0.35, 6, 0.35, SU, y0 + 3, SV, 0x6d7278);
    const solid = new THREE.Mesh(b.build(), vertexColorMaterial());
    solid.castShadow = true;
    solid.receiveShadow = true;
    group.add(solid);
    // The forecourt and its paint lie a few millimetres over the footway, so
    // they are pulled forward in depth rather than left to fight it.
    const ground = new THREE.Mesh(flat.build(), vertexColorMaterial({
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    ground.receiveShadow = true;
    group.add(ground);

    // The bay's own light: the thing that says "stop here", and changes as the
    // work goes on.
    const bayTex = new THREE.CanvasTexture(bayCanvas());
    bayTex.colorSpace = THREE.SRGBColorSpace;
    this.bayMat = new THREE.MeshBasicMaterial({
      map: bayTex, transparent: true, depthWrite: false, color: 0xffd35a,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });
    const bay = new THREE.Mesh(new THREE.PlaneGeometry(BAY.u1 - BAY.u0, BAY.v1 - BAY.v0), this.bayMat);
    bay.rotation.x = -Math.PI / 2;
    bay.position.set(WU, y0 + 0.02, (BAY.v0 + BAY.v1) * 0.5);
    group.add(bay);

    const signTex = new THREE.CanvasTexture(signCanvas(site.roadName));
    signTex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 0.3), [
      new THREE.MeshLambertMaterial({ color: 0x2f7d4c }),
      new THREE.MeshLambertMaterial({ color: 0x2f7d4c }),
      new THREE.MeshLambertMaterial({ color: 0x2f7d4c }),
      new THREE.MeshLambertMaterial({ color: 0x2f7d4c }),
      new THREE.MeshBasicMaterial({ map: signTex }),
      new THREE.MeshBasicMaterial({ map: signTex }),
    ]);
    board.position.set(SU, y0 + 5.2, SV);
    board.rotation.y = Math.PI * 0.5;
    board.castShadow = true;
    group.add(board);

    game.scene.add(group);
    this.group = group;

    // Solid where it looks solid.
    const box = (u, v, y, w, h, d, kind = GROUP.BUILDING) => {
      const p = this.toWorld(u, v);
      addStaticBox(game.world, p.x, y, p.z, w * 0.5, h * 0.5, d * 0.5, kind, site.heading);
    };
    box(-10, 8.25, y0 + 2.1, 12, 4.2, 6.5);
    box(4.2, 5.5, y0 + 2.8, 0.4, 5.6, 12);
    box(15.8, 5.5, y0 + 2.8, 0.4, 5.6, 12);
    box(10, 11.3, y0 + 2.8, 12, 5.6, 0.4);
    for (const du of [-7.5, 7.5]) for (const dv of [-3, 3]) box(CU + du, CV + dv, y0 + 2.5, 0.45, 5, 0.45, GROUP.PROP);
    for (const du of [-4, 4]) box(CU + du, CV, y0 + 0.9, 1.4, 1.8, 4.2, GROUP.PROP);
    box(SU, SV, y0 + 3, 0.35, 6, 0.35, GROUP.PROP);
  }

  // ------------------------------------------------------------ the repair

  /** Is the car sitting in the bay? */
  inBay(v) {
    if (!this.site) return false;
    const { u, v: w } = this.toLocal(v.position.x, v.position.z);
    return u > BAY.u0 - 0.3 && u < BAY.u1 + 0.3 && w > BAY.v0 + 0.8 && w < BAY.v1 - 0.8;
  }

  update(dt) {
    if (!this.site) return;
    const p = this.game.player;
    const there = this.inBay(p) && !this.game.outcome;
    const still = there && p.speed < STILL;
    const worn = p.damage > 0.001 || p.wheels.some((w) => w.condition < 0.999);

    if (!there) {
      this.stillFor = 0;
      this.repairing = false;
      this.state = 'away';
      this._doneFor = 0;
    } else if (!still) {
      this.stillFor = 0;
      this.repairing = false;
      this.state = worn ? 'damaged-wait' : 'clean';
    } else if (!worn) {
      this.repairing = false;
      this._doneFor += dt;
      this.state = this.stillFor > 0 ? 'done' : 'clean';
    } else {
      this.stillFor += dt;
      this.state = this.stillFor >= HOLD ? 'repairing' : 'damaged-wait';
      this.repairing = this.stillFor >= HOLD;
      if (this.repairing) {
        p.damage = Math.max(0, p.damage - RATE * dt);
        if (p.damage <= 0.001) p.damage = 0;
        // New tyres too: a punctured one is replaced, not pumped back up.
        for (const w of p.wheels) { w.punctured = false; w.condition = Math.min(1, w.condition + RATE * 2 * dt); }
        if (p.disabled && p.damage < 0.92) p.disabled = false;
      }
    }

    // The bay light: amber waiting, pulsing green while it works.
    if (this.bayMat) {
      const t = performance.now() / 1000;
      if (this.repairing) {
        this.bayMat.color.setRGB(0.35, 1, 0.55);
        this.bayMat.opacity = 0.75 + 0.25 * Math.sin(t * 6);
      } else if (there) {
        this.bayMat.color.setRGB(1, 0.78, 0.25);
        this.bayMat.opacity = 0.7 + 0.3 * Math.sin(t * 3);
      } else {
        this.bayMat.color.setRGB(1, 0.83, 0.35);
        this.bayMat.opacity = 0.85;
      }
    }
  }

  /** What the HUD should say, or null. */
  get readout() {
    if (!this.site) return null;
    const p = this.game.player;
    switch (this.state) {
      case 'damaged-wait':
        return p.speed < STILL
          ? { label: 'HOLD STILL', value: (HOLD - this.stillFor).toFixed(1), fill: clamp01(this.stillFor / HOLD), cls: 'wait' }
          : { label: 'STOP TO REPAIR', value: `${Math.round((1 - p.damage) * 100)}%`, fill: 1 - p.damage, cls: 'wait' };
      case 'repairing':
        return { label: 'REPAIRING', value: `${Math.round((1 - p.damage) * 100)}%`, fill: 1 - p.damage, cls: 'work' };
      case 'done':
        return { label: 'FULLY REPAIRED', value: '100%', fill: 1, cls: 'work' };
      case 'clean':
        return { label: 'NO DAMAGE', value: '100%', fill: 1, cls: 'work' };
      default:
        return null;
    }
  }

  /** Where it is, for the minimap. */
  get marker() {
    return this.site ? this.toWorld(0, 0) : null;
  }
}

// ---------------------------------------------------------------- textures

function bayCanvas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 512);
  // Hatched border, so the bay reads from a distance and from the air.
  g.fillStyle = 'rgba(255,255,255,0.20)';
  g.fillRect(0, 0, 256, 512);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  for (let y = -256; y < 512; y += 44) {
    g.save();
    g.beginPath();
    g.rect(0, 0, 256, 512);
    g.rect(24, 24, 208, 464);
    g.clip('evenodd');
    g.beginPath();
    g.moveTo(0, y); g.lineTo(256, y + 256); g.lineTo(256, y + 278); g.lineTo(0, y + 22);
    g.fill();
    g.restore();
  }
  // A spanner, and the word.
  g.save();
  g.translate(128, 210);
  g.rotate(-Math.PI / 4);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillRect(-14, -10, 28, 150);
  g.beginPath();
  g.arc(0, -40, 46, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.fillRect(-18, -100, 36, 62);
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.font = '700 52px ui-monospace, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  // Facing a car that has just driven in, which is looking away from the road.
  g.translate(128, 400);
  g.rotate(Math.PI);
  g.fillText('REPAIR', 0, 0);
  g.restore();
  return c;
}

function signCanvas(road) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  g.fillStyle = '#2f7d4c';
  g.fillRect(0, 0, 320, 240);
  g.fillStyle = '#f3f1e8';
  g.fillRect(12, 12, 296, 216);
  g.fillStyle = '#2f7d4c';
  g.font = '700 58px ui-monospace, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('FUEL', 160, 72);
  g.fillStyle = '#c0392b';
  g.font = '700 48px ui-monospace, Consolas, monospace';
  g.fillText('REPAIRS', 160, 138);
  g.fillStyle = '#39434d';
  g.font = '500 20px ui-monospace, Consolas, monospace';
  g.fillText(road ? String(road).slice(0, 22) : 'SERVICES', 160, 196);
  return c;
}
