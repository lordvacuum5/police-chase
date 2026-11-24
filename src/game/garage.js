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
import { groundDetail } from '../world/groundtex.js';
import { buildingDetail } from '../world/buildtex.js';
import { ENDURANCE as AIR_TANK } from './flyheli.js';

/** The lot, in metres: along the road, and back from it. */
const LOT_L = 34;
const LOT_D = 24;
/** Footway between the carriageway and the lot. */
const GAP = 3;

/** The bay, in the lot's own frame: u along the road, v away from it. */
const BAY = { u0: 7.7, u1: 12.3, v0: 1.0, v1: 10.0 };

/**
 * The helipad on the workshop roof. The roof slab is 12.4 square centred on
 * (10, 5.5) with its top at KERB_H + 6, so the pad sits in the middle of it
 * with a metre to spare all round.
 */
const PAD_U = 10;
const PAD_V = 5.5;
const PAD_R = 5.2;
const PAD_Y = KERB_H + 6.0;

/**
 * The respray colours, by index: 0 is the car's own. "Purple, red, green, blue, pink. You know, a bunch of
 * different colours." The index is what goes over the network (net/session.js, packCar).
 */
export const SPRAY_COLOURS = [
  { name: 'ORIGINAL', hex: null },
  { name: 'PURPLE', hex: 0x6a2bb8 },
  { name: 'RED', hex: 0xc4161c },
  { name: 'GREEN', hex: 0x1f8a3a },
  { name: 'BLUE', hex: 0x1d4fc4 },
  { name: 'PINK', hex: 0xe8569b },
  { name: 'YELLOW', hex: 0xe6c21a },
  { name: 'BLACK', hex: 0x15171a },
  { name: 'WHITE', hex: 0xeceeef },
];

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
  /**
   * `far`: a second garage's -- the first one's site, and this one goes as far from it as it can while still
   * in the built-up part of the map (Garages, below).
   */
  constructor(game, far = null) {
    this.game = game;
    this.far = far;
    // Within 700 m of the start if it can be, further if not: Ashfield City's start is downtown, with no lot's
    // worth of clear ground for 700 m round it, and the city had no garage at all -- "I can't see the repair
    // station".
    this.site = far ? this._findSite() : this._findSite(700) || this._findSite(1400) || this._findSite(Infinity);
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

  _findSite(maxD = 700) {
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

    const wet = game.world.__map && game.world.__map.clearAt;
    const clear = (cx, cz, ax, az, nx, nz, own) => {
      if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) return false;
      // Not in what the map keeps clear (Ashfield's river, Haldon's railway and quarry).
      if (wet) {
        for (const [u, v] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (wet(cx + ax * u * LOT_L * 0.5 + nx * v * LOT_D * 0.5, cz + az * u * LOT_L * 0.5 + nz * v * LOT_D * 0.5)) return false;
        }
      }
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
      if (e.dead || e.turningHead || e.elevated || !KINDS.has(e.kind)) continue;
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
          let score;
          if (this.far) {
            // The other end of the map from the first: as far from it as can be, but in the town, not out
            // past its edge (70% of the way out from the middle).
            const lim = WORLD_HALF * 0.7;
            if (Math.abs(cx) > lim || Math.abs(cz) > lim) continue;
            const df = Math.hypot(cx - this.far.cx, cz - this.far.cz);
            if (df < WORLD_HALF * 0.8) continue;
            score = -df + (e.kind === 'lane' || e.kind === 'country' ? 60 : 0);
          } else {
            if (d < 110 || d > maxD) continue;
            score = Math.abs(d - 280) + (e.kind === 'lane' || e.kind === 'country' ? 60 : 0);
          }
          // On the hills (Haldon Vale), level ground: the lot is one flat slab
          // and the ground under the first site it took varied by three
          // metres, so the forecourt was half buried and half in the air.
          if (game.sim.terrainAt) {
            let lo = Infinity, hi = -Infinity;
            for (const [u, v] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              const y = game.sim.terrainAt(cx + ax * u * LOT_L * 0.5 + nx * v * LOT_D * 0.5,
                cz + az * u * LOT_L * 0.5 + nz * v * LOT_D * 0.5);
              lo = Math.min(lo, y); hi = Math.max(hi, y);
            }
            score += (hi - lo) * 120;
          }
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
    // On the hills where there are hills (Game.groundAt).
    const gy = game.groundAt ? game.groundAt(site.cx, site.cz) : 0;
    group.position.set(site.cx, gy, site.cz);
    group.rotation.y = site.heading;

    const b = new MeshBuilder();
    const L2 = LOT_L * 0.5, D2 = LOT_D * 0.5;
    const flat = new MeshBuilder();
    // On the hills the lot is not level: "you can see the normal ground where the concrete repair bottom
    // should be". The ground at the front corner of Haldon's lot stood 0.58 m over the middle, and the slab,
    // flat at the middle's height, had grass through it. Now the slab follows the ground (conform, below),
    // in 2 m squares so it can; and what stands on it goes down SINK metres further, so nothing floats
    // where the ground falls away.
    const hills = !!game.sim.terrainAt;
    const SINK = hills ? 1.2 : 0;
    const F0 = -D2 - GAP + 0.3;
    for (let u = -L2; u < L2 - 1e-6; u += 2) {
      for (let v = F0; v < D2 - 1e-6; v += 2) {
        const u1 = Math.min(L2, u + 2), v1 = Math.min(D2, v + 2);
        flat.addQuadY(u, v, u1, v, u1, v1, u, v1, y0 + 0.006, FORECOURT);
      }
    }

    // The edge of the slab, where it stands proud of grass: down past the ground, in 2 m pieces.
    const edge = new MeshBuilder();
    const rim = [];
    const corners = [[-L2, F0], [-L2, D2], [L2, D2], [L2, F0]];
    for (let k = 0; k < 3; k++) {
      const [a0, b0] = corners[k], [a1, b1] = corners[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, b1 - b0) / 2));
      for (let i = 0; i < n; i++) rim.push({ x: a0 + (a1 - a0) * i / n, z: b0 + (b1 - b0) * i / n });
    }
    rim.push({ x: L2, z: F0 });
    edge.addWall(rim, -SINK - 0.3, y0 + 0.006, 0x4a4d52);

    // Shop.
    b.addBox(12, 4.2 + SINK, 6.5, -10, y0 + 2.1 - SINK * 0.5, 8.25, 0xd9d4c7);
    b.addBox(12.2, 0.5, 6.7, -10, y0 + 4.35, 8.25, 0x2f7d4c);            // green fascia
    b.addBox(9, 1.6, 0.08, -10, y0 + 1.7, 4.96, 0x9fc3d6);                // window
    b.addBox(1.4, 2.3, 0.1, -5.6, y0 + 1.15, 4.95, 0x39434d);             // door

    // Canopy over the pumps, on four posts.
    const CU = -8, CV = -4.5;
    b.addBox(19, 0.7, 10, CU, y0 + 5.35, CV, 0xeeeeea);
    b.addBox(19.1, 0.35, 10.1, CU, y0 + 4.95, CV, 0x2f7d4c);
    for (const du of [-7.5, 7.5]) {
      for (const dv of [-3, 3]) b.addBox(0.45, 5 + SINK, 0.45, CU + du, y0 + 2.5 - SINK * 0.5, CV + dv, 0xb9bcc0);
    }
    // Pump islands.
    for (const du of [-4, 4]) {
      b.addBox(1.4, 0.25 + SINK, 4.2, CU + du, y0 + 0.125 - SINK * 0.5, CV, 0xa6a9ad);
      b.addBox(0.8, 1.5, 1.0, CU + du, y0 + 1.0, CV - 1.0, 0xe7e7e2);
      b.addBox(0.82, 0.3, 1.02, CU + du, y0 + 1.6, CV - 1.0, 0x2f7d4c);
      b.addBox(0.8, 1.5, 1.0, CU + du, y0 + 1.0, CV + 1.0, 0xe7e7e2);
      b.addBox(0.82, 0.3, 1.02, CU + du, y0 + 1.6, CV + 1.0, 0x2f7d4c);
    }

    // The workshop over the bay: two walls and a roof, open at both ends.
    //
    // It had a back wall, which made the bay a dead end -- drive in to mend
    // the car and the only way out is a reverse, with whoever was chasing you
    // arriving at the one entrance. Open at the back it is a building you can
    // go through, which is worth something in a chase and costs nothing: the
    // sides and the roof still make it a workshop to look at, and the bay is
    // still the bay.
    const WU = (BAY.u0 + BAY.u1) * 0.5;
    b.addBox(0.4, 5.6 + SINK, 12, 4.2, y0 + 2.8 - SINK * 0.5, 5.5, 0xcfcac0);
    b.addBox(0.4, 5.6 + SINK, 12, 15.8, y0 + 2.8 - SINK * 0.5, 5.5, 0xcfcac0);
    b.addBox(12.4, 0.4, 12.4, 10, y0 + 5.8, 5.5, 0x5b6068);
    b.addBox(12.4, 0.7, 0.3, 10, y0 + 5.35, -0.55, 0x2f7d4c);             // fascia over the door

    // ---- the helipad, on the workshop roof ----
    //
    // Air support has to come down somewhere, and the one place on the map
    // that already means "stop here and be mended" is the right place for the
    // one that means "stop here and be fuelled". It also solves where to put
    // a helicopter at the start of a game: on a roof, clear of the traffic,
    // rather than on a street where it sits in somebody's way.
    //
    // No collider. The aircraft is not a rigid body and lands by asking how
    // high the ground is beneath it (FlyingHelicopter.groundY), so the pad is
    // a height and a radius, and a car cannot reach it anyway.
    const padTex = new THREE.CanvasTexture(helipadCanvas());
    padTex.colorSpace = THREE.SRGBColorSpace;
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(PAD_R, 40),
      new THREE.MeshBasicMaterial({ map: padTex, transparent: true, depthWrite: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    // The group is already in the lot's frame -- u across, v away -- and
    // carries the site's heading, so this is placed in u and v like the bay.
    pad.position.set(PAD_U, PAD_Y + 0.02, PAD_V);
    group.add(pad);

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
    b.addBox(0.35, 6 + SINK, 0.35, SU, y0 + 3 - SINK * 0.5, SV, 0x6d7278);
    const solid = new THREE.Mesh(b.build(), vertexColorMaterial());
    // "The repair station now looks kind of outdated ... give that nice textures": cladding panels on the
    // walls, as the city's buildings have (world/buildtex.js), over the colours it had.
    buildingDetail(solid, 'panel');
    solid.castShadow = true;
    solid.receiveShadow = true;
    group.add(solid);
    const rimMesh = new THREE.Mesh(edge.build(), vertexColorMaterial());
    rimMesh.receiveShadow = true;
    group.add(rimMesh);
    // The forecourt and its paint lie a few millimetres over the footway, so
    // they are pulled forward in depth rather than left to fight it.
    const ground = new THREE.Mesh(flat.build(), vertexColorMaterial({
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    ground.receiveShadow = true;
    // Concrete with a grain to it, not a flat grey sheet.
    groundDetail(ground, 'tarmac');
    group.add(ground);

    // The bay's own light: the thing that says "stop here", and changes as the
    // work goes on.
    const bayTex = new THREE.CanvasTexture(bayCanvas());
    bayTex.colorSpace = THREE.SRGBColorSpace;
    this.bayMat = new THREE.MeshBasicMaterial({
      map: bayTex, transparent: true, depthWrite: false, color: 0xffd35a,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });
    const bayGeo = new THREE.PlaneGeometry(BAY.u1 - BAY.u0, BAY.v1 - BAY.v0, 3, 6);
    bayGeo.rotateX(-Math.PI / 2);
    bayGeo.translate(WU, y0 + 0.02, (BAY.v0 + BAY.v1) * 0.5);
    const bay = new THREE.Mesh(bayGeo, this.bayMat);
    group.add(bay);
    // The slab, its edge, its paint and the bay onto the ground under each point of them (the group's
    // frame is the lot's: x along the road, z away from it, y up from the ground at its middle).
    if (hills) {
      for (const m of [ground, rimMesh, bay]) {
        const pa = m.geometry.attributes.position;
        for (let i = 0; i < pa.count; i++) {
          const w = this.toWorld(pa.getX(i), pa.getZ(i));
          pa.setY(i, pa.getY(i) + game.groundAt(w.x, w.z) - gy);
        }
        pa.needsUpdate = true;
        m.geometry.computeBoundingSphere();
      }
    }

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
      addStaticBox(game.world, p.x, y + gy, p.z, w * 0.5, h * 0.5, d * 0.5, kind, site.heading);
    };
    box(-10, 8.25, y0 + 2.1, 12, 4.2, 6.5);
    box(4.2, 5.5, y0 + 2.8, 0.4, 5.6, 12);
    box(15.8, 5.5, y0 + 2.8, 0.4, 5.6, 12);
    // No back wall: see above. The roof has none either -- it is held up by
    // the two sides, and a collider on it would be a ceiling to drive into.
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

  /**
   * What the HUD should say, or null.
   *
   * An aircraft gets a different panel, because the one below is about
   * bodywork and an aircraft has none worth talking about: "when you go to
   * refuel it shouldn't say repairing -- the helicopter doesn't really have
   * health, you either get hit and it goes down or it doesn't. It should just
   * say refuelling and show a bar refuelling." The pad is on the workshop
   * roof, so without this the panel reported the state of a car that was not
   * there -- REPAIRING, or NO DAMAGE, over a helicopter filling its tanks.
   */
  get readout() {
    if (!this.site) return null;
    const p = this.game.player;
    if (p && p.isAircraft) {
      if (!p.onPad || !p.onPad()) return null;
      const frac = clamp01(p.fuel / AIR_TANK);
      const pct = `${Math.round(frac * 100)}%`;
      // Full first: the refuel clock keeps running once the tank is brimmed,
      // so asking about it first left the panel saying REFUELLING for as long
      // as the aircraft sat there.
      if (frac > 0.995) return { label: 'TANKS FULL', value: '100%', fill: 1, cls: 'work' };
      if (p.refuelling > 0) {
        return { label: 'REFUELLING', value: pct, fill: frac, cls: 'work' };
      }
      // On the pad but still moving: the refuel wants it settled, the same way
      // the bay wants a car stopped.
      return { label: 'SETTLE TO REFUEL', value: pct, fill: frac, cls: 'wait' };
    }
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

  /**
   * Can you respray here, now? In the bay, stopped, in a car of your own (not a police car, not the
   * helicopter), with nobody after you, outside the daily challenge (whose car is the day's).
   */
  get canSpray() {
    const g = this.game, p = g.player;
    if (!this.site || !p || p.isPolice || p.isAircraft || g.daily || g.outcome) return false;
    return this.inBay(p) && p.speed < STILL && g.heat.value <= 0;
  }

  /** Where it is, for the minimap. */
  get marker() {
    return this.site ? this.toWorld(0, 0) : null;
  }

  /**
   * The landing pad on the workshop roof: where a helicopter starts, and the
   * one place it can refuel. A height and a radius rather than a collider --
   * see the note where it is built.
   */
  get helipad() {
    if (!this.site) return null;
    const at = this.toWorld(PAD_U, PAD_V);
    return { x: at.x, z: at.z, y: PAD_Y + (this.game && this.game.groundAt ? this.game.groundAt(this.site.cx, this.site.cz) : 0), r: PAD_R };
  }
}

/**
 * The map's garages: one, or on a big map two at opposite ends. "I can't see the repair station. Can you make
 * it so there's maybe like 2 repair stations, kind of at opposite ends of the map ... otherwise it's pretty
 * hard to repair such a big map." Everything that asked the garage asks this instead, and gets the answer for
 * whichever one it is about: the bay you are in, the pad you are over, any forecourt.
 */
export class Garages {
  constructor(game, count = 1) {
    this.game = game;
    this.list = [new Garage(game)];
    if (count > 1 && this.list[0].site) {
      const second = new Garage(game, this.list[0].site);
      if (second.site) this.list.push(second);
    }
    this.site = this.list[0].site;
  }

  covers(x, z, margin = 0) { return this.list.some((g) => g.covers(x, z, margin)); }

  update(dt) { for (const g of this.list) g.update(dt); }

  /** The one you are in, if you are in one. */
  get readout() {
    for (const g of this.list) { const r = g.readout; if (r) return r; }
    return null;
  }

  get canSpray() { return this.list.some((g) => g.canSpray); }

  /** Each, for the minimap. */
  get markers() { return this.list.map((g) => g.marker).filter(Boolean); }

  get marker() { return this.list[0].marker; }

  /** Where a helicopter starts: the first's pad. */
  get helipad() { return this.list[0].helipad; }

  /** The pad over (x, z), if there is one. */
  padAt(x, z) {
    for (const g of this.list) {
      const p = g.helipad;
      if (p && (x - p.x) ** 2 + (z - p.z) ** 2 <= p.r * p.r) return p;
    }
    return null;
  }
}

// ---------------------------------------------------------------- textures

/** A landing pad: a ring, an H, and a touch of wear. */
function helipadCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  // The deck itself, darker than the roof so the circle reads from above.
  g.fillStyle = 'rgba(28,32,38,0.92)';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  // The ring.
  g.strokeStyle = 'rgba(248,250,252,0.92)';
  g.lineWidth = 11;
  g.beginPath();
  g.arc(128, 128, 101, 0, Math.PI * 2);
  g.stroke();
  // The H.
  g.fillStyle = 'rgba(248,250,252,0.95)';
  g.fillRect(74, 62, 20, 132);
  g.fillRect(162, 62, 20, 132);
  g.fillRect(74, 117, 108, 22);
  return c;
}

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
