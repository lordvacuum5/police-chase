// Wexbury Parkway: the town's railway station.
//
// "The UK map ... it's a nice map, but it doesn't really have anything special ... Maybe add a station in ... relatively near
// the edge of the map, where there's obviously along the train track, but where there's basically nothing else. Try and choose
// the spot where ... it's furthest away from, and basically make a road there, make a car park with cars in it, and yeah, make
// it a fully proper working station. As good as the repair station looks, with some steps up, and make it look really realistic
// ... all the surrounding areas really well textured."
//
// Where: the straightest stretch of the line out towards the edge of the map, as far from every road as there is, on flat ground,
// clear of the river and the lake. What: two platforms the length of the train, a booking hall in brick with a slate roof, a
// canopy over the down platform, a waiting shelter on the up, a covered footbridge with steps down to both, lamps, benches,
// running-in boards, a palisade fence, and a car park of four rows of bays, half of them taken. Station Road out to the nearest
// road. And the trains stop at it (countryextras.js Railway, `stops`).
//
// Laid out in the station's own frame: u along the track, v across it, from the track's middle (0) out to the car park (+).

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial, WORLD_HALF, CELL, GRID_N, SURF_PAVED } from './common.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { buildingDetail } from './buildtex.js';
import { groundDetail } from './groundtex.js';
import { addWindows, litWindows } from './windows.js';
import { PARK_HY } from './drives.js';
import { lerp, clamp } from '../util/math.js';

/** Platforms: length (a five-car train is 120 m), width, top over the rail bed, edge from the track's middle; m. */
const PLAT_L = 134, PLAT_W = 4.4, PLAT_H = 0.95, EDGE = 1.75;
/** The booking hall, across the track from v0 to v1, along it from -BLD_U to BLD_U. */
const BLD_V0 = 8.5, BLD_V1 = 18.5, BLD_U = 13;
/** The car park: across from PARK_V0 to PARK_V1, along -PARK_U to PARK_U. */
const PARK_V0 = 24, PARK_V1 = 62, PARK_U = 44;
/** The footbridge: where it crosses, along the track; its deck over the platforms. */
const FB_U = 40, FB_UP = 6.3, FB_W = 2.6;
/** How long a train stands at the platform, s. */
export const STATION_DWELL = 25;

const STONE = 0xc9c2b0, TARMAC = 0x4d4e50, PLATFORM = 0x6f6c67, YELLOW = 0xe1bf18, BRICK = 0x8f4f3c, SLATE = 0x3a3e44;
const CREAM = 0xe6dcc0, GREEN = 0x2f5743, GLASS = 0x7f97a3, DARK = 0x262a2e, WHITE = 0xe8e8e4;

/**
 * Choose the site and lay Station Road to it, before the roads are finished (buildWexbury). `base` the ground before anything
 * claims it. Returns the station's frame and the rail distance of its middle, or null if nowhere will do.
 */
export function planStation(ctx, base) {
  const { graph } = ctx, L = ctx.rail;
  if (!L) return null;
  const H = WORLD_HALF;
  // Every road as points 8 m apart in 50 m buckets: how far from (x, z) the nearest is, up to 200 m.
  const B = 50, buckets = new Map();
  for (const e of graph.edges) {
    if (e.dead || e.cut) continue;
    const pts = e.points;
    for (let k = 0; k < pts.length - 1; k++) {
      const n = Math.max(1, Math.ceil(Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z) / 8));
      for (let m = 0; m <= n; m++) {
        const x = lerp(pts[k].x, pts[k + 1].x, m / n), z = lerp(pts[k].z, pts[k + 1].z, m / n);
        const key = Math.floor(x / B) * 4096 + Math.floor(z / B);
        let l = buckets.get(key);
        if (!l) buckets.set(key, (l = []));
        l.push(x, z, e.width * 0.5);
      }
    }
  }
  const roadGap = (x, z) => {
    let best = 200;
    const i0 = Math.floor(x / B), j0 = Math.floor(z / B);
    for (let i = i0 - 4; i <= i0 + 4; i++) for (let j = j0 - 4; j <= j0 + 4; j++) {
      const l = buckets.get(i * 4096 + j);
      if (!l) continue;
      for (let k = 0; k < l.length; k += 3) best = Math.min(best, Math.hypot(l[k] - x, l[k + 1] - z) - l[k + 2]);
    }
    return best;
  };
  const wet = (x, z) => (ctx.canal && ctx.canal.near(x, z, 80).d < 60) || (ctx.lake && Math.hypot(x - ctx.lake.x, z - ctx.lake.z) < ctx.lake.R + 50);
  let best = null;
  for (let s = 160; s < L.length - 160; s += 8) {
    const c = L.at(s), a = L.at(s - PLAT_L * 0.5 - 10), b = L.at(s + PLAT_L * 0.5 + 10);
    if (Math.abs(c.x) > H - 170 || Math.abs(c.z) > H - 170) continue;
    // Straight the length of the platforms, or they would stand off a curve.
    if (a.dx * b.dx + a.dz * b.dz < 0.998 || a.dx * c.dx + a.dz * c.dz < 0.999) continue;
    const ends = [a, b].map((q) => ({ x: q.x, z: q.z }));
    if (Math.hypot(ends[0].x - c.x, ends[0].z - c.z) < PLAT_L * 0.45) continue;
    for (const side of [1, -1]) {
      const nx = -c.dz * side, nz = c.dx * side;
      let gap = Infinity, lo = Infinity, hi = -Infinity, ok = true;
      for (let u = -PARK_U - 30; u <= PARK_U + 30; u += 22) {
        for (let v = -12; v <= PARK_V1 + 10; v += 12) {
          const x = c.x + c.dx * u + nx * v, z = c.z + c.dz * u + nz * v;
          if (Math.abs(x) > H - 60 || Math.abs(z) > H - 60 || wet(x, z)) { ok = false; break; }
          gap = Math.min(gap, roadGap(x, z));
          if (v >= 0) { const y = base(x, z); lo = Math.min(lo, y); hi = Math.max(hi, y); }
        }
        if (!ok) break;
      }
      if (!ok || gap < 25) continue;
      // Far from everything, out towards the edge, on the level.
      const score = Math.min(gap, 160) * 2 + Math.hypot(c.x, c.z) * 0.2 - (hi - lo) * 12;
      if (!best || score > best.score) best = { score, s, x: c.x, z: c.z, nx, nz, side, gap };
    }
  }
  if (!best) return null;
  // The frame: v out across the track to the car park (n), u along it.
  const st = { s: best.s, cx: best.x, cz: best.z, nx: best.nx, nz: best.nz, tx: best.nz, tz: -best.nx };
  st.rot = Math.atan2(st.nx, st.nz);
  st.W = (u, v) => ({ x: st.cx + st.tx * u + st.nx * v, z: st.cz + st.tz * u + st.nz * v });
  st.local = (x, z) => { const dx = x - st.cx, dz = z - st.cz; return { u: dx * st.tx + dz * st.tz, v: dx * st.nx + dz * st.nz }; };
  st.level = base(st.W(0, (PARK_V0 + PARK_V1) * 0.5).x, st.W(0, (PARK_V0 + PARK_V1) * 0.5).z);

  // Station Road: from the car park's mouth to the nearest point of a road it can reach without crossing the line or the river,
  // joined there as a new junction.
  const mouth = st.W(0, PARK_V1 - 1);
  const cands = [];
  for (const e of graph.edges) {
    if (e.dead || e.cut || e.hill || e.width === 11 || e.kind === 'dual' || e.kind === 'alley') continue;
    const pts = e.points;
    let along = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k], q = pts[k + 1], sl = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const t = clamp(((mouth.x - p.x) * (q.x - p.x) + (mouth.z - p.z) * (q.z - p.z)) / (sl * sl), 0, 1);
      const x = lerp(p.x, q.x, t), z = lerp(p.z, q.z, t), d = Math.hypot(x - mouth.x, z - mouth.z);
      const at = along + t * sl;
      if (at > 25 && at < e.length - 25) cands.push({ e, k, t, x, z, d });
      along += sl;
    }
  }
  cands.sort((p, q) => p.d - q.d);
  for (const c of cands.slice(0, 60)) {
    if (c.d > 900) break;
    const path = [mouth, { x: c.x, z: c.z }];
    if (ctx.rail.crossings(path).length || (ctx.canal && ctx.canal.crossings(path).length)) continue;
    // Not back across the station.
    const lc = st.local(c.x, c.z);
    if (lc.v < PARK_V1) continue;
    // Split the road there.
    const e = c.e, pts = e.points;
    const j = graph.addNode(c.x, c.z, 'cross');
    const before = pts.slice(1, c.k + 1), after = pts.slice(c.k + 1, pts.length - 1);
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    e.dead = true;
    graph.reindexEdges();
    const e1 = graph.addEdge(a, j, e.kind, before.length ? before : null);
    const e2 = graph.addEdge(j, b, e.kind, after.length ? after : null);
    for (const k of ['pave', 'country', 'bypass', 'estate']) if (e[k] !== undefined) { e1[k] = e[k]; e2[k] = e[k]; }
    const m = graph.addNode(mouth.x, mouth.z, 'cross');
    const mid = [];
    const n = Math.max(1, Math.round(c.d / 40));
    for (let i = 1; i < n; i++) mid.push({ x: lerp(mouth.x, c.x, i / n), z: lerp(mouth.z, c.z, i / n) });
    st.road = graph.addEdge(m, j, 'lane', mid.length ? mid : null);
    st.mouth = m;
    st.road.station = true;
    break;
  }
  return st;
}

/** The ground flat under the building and the car park, at its own level (buildHeightGrid's places). */
export function stationFlatten(st) {
  const out = [];
  for (const u of [-PARK_U * 0.5, PARK_U * 0.5]) {
    const p = st.W(u, (PARK_V0 + PARK_V1) * 0.5);
    out.push({ x: p.x, z: p.z, r: 38, fade: 30, h: st.level });
  }
  const b = st.W(0, (BLD_V0 + BLD_V1) * 0.5);
  out.push({ x: b.x, z: b.z, r: 18, fade: 12, h: st.level });
  return out;
}

/** Kept clear of trees and grass (`markLine`, `bit`), and the car park and forecourt paved in the grip grid. */
export function stationSurfaces(ctx, st, markLine, bit) {
  markLine(ctx, [st.W(-PLAT_L * 0.5 - 6, PARK_V1 * 0.45), st.W(PLAT_L * 0.5 + 6, PARK_V1 * 0.45)], PARK_V1 * 0.6 + 8, bit);
  markLine(ctx, [st.W(-PLAT_L * 0.5 - 6, -6), st.W(PLAT_L * 0.5 + 6, -6)], 9, bit);
  const surf = ctx.surface;
  const r = Math.hypot(PARK_U + 4, PARK_V1) + 4;
  const i0 = Math.max(0, Math.floor((st.cx - r + WORLD_HALF) / CELL)), i1 = Math.min(GRID_N - 1, Math.ceil((st.cx + r + WORLD_HALF) / CELL));
  const j0 = Math.max(0, Math.floor((st.cz - r + WORLD_HALF) / CELL)), j1 = Math.min(GRID_N - 1, Math.ceil((st.cz + r + WORLD_HALF) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const { u, v } = st.local(i * CELL - WORLD_HALF + CELL * 0.5, j * CELL - WORLD_HALF + CELL * 0.5);
    const park = Math.abs(u) <= PARK_U + 1 && v >= PARK_V0 - 1 && v <= PARK_V1 + 1;
    const fore = Math.abs(u) <= BLD_U + 8 && v >= BLD_V0 - 1 && v <= PARK_V0;
    if (park || fore) surf[j * GRID_N + i] = SURF_PAVED;
  }
}

/** A sign's face: white letters on the railway's blue, or the car park's P. */
function signTexture(text, bg = '#16407a', fg = '#ffffff', w = 512, h = 96) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.fillStyle = fg; x.fillRect(6, 6, w - 12, 3); x.fillRect(6, h - 9, w - 12, 3);
  x.font = `600 ${Math.round(h * 0.52)}px Arial, Helvetica, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Everything drawn and solid: returns the meshes. Built after the houses (so `ctx.parked` is there to add the car park's cars
 * to). `at(x, z)` the ground; the platforms stand on the rail bed's level under them.
 */
export function buildStation(ctx, st) {
  const W = ctx.sim.world, at = ctx.at, rot = st.rot;
  const b = new MeshBuilder(), brick = new MeshBuilder(), lit = new MeshBuilder(), flat = new MeshBuilder();
  const P = (u, v) => st.W(u, v);
  const box = (m, w, h, d, u, v, y, col) => { const p = P(u, v); m.addBox(w, h, d, p.x, y, p.z, col, rot); };
  const solid = (w, h, d, u, v, y, group = GROUP.BUILDING) => { const p = P(u, v); addStaticBox(W, p.x, y, p.z, w * 0.5, h * 0.5, d * 0.5, group, rot); };
  const ground = (u, v) => { const p = P(u, v); return at(p.x, p.z); };
  // The rail bed's level along the track: the platforms' tops follow it.
  const bed = (u) => ground(u, 0);

  // ---- platforms: the down (car park side, +v) and the up (-v)
  for (const sg of [1, -1]) {
    const vIn = sg * EDGE, vOut = sg * (EDGE + PLAT_W), vMid = (vIn + vOut) * 0.5;
    const STEP = 6;
    for (let u = -PLAT_L * 0.5; u < PLAT_L * 0.5 - 1e-6; u += STEP) {
      const um = u + STEP * 0.5, top = bed(um) + PLAT_H, lowG = Math.min(bed(um), ground(um, vOut));
      const h = top - lowG + 0.6;
      // The body, in stone, and the coping along the edge over the track.
      box(b, STEP, h, PLAT_W, um, vMid, top - h * 0.5 - 0.06, 0x8d877a);
      box(flat, STEP, 0.05, PLAT_W - 0.9, um, vMid + sg * 0.45, top, PLATFORM);
      box(flat, STEP, 0.07, 0.62, um, vIn + sg * 0.31, top + 0.01, STONE);
      // The yellow line, and the studded paving behind it.
      box(flat, STEP, 0.075, 0.1, um, vIn + sg * 0.78, top + 0.012, YELLOW);
      box(flat, STEP, 0.07, 0.42, um, vIn + sg * 1.05, top + 0.008, 0xb6ae95);
      solid(STEP, h, PLAT_W, um, vMid, top - h * 0.5);
      // Lamps every other piece; benches between.
      const k = Math.round((u + PLAT_L * 0.5) / STEP);
      if (k % 3 === 1) {
        box(b, 0.14, 4.2, 0.14, um, vOut - sg * 0.5, top + 2.1, DARK);
        box(b, 0.9, 0.12, 0.24, um, vOut - sg * 0.5, top + 4.2, DARK);
        box(lit, 0.7, 0.1, 0.18, um, vOut - sg * 0.5, top + 4.12, 0xfff1c8);
      } else if (k % 3 === 2 && Math.abs(um - FB_U) > 12) {
        box(b, 1.8, 0.08, 0.45, um, vOut - sg * 0.9, top + 0.48, 0x6b4a2e);
        box(b, 1.8, 0.45, 0.07, um, vOut - sg * 0.68, top + 0.75, 0x6b4a2e);
        for (const e of [-0.75, 0.75]) box(b, 0.08, 0.48, 0.4, um + e, vOut - sg * 0.9, top + 0.24, DARK);
      }
    }
    // The ramps down at each end, for the barrows (and anyone's car that tries).
    for (const end of [-1, 1]) {
      const u0 = end * PLAT_L * 0.5, top = bed(u0) + PLAT_H, len = 9;
      const y1 = ground(u0 + end * len, vMid);
      const n = 6;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, uu = u0 + end * len * t, yy = lerp(top, y1, t);
        box(b, len / n + 0.05, 0.4, PLAT_W, uu, vMid, yy - 0.2, PLATFORM);
      }
    }
    // A palisade fence along the back of the up platform; the down platform's back is the building and the forecourt.
    if (sg < 0) {
      for (let u = -PLAT_L * 0.5; u <= PLAT_L * 0.5; u += 2) {
        const top = bed(u) + PLAT_H;
        box(b, 0.08, 1.9, 0.08, u, vOut + 0.1, top + 0.95, GREEN);
      }
      for (const yy of [0.35, 1.6]) {
        for (let u = -PLAT_L * 0.5; u < PLAT_L * 0.5; u += 6) box(b, 6, 0.07, 0.05, u + 3, vOut + 0.1, bed(u + 3) + PLAT_H + yy, GREEN);
      }
      solid(PLAT_L, 2, 0.2, 0, vOut + 0.1, bed(0) + PLAT_H + 1);
    }
  }

  // ---- the down platform's canopy: cream columns, a green valance, a slate roof sloping back
  const topAt = (u) => bed(u) + PLAT_H;
  const CAN_U = 34;
  for (let u = -CAN_U; u <= CAN_U; u += 8.5) {
    box(b, 0.22, 3.4, 0.22, u, EDGE + PLAT_W - 1.2, topAt(u) + 1.7, CREAM);
    box(b, 0.34, 0.3, 0.34, u, EDGE + PLAT_W - 1.2, topAt(u) + 3.35, CREAM);
  }
  for (let u = -CAN_U - 2; u < CAN_U + 2; u += 4) {
    const y = topAt(u + 2) + 3.55;
    box(b, 4, 0.16, PLAT_W + 0.6, u + 2, EDGE + PLAT_W * 0.5 + 0.2, y, SLATE);
    box(b, 4, 0.55, 0.06, u + 2, EDGE - 0.08, y - 0.25, GREEN);
    box(lit, 1.1, 0.06, 0.16, u + 2, EDGE + 1.1, y - 0.12, 0xfff3d6);
  }
  // ---- the up platform's waiting shelter: glass on a dark frame
  {
    const v = -(EDGE + PLAT_W - 1.3), y = topAt(-18);
    for (const e of [-3, 3]) box(b, 0.12, 2.5, 1.6, -18 + e, v, y + 1.25, DARK);
    box(b, 6, 2.2, 0.05, -18, v - 0.78, y + 1.25, GLASS);
    box(b, 6.4, 0.12, 1.9, -18, v, y + 2.55, DARK);
    box(b, 5, 0.08, 0.4, -18, v - 0.45, y + 0.48, 0x6b4a2e);
  }

  // ---- running-in boards and the booking hall's name
  const signMat = (t) => new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide });
  const nameTex = signTexture('Wexbury Parkway');
  const signs = new THREE.Group();
  signs.name = 'station-signs';
  const sign = (tex, w, h, u, v, y, face = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), signMat(tex));
    const p = P(u, v);
    m.position.set(p.x, y, p.z);
    m.rotation.y = rot + face;
    signs.add(m);
  };
  for (const sg of [1, -1]) {
    for (const u of [-52, 52]) {
      const v = sg * (EDGE + PLAT_W - 0.7), y = topAt(u);
      for (const e of [-1.6, 1.6]) box(b, 0.1, 2.4, 0.1, u + e, v, y + 1.2, DARK);
      sign(nameTex, 3.8, 0.72, u, v, y + 2.2, sg > 0 ? Math.PI : 0);
    }
  }

  // ---- the booking hall: brick, a slate roof, chimneys, a canopy over the door to the forecourt
  {
    const bu = BLD_U * 2, bd = BLD_V1 - BLD_V0, vm = (BLD_V0 + BLD_V1) * 0.5, g0 = Math.min(ground(-BLD_U, vm), ground(BLD_U, vm), ground(0, BLD_V0), ground(0, BLD_V1));
    const h = 5.8, y0 = g0 - 0.8;
    const p = P(0, vm);
    brick.addBox(bu, h + 0.8, bd, p.x, y0 + (h + 0.8) * 0.5, p.z, BRICK, rot);
    brick.addTaperedBox(bu + 0.8, 2.6, bd + 0.9, p.x, y0 + 0.8 + h + 1.3, p.z, SLATE, 0.96, 0.15, rot);
    for (const e of [-0.32, 0.32]) box(brick, 0.9, 2.2, 0.9, bu * e, vm, y0 + 0.8 + h + 2.4, 0x7a3f2e);
    // Stone quoins and a string course.
    box(b, bu + 0.06, 0.25, bd + 0.06, 0, vm, y0 + 0.8 + 3.1, STONE);
    box(b, bu + 0.1, 0.35, bd + 0.1, 0, vm, y0 + 0.95, 0x6c675e);
    addWindows(brick, lit, p.x, p.z, bu, h, bd, rot, st.nx, st.nz, 'house');
    // Doors: to the forecourt and to the platform.
    for (const [v, f] of [[BLD_V1 + 0.04, 1], [BLD_V0 - 0.04, -1]]) {
      box(b, 2.4, 2.7, 0.12, 0, v, y0 + 0.8 + 1.35, 0x2d3f35);
      box(b, 2.9, 0.35, 0.16, 0, v + f * 0.02, y0 + 0.8 + 2.85, STONE);
    }
    // The forecourt canopy over the way in, on two columns.
    for (const e of [-3.4, 3.4]) box(b, 0.24, 3.4, 0.24, e, BLD_V1 + 3.4, y0 + 0.8 + 1.7, CREAM);
    box(b, 8, 0.22, 4.2, 0, BLD_V1 + 1.9, y0 + 0.8 + 3.5, SLATE);
    box(b, 8, 0.5, 0.06, 0, BLD_V1 + 4.0, y0 + 0.8 + 3.25, GREEN);
    sign(nameTex, 5.6, 1.05, 0, BLD_V1 + 0.09, y0 + 0.8 + 4.2, 0);
    solid(bu, h + 3, bd, 0, vm, y0 + (h + 3) * 0.5);
    // Its platform side meets the down platform: paving across the gap.
    for (let u = -BLD_U; u < BLD_U; u += 4) box(flat, 4, 0.06, BLD_V0 - (EDGE + PLAT_W) + 0.3, u + 2, (EDGE + PLAT_W + BLD_V0) * 0.5, topAt(u + 2), PLATFORM);
    // A clock on the platform side.
    box(b, 0.9, 0.9, 0.12, 0, BLD_V0 - 0.1, y0 + 0.8 + 4.6, WHITE);
  }

  // ---- the footbridge: steps up from each platform, a covered span over the line
  {
    const yTop = Math.max(topAt(FB_U), topAt(FB_U - 12)) + FB_UP;
    const RISE = 0.18, RUN = 0.29;
    for (const sg of [1, -1]) {
      const v = sg * (EDGE + PLAT_W - FB_W * 0.5 - 0.15), base0 = topAt(FB_U - 10);
      const n = Math.ceil((yTop - base0) / RISE);
      for (let i = 0; i < n; i++) {
        const y = base0 + (i + 1) * (yTop - base0) / n, u = FB_U - n * RUN + i * RUN + RUN * 0.5;
        box(b, RUN + 0.02, 0.16, FB_W, u, v, y - 0.08, i % 2 ? 0x7d7a74 : 0x87847d);
        solid(RUN, 0.16, FB_W, u, v, y - 0.08);
      }
      // The stringers and handrails up each side.
      const u0 = FB_U - n * RUN, mid = (u0 + FB_U) * 0.5, len = Math.hypot(n * RUN, yTop - base0);
      for (const e of [-1, 1]) {
        const pp = P(mid, v + e * (FB_W * 0.5 + 0.05));
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, len), new THREE.MeshLambertMaterial({ color: GREEN }));
        m.position.set(pp.x, (base0 + yTop) * 0.5 + 1.0, pp.z);
        m.rotation.set(0, rot + Math.PI / 2, 0, 'YXZ');
        m.rotateX(-Math.atan2(yTop - base0, n * RUN));
        signs.add(m);
        box(b, n * RUN, 0.35, 0.12, mid, v + e * (FB_W * 0.5 + 0.06), (base0 + yTop) * 0.5 - 0.2, 0x5e5b55);
      }
      // The landing at the top.
      box(b, FB_W + 0.4, 0.3, FB_W, FB_U + FB_W * 0.5, v, yTop - 0.15, 0x5e5b55);
      // Columns under it.
      for (const e of [-1, 1]) box(b, 0.3, yTop - topAt(FB_U), 0.3, FB_U + FB_W * 0.5 + e * 1.2, v, (yTop + topAt(FB_U)) * 0.5, GREEN);
    }
    // The span: a deck, lattice sides, a curved roof (in three pieces).
    const span = (EDGE + PLAT_W) * 2;
    box(b, FB_W, 0.35, span, FB_U + FB_W * 0.5, 0, yTop - 0.17, 0x5e5b55);
    solid(FB_W, 0.35, span, FB_U + FB_W * 0.5, 0, yTop - 0.17);
    for (const e of [-1, 1]) {
      box(b, 0.12, 1.2, span, FB_U + FB_W * 0.5 + e * (FB_W * 0.5), 0, yTop + 0.6, GREEN);
      box(b, 0.05, 1.0, span, FB_U + FB_W * 0.5 + e * (FB_W * 0.5 + 0.02), 0, yTop + 1.75, GLASS);
    }
    box(b, FB_W + 0.5, 0.12, span + 0.4, FB_U + FB_W * 0.5, 0, yTop + 2.45, SLATE);
    box(b, FB_W - 0.4, 0.1, span + 0.4, FB_U + FB_W * 0.5, 0, yTop + 2.6, SLATE);
  }

  // ---- the car park: tarmac in 4 m squares that follow the ground, white bays, a kerb round it, lamps
  const parked = ctx.parked || (ctx.parked = []);
  {
    for (let u = -PARK_U; u < PARK_U - 1e-6; u += 4) {
      for (let v = PARK_V0; v < PARK_V1 - 1e-6; v += 4) {
        const c = [[u, v], [u + 4, v], [u + 4, v + 4], [u, v + 4]].map(([uu, vv]) => ({ ...P(uu, vv), y: ground(uu, vv) + 0.05 }));
        flat.addQuadY(c[0].x, c[0].z, c[1].x, c[1].z, c[2].x, c[2].z, c[3].x, c[3].z, 0, TARMAC);
        // addQuadY lays it flat at one height: lift each corner to its own (below).
        const n = flat.pos.length;
        for (let k = n - 18; k < n; k += 3) {
          const x = flat.pos[k], z = flat.pos[k + 2];
          flat.pos[k + 1] = at(x, z) + 0.05;
        }
      }
    }
    // The forecourt between the hall and the car park, and the way through to the platform past the hall.
    for (let u = -BLD_U - 8; u < BLD_U + 8; u += 4) {
      for (let v = BLD_V1; v < PARK_V0; v += 3) {
        const c = [[u, v], [u + 4, v], [u + 4, v + 3], [u, v + 3]].map(([uu, vv]) => P(uu, vv));
        flat.addQuadY(c[0].x, c[0].z, c[1].x, c[1].z, c[2].x, c[2].z, c[3].x, c[3].z, 0, 0x8a857b);
        const n = flat.pos.length;
        for (let k = n - 18; k < n; k += 3) flat.pos[k + 1] = at(flat.pos[k], flat.pos[k + 2]) + 0.06;
      }
    }
    // Rows of bays: two along the front and back, two back to back in the middle.
    const rows = [[PARK_V0 + 0.5, 1], [PARK_V0 + 15.5, -1], [PARK_V0 + 20.5, 1], [PARK_V1 - 5.5, -1]];
    const BAY = 2.6, DEPTH = 5;
    let i = 0;
    for (const [v0, dir] of rows) {
      for (let u = -PARK_U + 3; u + BAY <= PARK_U - 3; u += BAY) {
        // The white lines between bays.
        box(flat, 0.1, 0.02, DEPTH, u, v0 + DEPTH * 0.5, ground(u, v0 + DEPTH * 0.5) + 0.08, WHITE);
        // Half the bays taken, which ones by a hash of the bay.
        const h = Math.abs(Math.sin(u * 12.9898 + v0 * 78.233) * 43758.5453) % 1;
        if (h < 0.5) {
          const p = P(u + BAY * 0.5, v0 + DEPTH * 0.5), y = at(p.x, p.z);
          // Nose in: facing the way the bay opens (dir) the other way round.
          const fx = st.nx * dir, fz = st.nz * dir;
          const body = addStaticBox(W, p.x, y + PARK_HY, p.z, 0.95, PARK_HY, 2.3, GROUP.BUILDING, Math.atan2(fx, fz));
          parked.push({ x: p.x, z: p.z, y, heading: Math.atan2(fx, fz), i: 1000 + i++, body });
        }
      }
      box(flat, (PARK_U - 3) * 2, 0.02, 0.1, 0, v0 + (dir > 0 ? 0 : DEPTH), ground(0, v0) + 0.08, WHITE);
    }
    // Kerbs round it, but the mouth to Station Road.
    for (let u = -PARK_U; u < PARK_U; u += 4) {
      for (const v of [PARK_V0, PARK_V1]) {
        if (v === PARK_V1 && Math.abs(u + 2) < 6) continue;
        box(b, 4, 0.16, 0.25, u + 2, v, ground(u + 2, v) + 0.08, 0xa8a59d);
      }
    }
    for (const su of [-PARK_U, PARK_U]) for (let v = PARK_V0; v < PARK_V1; v += 4) box(b, 0.25, 0.16, 4, su, v + 2, ground(su, v + 2) + 0.08, 0xa8a59d);
    // Lamps down the middle aisle and the far one.
    for (const v of [PARK_V0 + 10.5, PARK_V1 - 10]) {
      for (let u = -PARK_U + 8; u <= PARK_U - 8; u += 16) {
        const y = ground(u, v);
        box(b, 0.16, 7, 0.16, u, v, y + 3.5, 0x8c8f93);
        box(b, 1.4, 0.14, 0.3, u, v, y + 7, 0x8c8f93);
        box(lit, 1.0, 0.08, 0.22, u, v, y + 6.92, 0xfff1c8);
        solid(0.3, 7, 0.3, u, v, y + 3.5, GROUP.PROP);
      }
    }
    // The car park's sign by its mouth, and a pay machine.
    const pTex = signTexture('P  Station car park', '#1a4e9a', '#ffffff', 512, 96);
    const sp = P(8, PARK_V1 + 1.5), sy = at(sp.x, sp.z);
    for (const e of [-1.2, 1.2]) box(b, 0.1, 2.6, 0.1, 8 + e, PARK_V1 + 1.5, sy + 1.3, DARK);
    sign(pTex, 2.8, 0.55, 8, PARK_V1 + 1.5, sy + 2.3, Math.PI);
    box(b, 0.7, 1.6, 0.5, -BLD_U - 4, PARK_V0 - 1.2, ground(-BLD_U - 4, PARK_V0 - 1.2) + 0.8, 0x2a4f8f);
  }

  // ---- out
  const out = [signs];
  const mk = (builder, style, name) => {
    if (!builder.vertexCount) return null;
    const mesh = new THREE.Mesh(builder.build(), vertexColorMaterial());
    mesh.name = name;
    if (style) buildingDetail(mesh, style);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const flatMesh = new THREE.Mesh(flat.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  flatMesh.name = 'station-ground';
  flatMesh.receiveShadow = true;
  groundDetail(flatMesh, 'tarmac');
  out.push(flatMesh, mk(b, 'panel', 'station'), mk(brick, 'brick', 'station-hall'));
  const litMesh = litWindows(lit);
  if (litMesh) out.push(litMesh);
  return out.filter(Boolean);
}

/** Trees round the car park, but its mouth: its two ends and its back, every 9 m or so (Wexbury's buildTrees plants them). */
export function stationTrees(st) {
  const out = [];
  for (let v = PARK_V0 + 3; v <= PARK_V1 + 3; v += 9) for (const su of [-1, 1]) out.push(st.W(su * (PARK_U + 5), v));
  for (let u = -PARK_U; u <= PARK_U; u += 9) if (Math.abs(u) > 12) out.push(st.W(u, PARK_V1 + 6));
  for (const u of [-BLD_U - 9, BLD_U + 9]) out.push(st.W(u, BLD_V1 + 1));
  return out;
}

/** Where along the line the trains stop: the platforms' middle, for Railway's `stops`. */
export function stationStop(st) {
  return { s: st.s, wait: STATION_DWELL };
}
