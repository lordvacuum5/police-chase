// Ashfield City: the American map, rebuilt.
//
// "It was the first map we ever made ... I'd never play on it because it's just the most boring map in the
// world." It was a 2 km square of flat grid inside a ring motorway. Now, asked for piece by piece:
//
//   * bigger -- "if it was the biggest map, it'd be really cool": 3 km across (WORLD_HALF 1500, against
//     2 km for Wexbury and Haldon Vale), set by maps.js `half` before the build;
//   * a river through the middle, north to south, in a channel below the streets, crossed by bridges;
//     drive into it and you are busted (main.js, `inWater`);
//   * hills: mostly flat, with a hilly neighbourhood in the north-west -- Ashfield Heights -- and gentler
//     rises east of the river, on Haldon Vale's terrain (world/terrain.js);
//   * a mixed street grid: the downtown core square, the streets outside it bent by a smooth noise, curving
//     in the Heights, two diagonal avenues cutting across it all;
//   * taller downtown: towers to 150 m at the middle, stepping down to the edge of the core;
//   * suburbs: houses with drives (world/drives.js) and cul-de-sacs off the outer streets;
//   * docks on the east bank in the south: container stacks, cranes over the water, warehouses.
//
// Still to come, as asked: the motorway raised up with interchanges and a section through downtown,
// alleys the police can follow you down, a multi-storey car park.
//
// The seed is fixed, so the same city is built every time.

import * as THREE from 'three';
import { chunkMesh } from './chunks.js';
import { drawTree, treeDetail, chunkTrees, lowTrees } from './trees.js';
import { buildingDetail } from './buildtex.js';
import { groundDetail } from './groundtex.js';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { RoadGraph, ROAD_KIND } from './roadgraph.js';
import { approachesAt, addNodeWedges } from './junctions.js';
import { GROUP, addStaticBox, addCanopy, nearBuilding, EDGE_FACE } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, closestOnSegment, TAU } from '../util/math.js';
import {
  WORLD_HALF, GRID_N, KERB_H, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, makeHeightAt, buildGround, buildRoadMeshes, DRAW_ORDER,
} from './common.js';
import { buildHeightGrid, addHeightfield, buildTerrainMesh, liftMesh, liftPieces } from './terrain.js';
import { planDrive, layDrives } from './drives.js';

// ---------------------------------------------------------------- the plan

/** The level of the city's plain, m: high enough for the river to be cut below it. */
const L0 = 6;
/** The river: its water, its bed, how wide the water is either side of the middle, the bank's run up to L0. */
export const WATER = 3.6;
const BED = 0.8;
const WATER_HALF = 30;
const BANK_RUN = 12;
/** Where the river ends short of the map's edge, which falls to the plate (|z|, m). */
const RIVER_END = 1250;
/** Downtown: its middle and radius. */
const DT = { x: -280, z: 60 };
const DT_R = 480;
/** The motorway ring, and the radius of its corners. */
const RING = 1150;
const RING_CORNER = 300;
/** The docks: a box on the east bank in the south. */
const DOCKS = { x0: 190, x1: 640, z0: -1080, z1: -800 };

/** The river's middle at `z`: north to south, meandering east of downtown. */
function riverX(z) {
  return 230 + 140 * Math.sin(z / 520 + 0.6) + 55 * Math.sin(z / 190);
}
function riverSlope(z) {
  return (140 / 520) * Math.cos(z / 520 + 0.6) + (55 / 190) * Math.cos(z / 190);
}
/** How far (x, z) is from the river's middle, signed: + east of it. */
export function riverSide(x, z) {
  const k = riverSlope(z);
  return (x - riverX(z)) / Math.sqrt(1 + k * k);
}
/** How much river there is at `z`: 1 along it, 0 past its ends. */
function riverOn(z) {
  return 1 - smooth(RIVER_END - 60, RIVER_END, Math.abs(z));
}
function smooth(a, b, t) { const u = clamp((t - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); }

/** Is (x, z) in the river's channel (with `pad` m to spare)? */
function inChannel(x, z, pad = 0) {
  return riverOn(z) > 0.05 && Math.abs(riverSide(x, z)) < WATER_HALF + BANK_RUN + pad;
}

function hash(i, j, k) {
  let h = Math.imul(i ^ 0x27d4eb2f, 0x85ebca6b) ^ Math.imul(j + k * 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function noise(x, z, size, k) {
  const fx = x / size, fz = z / size, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash(i, j, k), b = hash(i + 1, j, k), c = hash(i, j + 1, k), d = hash(i + 1, j + 1, k);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

/** The named rises: Ashfield Heights in the north-west, and gentler ones round it. */
const HILLS = [
  { name: 'Ashfield Heights', x: -760, z: 740, r: 380, h: 30 },
  { name: 'Prospect Hill', x: -1060, z: 360, r: 240, h: 16 },
  { name: 'East Ridge', x: 860, z: 740, r: 300, h: 13 },
  { name: 'Southfield Rise', x: -820, z: -720, r: 340, h: 8 },
];
const inHeights = (x, z) => Math.hypot(x - HILLS[0].x, z - HILLS[0].z) < HILLS[0].r + 60;
const dtDist = (x, z) => Math.hypot(x - DT.x, z - DT.z);
const inDocks = (x, z, pad = 0) => x > DOCKS.x0 - pad && x < DOCKS.x1 + pad && z > DOCKS.z0 - pad && z < DOCKS.z1 + pad;

/** The ground before the roads shape it: the plain, the hills, the river cut into it, all fading at the edge. */
function cityRelief(half) {
  return (x, z) => {
    let h = L0;
    for (const hl of HILLS) {
      const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
      h += hl.h * Math.exp(-d2 * 2.2);
    }
    // A little roll outside downtown, so the suburbs are not a table top.
    const far = smooth(DT_R, DT_R + 300, dtDist(x, z));
    h += (noise(x, z, 260, 1) - 0.5) * 4 * far;
    // The river's channel: a bowl of a bed under the water, a bank up to the plain.
    const on = riverOn(z);
    if (on > 0) {
      const d = Math.abs(riverSide(x, z));
      let cut = h;
      if (d < WATER_HALF) cut = BED + 1.2 * (d / WATER_HALF) ** 2;
      else if (d < WATER_HALF + BANK_RUN) cut = lerp(BED + 1.2, h, smooth(0, 1, (d - WATER_HALF) / BANK_RUN));
      h = lerp(h, cut, on);
    }
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h *= 1 - smooth(half - 160, half - 40, edge);
    return Math.max(0, h);
  };
}

// ---------------------------------------------------------------- the build

export function buildCity(sim, scene, seed = 20260822) {
  const rng = makeRng(seed);
  const graph = new RoadGraph(48);
  const surface = new Uint8Array(GRID_N * GRID_N);
  const ctx = { sim, scene, rng, graph, surface, junctions: [], bridges: [] };

  // --- roads ---------------------------------------------------------
  const grid = buildStreets(ctx);
  buildDiagonals(ctx, grid);
  const ring = buildRingMotorway(ctx);
  connectRamps(ctx, grid, ring);
  buildCountryRoads(ctx, ring);
  buildCulDeSacs(ctx, grid);
  const roundabout = buildRoundabout(ctx, grid);
  graph.addTurningHeads(15, 10, WORLD_HALF);
  // Traffic lights downtown only: at every one of the city's junctions they were 1,595 heads, and with the
  // avenues' junctions too still 927 -- each in four instanced meshes drawn whole every frame, 290,000
  // triangles of a suburban view's 1,000,000.
  graph.signalFilter = (node) => dtDist(node.x, node.z) < DT_R + 60;
  graph.finalise();
  markBridges(ctx);
  nameRoads(graph);

  // --- ground --------------------------------------------------------
  const base = cityRelief(WORLD_HALF);
  // Downtown is level already (cityRelief): a flatten disc round it filled the river in where they met.
  const flatten = [];
  // The docks' yard, level, kept back from the bank so the river is not filled in.
  for (let z = DOCKS.z0 + 40; z < DOCKS.z1; z += 60) {
    const x = riverX(z) + WATER_HALF + BANK_RUN + 70;
    flatten.push({ x, z, r: 60, fade: 30, h: L0 });
  }
  const skipClaim = (e, x, z) => e.bridge && inChannel(x, z, 6);
  const hgrid = buildHeightGrid(base, { half: WORLD_HALF, graph, flatten, skipClaim });
  ctx.grid = hgrid;
  // The bridges' decks, level from bank to bank; the height of anything is the deck where there is one.
  for (const b of ctx.bridges) { b.ha = hgrid.at(b.ax, b.az); b.hb = hgrid.at(b.bx, b.bz); }
  const deckAt = (x, z) => {
    let best = -Infinity;
    for (const b of ctx.bridges) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const dx = x - b.ax, dz = z - b.az;
      const t = (dx * b.ux + dz * b.uz) / b.len;
      if (t < -0.02 || t > 1.02) continue;
      if (Math.abs(-dx * b.uz + dz * b.ux) > b.hw + 0.8) continue;
      best = Math.max(best, lerp(b.ha, b.hb, clamp(t, 0, 1)));
    }
    return best;
  };
  const at = (x, z) => Math.max(hgrid.at(x, z), deckAt(x, z));
  ctx.at = at;
  ctx.deckAt = deckAt;
  addHeightfield(sim.world, hgrid);

  // --- surfaces ------------------------------------------------------
  paintPavements(ctx);
  rasteriseRoads(graph, surface);
  ctx.surfAt = makeSurfaceAt(surface);
  const kerbAt = makeHeightAt(surface);
  const heightAt = (x, z) => at(x, z) + kerbAt(x, z);

  // --- visuals -------------------------------------------------------
  const meshes = [];
  buildGround(ctx);          // the plate under it all and the wall at the edge, not the flat mesh
  meshes.push(...buildTerrain(ctx, hgrid));
  const [tarmac, markings, kerbs, wear] = buildRoadMeshes(ctx);
  const lifted = liftRoads(ctx, [tarmac, markings, kerbs]);
  // The kerbs in cells: one mesh of them was 77,000 triangles drawn wherever you looked.
  meshes.push(lifted[0], lifted[1], chunkMesh(lifted[2], 300));
  if (wear) {
    liftMesh(wear, at, 0.06);
    wear.material.polygonOffsetFactor = -4;
    wear.material.polygonOffsetUnits = -8;
    meshes.push(wear);
  }
  meshes.push(buildPavements(ctx));
  meshes.push(...buildBridges(ctx));
  const water = buildWater();
  meshes.push(water);
  meshes.push(...buildDocks(ctx));
  meshes.push(...buildBuildings(ctx, roundabout));
  meshes.push(buildTrees(ctx));
  for (const m of meshes) if (m) scene.add(m);

  return {
    graph,
    surface,
    surfaceAt: makeSurfaceAt(surface),
    heightAt,
    terrainAt: at,
    relief: hgrid.max + 4,
    meshes,
    roundabout,
    bounds: WORLD_HALF,
    parked: ctx.parked || [],
    driveStrips: ctx.driveStrips || [],
    /** In the river, below its surface: busted (main.js). */
    inWater: (x, z, y) => y < WATER + 0.4 && riverOn(z) > 0.3 && Math.abs(riverSide(x, z)) < WATER_HALF + BANK_RUN * 0.5
      && deckAt(x, z) < y - 1.2,
    water: WATER,
    clearAt: (x, z) => inChannel(x, z, 2),
    update: (game, dt) => water.userData.update(dt || 1 / 60),
  };
}

// =====================================================================
//  Roads
// =====================================================================

/** The street grid's lines: tight downtown, opening out. */
const GX = [-1000, -880, -770, -670, -585, -510, -445, -385, -325, -265, -205, -145, -85, -25, 40, 110, 185, 265, 350, 445, 550, 665, 790, 1000];
const GZ = [-1000, -870, -750, -640, -545, -460, -380, -310, -245, -180, -115, -50, 15, 80, 145, 210, 280, 355, 440, 530, 630, 745, 870, 1000];
const AVENUE_X = new Set([-445, -145, 350]);
const AVENUE_Z = new Set([-380, 80, 530]);

/**
 * Add a road from node `a` to node `b`, through `pts`; if it crosses the river, as three edges -- to the
 * near bank, the bridge, on from the far bank -- or not at all unless `bridge` says one is wanted.
 */
function addRoad(ctx, a, b, kind, pts = [], bridge = false, opts = {}) {
  const { graph } = ctx;
  const line = [a, ...pts, b];
  // Where it crosses: the first change of side, both ends in the river's reach.
  let cross = -1;
  for (let k = 0; k < line.length - 1; k++) {
    const p = line[k], q = line[k + 1];
    if (riverOn((p.z + q.z) / 2) < 0.2) continue;
    if (Math.sign(riverSide(p.x, p.z)) !== Math.sign(riverSide(q.x, q.z))) { cross = k; break; }
  }
  if (cross < 0) return graph.addEdge(a, b, kind, pts.length ? pts : null, opts);
  if (!bridge) return null;
  const p = line[cross], q = line[cross + 1];
  const L = Math.hypot(q.x - p.x, q.z - p.z);
  const ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
  // The two banks along it, where it is BANK m out of the river either side.
  const BANK = WATER_HALF + BANK_RUN + 16;
  let t0 = 0, t1 = L;
  for (let t = 0; t <= L; t += 1) {
    const s = riverSide(p.x + ux * t, p.z + uz * t);
    if (Math.sign(s) === Math.sign(riverSide(p.x, p.z)) && Math.abs(s) >= BANK) t0 = t;
  }
  for (let t = L; t >= 0; t -= 1) {
    const s = riverSide(p.x + ux * t, p.z + uz * t);
    if (Math.sign(s) === Math.sign(riverSide(q.x, q.z)) && Math.abs(s) >= BANK) t1 = t;
  }
  if (t1 - t0 < 20) return null;
  const n0 = graph.addNode(p.x + ux * t0, p.z + uz * t0, 'bridge');
  const n1 = graph.addNode(p.x + ux * t1, p.z + uz * t1, 'bridge');
  // `line` is [a, ...pts, b]: the points before the crossing are pts[0 .. cross-1], after it pts[cross ..].
  const before = pts.slice(0, cross), after = pts.slice(cross);
  graph.addEdge(a, n0, kind, before.length ? before : null, opts);
  const span = graph.addEdge(n0, n1, kind, null, { ...opts, bridge: true });
  graph.addEdge(n1, b, kind, after.length ? after : null, opts);
  if (span) span.overWater = true;
  return span;
}

function buildStreets(ctx) {
  const { graph, rng } = ctx;
  const NX = GX.length, NZ = GZ.length;
  const nodes = [];
  // Bent outside downtown by a smooth noise, more in the Heights: "mixed street grid".
  const shift = (x, z) => {
    const d = dtDist(x, z);
    let amp = 26 * smooth(DT_R - 40, DT_R + 260, d);
    if (inHeights(x, z)) amp = 46;
    return {
      x: x + (noise(x, z, 330, 11) - 0.5) * 2 * amp,
      z: z + (noise(x, z, 330, 12) - 0.5) * 2 * amp,
    };
  };
  for (let i = 0; i < NX; i++) {
    nodes[i] = [];
    for (let j = 0; j < NZ; j++) {
      const p = shift(GX[i], GZ[j]);
      // Not in or by the river, nor out on the docks' quay.
      if (inChannel(p.x, p.z, 26) || inDocks(p.x, p.z, -30)) { nodes[i][j] = null; continue; }
      nodes[i][j] = graph.addNode(p.x, p.z, 'cross');
    }
  }
  const outer = (n) => dtDist(n.x, n.z) > DT_R + 60;
  /** Bowed, in the Heights and a little elsewhere outside downtown, so streets curve. */
  const bow = (a, b) => {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const k = inHeights(mx, mz) ? 0.22 : outer(a) && outer(b) ? 0.07 : 0;
    if (!k) return [];
    const L = Math.hypot(b.x - a.x, b.z - a.z), s = (noise(mx, mz, 90, 13) - 0.5) * 2 * k * L;
    return [{ x: mx - (b.z - a.z) / L * s, z: mz + (b.x - a.x) / L * s }];
  };
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      const n = nodes[i][j];
      if (!n) continue;
      // East: walk on past the river to the first node beyond it, for a bridge.
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        let ii = i + di, jj = j + dj;
        while (ii < NX && jj < NZ && !nodes[ii][jj] && inChannel(...xz(shift, ii, jj), 26)) { ii += di; jj += dj; }
        if (ii >= NX || jj >= NZ || !nodes[ii][jj]) continue;
        const m = nodes[ii][jj];
        const avenue = di ? AVENUE_Z.has(GZ[j]) : AVENUE_X.has(GX[i]);
        // Thinned outside downtown, so the suburbs are not a perfect lattice.
        if (outer(n) && outer(m) && !avenue && rng() < 0.16) continue;
        // A bridge on every avenue and every other street that reaches the river.
        const wantBridge = avenue || (di ? j % 2 === 0 : i % 2 === 0);
        addRoad(ctx, n, m, avenue ? 'avenue' : 'street', bow(n, m), wantBridge);
      }
    }
  }
  // Anything stranded joined to its nearest neighbour on the same bank.
  for (const n of graph.nodes) {
    if (n.edges.length) continue;
    let best = null, bd = Infinity;
    for (const m of graph.nodes) {
      if (m === n || !m.edges.length) continue;
      const d = dist2(n.x, n.z, m.x, m.z);
      if (d < bd && Math.sign(riverSide(n.x, n.z)) === Math.sign(riverSide(m.x, m.z))) { bd = d; best = m; }
    }
    if (best) graph.addEdge(n, best, 'street');
  }
  return { nodes, NX, NZ };
}
const xz = (shift, i, j) => { const p = shift(GX[Math.min(i, GX.length - 1)], GZ[Math.min(j, GZ.length - 1)]); return [p.x, p.z]; };

/** Two diagonal avenues across the grid: the stitching in graph.finalise makes their junctions. */
function buildDiagonals(ctx, grid) {
  const { graph } = ctx;
  const near = (x, z) => {
    let best = null, bd = Infinity;
    for (const n of graph.nodes) {
      if (n.type !== 'cross') continue;
      const d = dist2(n.x, n.z, x, z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const lines = [
    // South-west to north-east, past downtown and over the river.
    [[-930, -780], [-280, -130], [760, 900]],
    // North-west out of the Heights to the south of downtown.
    [[-960, 560], [-40, -560]],
  ];
  ctx.diagonals = [];
  for (const pts of lines) {
    const ns = pts.map(([x, z]) => near(x, z));
    for (let k = 0; k < ns.length - 1; k++) {
      const e = addRoad(ctx, ns[k], ns[k + 1], 'avenue', [], true);
      if (e) ctx.diagonals.push(e);
    }
  }
}

/** The ring motorway: a rounded square, sampled finely on its corners. At ground level for now. */
function buildRingMotorway(ctx) {
  const { graph } = ctx;
  const straight = RING - RING_CORNER;
  const pts = [];
  const arc = (cx, cz, a0, a1, steps) => {
    for (let s = 1; s < steps; s++) {
      const a = lerp(a0, a1, s / steps);
      pts.push({ x: cx + Math.cos(a) * RING_CORNER, z: cz + Math.sin(a) * RING_CORNER });
    }
  };
  const along = (x0, z0, x1, z1, steps) => {
    for (let s = 0; s < steps; s++) pts.push({ x: lerp(x0, x1, s / steps), z: lerp(z0, z1, s / steps) });
  };
  along(RING, -straight, RING, straight, 9);
  arc(straight, straight, 0, Math.PI / 2, 18);
  along(straight, RING, -straight, RING, 9);
  arc(-straight, straight, Math.PI / 2, Math.PI, 18);
  along(-RING, straight, -RING, -straight, 9);
  arc(-straight, -straight, Math.PI, Math.PI * 1.5, 18);
  along(-straight, -RING, straight, -RING, 9);
  arc(straight, -straight, Math.PI * 1.5, TAU, 18);
  // Where the ring crosses the river, addRoad puts a node on each bank and the bridge between them.
  const ring = [];
  for (const p of pts) ring.push(graph.addNode(p.x, p.z, 'motorway'));
  for (let i = 0; i < ring.length; i++) addRoad(ctx, ring[i], ring[(i + 1) % ring.length], 'motorway', [], true);
  return ring;
}

/**
 * Walk the ring polyline outward from a node, emitting points every `step` metres offset to one side.
 * It has to follow the polyline rather than the tangent: 165 m along a bend departs from it by tens of metres.
 */
function walkRing(ring, idx, backDist, aheadDist, step = 12) {
  const N = ring.length;
  const at = (i) => ring[((i % N) + N) % N];
  const pts = [];
  let i = idx, cur = at(i), travelled = 0, next = 0, guard = 0;
  while (next <= backDist && guard++ < 600) {
    const prev = at(i - 1);
    const dx = cur.x - prev.x, dz = cur.z - prev.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-3) { i--; cur = prev; continue; }
    while (next <= travelled + segLen && next <= backDist) {
      const t = (next - travelled) / segLen;
      pts.push({ x: cur.x - dx * t, z: cur.z - dz * t, fx: dx / segLen, fz: dz / segLen, s: -next });
      next += step;
    }
    travelled += segLen; i--; cur = prev;
  }
  i = idx; cur = at(i); travelled = 0; next = step; guard = 0;
  while (next <= aheadDist && guard++ < 600) {
    const nxt = at(i + 1);
    const dx = nxt.x - cur.x, dz = nxt.z - cur.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-3) { i++; cur = nxt; continue; }
    while (next <= travelled + segLen && next <= aheadDist) {
      const t = (next - travelled) / segLen;
      pts.push({ x: cur.x + dx * t, z: cur.z + dz * t, fx: dx / segLen, fz: dz / segLen, s: next });
      next += step;
    }
    travelled += segLen; i++; cur = nxt;
  }
  return pts;
}

function offsetOf(p, side, dist) {
  return { x: p.x + -p.fz * side * dist, z: p.z + p.fx * side * dist };
}

/**
 * One slip road onto the ring, merging at a shallow angle the way a real one does, each junction with a
 * stretch of ring to itself. Not at a node by the river (its bridge) -- nor anywhere a slip road would
 * have to cross the water.
 */
function addSlipRoad(ctx, ring, anchor, aim) {
  const { graph, junctions } = ctx;
  const half = ROAD_KIND.motorway.width * 0.5;
  const MERGE_BACK = 165;
  const distToRing = (px, pz) => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const r = closestOnSegment(px, pz, a.x, a.z, b.x, b.z);
      if (r.dist < best) best = r.dist;
    }
    return best;
  };
  const candidates = ring.map((n, i) => ({ i, d: dist2(n.x, n.z, aim.x, aim.z) })).sort((p, q) => p.d - q.d);
  for (const cand of candidates) {
    const idx = cand.i;
    const N = ring[idx];
    if (junctions.some((j) => dist2(N.x, N.z, j.node.x, j.node.z) < 260 * 260)) continue;
    if (inChannel(N.x, N.z, 120)) continue;
    const prev = ring[(idx - 1 + ring.length) % ring.length];
    const next = ring[(idx + 1) % ring.length];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const side = ((anchor.x - N.x) * -tz + (anchor.z - N.z) * tx) >= 0 ? 1 : -1;
    const alongAnchor = (anchor.x - N.x) * tx + (anchor.z - N.z) * tz;
    const dirSign = alongAnchor >= 0 ? 1 : -1;
    const spine = walkRing(ring, idx, MERGE_BACK, MERGE_BACK, 5);
    const atS = (s) => {
      let best = spine[0], bd = Infinity;
      for (const q of spine) { const d = Math.abs(q.s - s); if (d < bd) { bd = d; best = q; } }
      return best;
    };
    const taper = [
      offsetOf(atS(dirSign * 125), side, half + 30),
      offsetOf(atS(dirSign * 80), side, half + 16),
      offsetOf(atS(dirSign * 38), side, half + 4),
    ];
    const t0 = taper[0];
    let tdx = taper[1].x - t0.x, tdz = taper[1].z - t0.z;
    const tdl = Math.hypot(tdx, tdz) || 1; tdx /= tdl; tdz /= tdl;
    let adx = t0.x - anchor.x, adz = t0.z - anchor.z;
    const adl = Math.hypot(adx, adz) || 1; adx /= adl; adz /= adl;
    const handle = adl * 0.45;
    const c1 = { x: anchor.x + adx * handle, z: anchor.z + adz * handle };
    const c2 = { x: t0.x - tdx * handle * 0.8, z: t0.z - tdz * handle * 0.8 };
    const approach = [];
    for (let s = 1; s <= 5; s++) {
      const u = s / 6, iu = 1 - u;
      const w0 = iu * iu * iu, w1 = 3 * iu * iu * u, w2 = 3 * iu * u * u, w3 = u * u * u;
      approach.push({ x: w0 * anchor.x + w1 * c1.x + w2 * c2.x + w3 * t0.x, z: w0 * anchor.z + w1 * c1.z + w2 * c2.z + w3 * t0.z });
    }
    if (approach.some((q) => distToRing(q.x, q.z) < half + 4)) continue;
    const full = [anchor, ...approach, taper[0], taper[1], taper[2], N];
    if (full.some((q) => inChannel(q.x, q.z, 8))) continue;
    let sharpest = 0;
    for (let i = 1; i < full.length - 1; i++) {
      const ux = full[i - 1].x - full[i].x, uz = full[i - 1].z - full[i].z;
      const vx = full[i + 1].x - full[i].x, vz = full[i + 1].z - full[i].z;
      const ul = Math.hypot(ux, uz) || 1, vl = Math.hypot(vx, vz) || 1;
      sharpest = Math.max(sharpest, Math.PI - Math.acos(clamp((ux * vx + uz * vz) / (ul * vl), -1, 1)));
    }
    if (sharpest > 1.25) continue;
    graph.addEdge(anchor, N, 'ramp', [...approach, taper[0], taper[1], taper[2]]);
    junctions.push({ node: N });
    return N;
  }
  return null;
}

function connectRamps(ctx, grid, ring) {
  const { graph } = ctx;
  // The outermost grid node nearest each of eight bearings.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + 0.15;
    const aim = { x: Math.cos(a) * 1000, z: Math.sin(a) * 1000 };
    let best = null, bd = Infinity;
    for (const n of graph.nodes) {
      if (n.type !== 'cross' || !n.edges.length) continue;
      const d = dist2(n.x, n.z, aim.x, aim.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (best) addSlipRoad(ctx, ring, best, { x: best.x * 1.25, z: best.z * 1.25 });
  }
}

/** Winding country roads beyond the ring, joined to it by slip roads. */
function buildCountryRoads(ctx, ring) {
  const { graph, rng } = ctx;
  const outer = [];
  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * TAU + 0.2;
    const r = RING + 150 + Math.sin(a * 3.0) * 40 + Math.cos(a * 1.7) * 30;
    outer.push(graph.addNode(Math.cos(a) * r, Math.sin(a) * r, 'country'));
  }
  for (let i = 0; i < COUNT; i++) {
    const a = outer[i], b = outer[(i + 1) % COUNT];
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    const nx = -(b.z - a.z), nz = (b.x - a.x);
    const nl = Math.hypot(nx, nz) || 1;
    const bulge = rand(rng, -45, 45);
    addRoad(ctx, a, b, 'country', [{ x: mx + (nx / nl) * bulge, z: mz + (nz / nl) * bulge }], true);
  }
  for (let i = 1; i < COUNT; i += 3) {
    const a = outer[i];
    addSlipRoad(ctx, ring, a, { x: a.x * 0.88, z: a.z * 0.88 });
  }
}

/**
 * Cul-de-sacs off the suburban streets: a short close from a junction, ending in a turning head with
 * houses round it. Only where the close crosses no road and no river.
 */
function buildCulDeSacs(ctx, grid) {
  const { graph, rng } = ctx;
  const segs = [];
  for (const e of graph.edges) {
    const pts = [graph.nodes[e.a], ...(e.points || []), graph.nodes[e.b]];
    for (let k = 0; k < pts.length - 1; k++) segs.push([pts[k], pts[k + 1]]);
  }
  const clear = (ax, az, bx, bz) => {
    for (let t = 0.15; t <= 1.001; t += 0.1) {
      const x = lerp(ax, bx, t), z = lerp(az, bz, t);
      if (inChannel(x, z, 20) || inDocks(x, z, 20)) return false;
      for (const [p, q] of segs) if (closestOnSegment(x, z, p.x, p.z, q.x, q.z).dist < 26) return false;
    }
    return true;
  };
  ctx.closes = [];
  for (const n of graph.nodes.slice()) {
    if (n.type !== 'cross' || n.edges.length < 2 || n.edges.length > 3) continue;
    const d = dtDist(n.x, n.z);
    if (d < DT_R + 180 || Math.hypot(n.x, n.z) > RING - 160) continue;
    if (rng() > 0.55) continue;
    // Between two of its roads: the widest gap.
    const dirs = n.edges.map((eid) => {
      const e = graph.edges[eid], o = graph.nodes[e.a === n.id ? e.b : e.a];
      return Math.atan2(o.z - n.z, o.x - n.x);
    }).sort((a, b) => a - b);
    let gap = 0, dir = 0;
    for (let k = 0; k < dirs.length; k++) {
      const a = dirs[k], b = k + 1 < dirs.length ? dirs[k + 1] : dirs[0] + TAU;
      if (b - a > gap) { gap = b - a; dir = a + (b - a) / 2; }
    }
    if (gap < 1.4) continue;
    const L = rand(rng, 60, 95);
    const bx = n.x + Math.cos(dir) * L, bz = n.z + Math.sin(dir) * L;
    if (!clear(n.x, n.z, bx, bz)) continue;
    const m = graph.addNode(bx, bz, 'close');
    // A gentle bend in it.
    const s = rand(rng, -10, 10);
    const mid = { x: (n.x + bx) / 2 - Math.sin(dir) * s, z: (n.z + bz) / 2 + Math.cos(dir) * s };
    graph.addEdge(n, m, 'lane', [mid]);
    segs.push([n, mid], [mid, m]);
    ctx.closes.push(m);
  }
}

/** One roundabout, in place of a suburban crossroads east of the river. */
function buildRoundabout(ctx) {
  const { graph } = ctx;
  let centre = null, bd = Infinity;
  for (const n of graph.nodes) {
    if (n.type !== 'cross' || n.edges.length !== 4) continue;
    if (riverSide(n.x, n.z) < 200) continue;
    const d = dist2(n.x, n.z, 620, -120);
    if (d < bd) { bd = d; centre = n; }
  }
  if (!centre) return null;
  const R = 30;
  const approaches = centre.edges.slice();
  const ringNodes = [];
  const K = 8;
  for (let k = 0; k < K; k++) {
    const a = (k / K) * TAU;
    ringNodes.push(graph.addNode(centre.x + Math.cos(a) * R, centre.z + Math.sin(a) * R, 'roundabout'));
  }
  for (let k = 0; k < K; k++) graph.addEdge(ringNodes[k], ringNodes[(k + 1) % K], 'street', null, { width: 11, speed: 12 });
  for (const eid of approaches) {
    const e = graph.edges[eid];
    const o = graph.nodes[e.a === centre.id ? e.b : e.a];
    let best = ringNodes[0], bdd = Infinity;
    for (const rn of ringNodes) {
      const d = (rn.x - o.x) ** 2 + (rn.z - o.z) ** 2;
      if (d < bdd) { bdd = d; best = rn; }
    }
    graph.addEdge(best, o, e.kind, e.points && e.points.length > 2 ? e.points.slice(1, -1) : null);
    e.dead = true;
  }
  graph.edges = graph.edges.filter((e) => !e.dead);
  graph.edges.forEach((e, i) => { e.id = i; });
  for (const n of graph.nodes) n.edges = [];
  graph.edges.forEach((e) => { graph.nodes[e.a].edges.push(e.id); graph.nodes[e.b].edges.push(e.id); });
  return { x: centre.x, z: centre.z, r: R };
}

/** After finalise has smoothed and stitched: every edge over the water is a bridge, and its deck noted. */
function markBridges(ctx) {
  const { graph } = ctx;
  for (const e of graph.edges) {
    const pts = e.points;
    let over = false;
    for (let k = 0; k < pts.length - 1 && !over; k++) {
      if (riverOn(pts[k].z) > 0.2 && Math.sign(riverSide(pts[k].x, pts[k].z)) !== Math.sign(riverSide(pts[k + 1].x, pts[k + 1].z))) over = true;
    }
    e.bridge = over;
    if (!over) continue;
    const a = pts[0], b = pts[pts.length - 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const hw = e.width * 0.5 + 0.6;
    ctx.bridges.push({
      e, ax: a.x, az: a.z, bx: b.x, bz: b.z, len, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, hw,
      minX: Math.min(a.x, b.x) - hw - 2, maxX: Math.max(a.x, b.x) + hw + 2,
      minZ: Math.min(a.z, b.z) - hw - 2, maxZ: Math.max(a.z, b.z) + hw + 2,
    });
  }
}

// =====================================================================
//  Names
// =====================================================================

const NS_NAMES = ['Kingsway', 'Ashcroft Road', 'Verne Street', 'Halloway', 'Bright Lane', 'Carrick Road',
  'Meridian Avenue', 'Osprey Street', 'Faraday Road', 'Linden Way', 'Marlow Street', 'Quarry Road',
  'Sutton Row', 'Weir Street', 'Bellamy Road', 'Harbor Street', 'Pine Avenue', 'Union Street',
  'Calloway Road', 'Mercer Street', 'Dalton Way', 'Fulton Street', 'Garfield Road', 'Hudson Street'];
const EW_NAMES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth',
  'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth',
  'Eighteenth', 'Nineteenth', 'Twentieth', 'Twenty-First', 'Twenty-Second', 'Twenty-Third', 'Twenty-Fourth'];
const COUNTRY_NAMES = ['Fen Road', 'Barrow Lane', 'Cold Harbour', 'Mill Track', 'Hollow Road', 'Stannard Lane', 'Long Furlong', 'Thistledown'];
const CLOSE_NAMES = ['Maple Court', 'Birch Close', 'Cedar Court', 'Willow Close', 'Aspen Court', 'Rowan Close', 'Hazel Court', 'Elm Close'];

function nameRoads(graph) {
  const nearestIn = (arr, v) => { let best = 0, bd = Infinity; arr.forEach((g, i) => { const d = Math.abs(g - v); if (d < bd) { bd = d; best = i; } }); return best; };
  let cn = 0, ln = 0;
  for (const e of graph.edges) {
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    if (e.kind === 'motorway') { e.name = e.bridge ? 'the M1 river bridge' : 'the M1 ring'; continue; }
    if (e.kind === 'ramp') { e.name = 'the slip road'; continue; }
    if (e.kind === 'country') { e.name = COUNTRY_NAMES[(cn++) % COUNTRY_NAMES.length]; continue; }
    if (e.kind === 'lane') { e.name = CLOSE_NAMES[(ln++) % CLOSE_NAMES.length]; continue; }
    const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);
    if (dx > 40 && dz > 40 && Math.abs(dx - dz) < Math.max(dx, dz) * 0.5) e.name = a.z < b.z === a.x < b.x ? 'Broadway' : 'Riverside Avenue';
    else if (dz >= dx) e.name = NS_NAMES[nearestIn(GX, (a.x + b.x) / 2) % NS_NAMES.length];
    else e.name = EW_NAMES[nearestIn(GZ, (a.z + b.z) / 2) % EW_NAMES.length] + ' Street';
    if (e.bridge) e.name = `the ${e.name.replace(/ Street$| Road$| Avenue$/, '')} Bridge`;
    if (e.width === 11) e.name = 'the roundabout';
  }
  for (const n of graph.nodes) {
    const names = [];
    for (const eid of n.edges) {
      const nm = graph.edges[eid].name;
      if (nm && names.indexOf(nm) === -1) names.push(nm);
    }
    n.name = names.length >= 2 ? `${names[0]} / ${names[1]}` : (names[0] || 'the junction');
  }
}

// =====================================================================
//  Surfaces, ground, roads and pavements drawn
// =====================================================================

/** How far the footway runs out from a road's edge, each side. */
function paveOf(e) {
  if (e.kind === 'motorway' || e.kind === 'ramp' || e.kind === 'country' || e.turningHead) return 0;
  if (e.kind === 'lane') return 2.5;
  const m = e.points[Math.floor(e.points.length / 2)];
  return dtDist(m.x, m.z) < DT_R + 40 ? 5.5 : 3.5;
}

function paintPavements(ctx) {
  const { graph, surface } = ctx;
  for (const e of graph.edges) {
    const p = paveOf(e);
    e.pave = p;
    if (!p) continue;
    for (const sg of e.segs) {
      const steps = Math.max(1, Math.ceil(sg.len / 1.5));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(sg.a.x, sg.b.x, t), lerp(sg.a.z, sg.b.z, t), e.width * 0.5 + p, SURF_PAVED);
      }
    }
  }
  // Downtown is paved from street to street: plazas and forecourts, not lawns, between the towers.
  const r = DT_R - 30;
  for (let x = DT.x - r; x <= DT.x + r; x += 6) {
    for (let z = DT.z - r; z <= DT.z + r; z += 6) {
      if (dtDist(x, z) < r && !inChannel(x, z, 10)) paintDisc(surface, x, z, 4.4, SURF_PAVED);
    }
  }
}

/** The ground: grass, the river's banks and bed, downtown's paving; and the strip of plate past the map. */
function buildTerrain(ctx, hgrid) {
  const sf = ctx.surfAt;
  const nearRoad = (x, z) => {
    for (const [ox, oz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
      if (sf(x + ox, z + oz) === SURF_ROAD) return 0.45;
    }
    return 0;
  };
  const colour = (x, z, y, c) => {
    const d = Math.abs(riverSide(x, z)), on = riverOn(z);
    if (on > 0.3 && d < WATER_HALF + BANK_RUN + 3 && y < L0 - 0.3) {
      // Mud under the water, a stony bank above it.
      if (y < WATER + 0.2) c.setHSL(0.10, 0.22, 0.17);
      else c.setHSL(0.11, 0.14, 0.33);
    } else if (dtDist(x, z) < DT_R - 30) c.setHSL(0.08, 0.04, 0.42);
    else if (inDocks(x, z, 20)) c.setHSL(0.6, 0.03, 0.36);
    else c.setHSL(0.24 + noise(x, z, 140, 3) * 0.04, 0.34, 0.27 + noise(x, z, 60, 4) * 0.05);
    c.offsetHSL(0, 0, Math.min(0.05, Math.max(0, y - L0) / 400));
  };
  // In tiles of TILE m, each its own level of detail: a 5 m mesh near, 15 m past TILE_FAR. As one 5 m mesh
  // it was 720,000 triangles drawn whole every frame wherever you looked -- off the screen too, since one
  // mesh is either in view or not -- and took the frame on this machine from 7.4 ms to 9.5.
  const TILE = 300, TILE_FAR = 450;
  const terrain = new THREE.Group();
  terrain.name = 'terrain';
  for (let x0 = -WORLD_HALF; x0 < WORLD_HALF; x0 += TILE) {
    for (let z0 = -WORLD_HALF; z0 < WORLD_HALF; z0 += TILE) {
      const patch = { x0, z0, size: TILE };
      // The LOD at the tile's middle, so it measures its distance from there; the meshes, built in world
      // co-ordinates, moved back by as much.
      const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
      const lod = new THREE.LOD();
      lod.position.set(cx, 0, cz);
      for (const [step, dist] of [[5, 0], [15, TILE_FAR]]) {
        const m = buildTerrainMesh(hgrid, colour, step, nearRoad, 0, patch);
        m.renderOrder = DRAW_ORDER.ground;
        m.position.set(-cx, 0, -cz);
        lod.addLevel(m, dist);
      }
      terrain.add(lod);
    }
  }
  const plate = { half: EDGE_FACE + 4, at: () => 0 };
  const ring = buildTerrainMesh(plate, (x, z, y, c) => c.setHSL(0.24, 0.32, 0.27), 20, null, WORLD_HALF);
  ring.name = 'terrain-edge';
  ring.renderOrder = DRAW_ORDER.ground;
  return [terrain, ring];
}

/** The roads lifted onto the ground (and the decks), depth-tested and pulled forward to stay on top. */
function liftRoads(ctx, meshes) {
  for (const m of meshes) {
    liftMesh(m, ctx.at, 0.06);
    m.material = m.material.clone();
    m.material.depthFunc = THREE.LessEqualDepth;
    m.material.polygonOffset = true;
    m.material.polygonOffsetFactor = -3;
    m.material.polygonOffsetUnits = -6;
  }
  return meshes;
}

function buildPavements(ctx) {
  const { graph } = ctx;
  const b = new MeshBuilder();
  for (const e of graph.edges) if (e.pave) b.addRibbon(e.points, e.width + e.pave * 2, KERB_H, PALETTE.pavement);
  for (const n of graph.nodes) {
    const app = approachesAt(graph, n).filter((a) => a.edge && a.edge.pave);
    if (app.length) addNodeWedges(b, n, app, (e) => e.width * 0.5 + e.pave, KERB_H - 0.001, PALETTE.pavement);
  }
  // Downtown's plazas, a kerb high, in 6 m squares that follow the ground.
  const r = DT_R - 34;
  for (let x = DT.x - r; x < DT.x + r; x += 6) {
    for (let z = DT.z - r; z < DT.z + r; z += 6) {
      if (dtDist(x + 3, z + 3) > r || inChannel(x + 3, z + 3, 10)) continue;
      b.addQuadY(x, z, x + 6, z, x + 6, z + 6, x, z + 6, KERB_H - 0.002, PALETTE.pavement);
    }
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ depthWrite: false }));
  mesh.renderOrder = DRAW_ORDER.pavement;
  liftMesh(mesh, ctx.at, 0.05);
  mesh.name = 'pavements';
  groundDetail(mesh, 'tarmac');
  mesh.receiveShadow = true;
  return chunkMesh(mesh, 250);
}

// =====================================================================
//  The river
// =====================================================================

/** A canvas of ripples, as a normal map: the water's surface. */
function rippleNormals() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const img = x.createImageData(S, S);
  // A height of a few overlapping waves that tile, and its slope as the normal.
  const hgt = (i, j) => {
    const u = (i / S) * TAU, v = (j / S) * TAU;
    return Math.sin(u * 3 + Math.sin(v * 2) * 1.3) * 0.5 + Math.sin(v * 5 + u * 2) * 0.3
      + Math.sin((u + v) * 7) * 0.15 + Math.sin(u * 11 - v * 4) * 0.08;
  };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const dx = hgt(i + 1, j) - hgt(i - 1, j), dz = hgt(i, j + 1) - hgt(i, j - 1);
      const nx = -dx * 2.2, nz = -dz * 2.2, l = Math.hypot(nx, nz, 1);
      const k = (j * S + i) * 4;
      img.data[k] = (nx / l * 0.5 + 0.5) * 255;
      img.data[k + 1] = (nz / l * 0.5 + 0.5) * 255;
      img.data[k + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * The water: one ribbon down the river at WATER, wider than the water is, so the banks (drawn over it where
 * they stand above it) give it its edge. Smooth and a little transparent, reflecting the sky (scene's
 * environment, sky.js), with two layers of ripples drifting downstream.
 */
function buildWater() {
  const pos = [], uv = [];
  const W = WATER_HALF + BANK_RUN * 0.6;
  let prev = null, s = 0;
  for (let z = -RIVER_END + 20; z <= RIVER_END - 20; z += 10) {
    const x = riverX(z), k = riverSlope(z), l = Math.sqrt(1 + k * k);
    // Across: at right angles to the river's run (dx/dz = k).
    const ax = 1 / l, az = -k / l;
    if (prev) s += Math.hypot(x - prev.x, z - prev.z);
    pos.push(x - ax * W, WATER, z - az * W, x + ax * W, WATER, z + az * W);
    uv.push(0, s / 40, (2 * W) / 40, s / 40);
    prev = { x, z };
  }
  const idx = [];
  for (let r = 0; r < pos.length / 6 - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const normalMap = rippleNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1d4a55, roughness: 0.06, metalness: 0.15, transparent: true, opacity: 0.86,
    normalMap, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.2,
  });
  const second = normalMap.clone();
  second.needsUpdate = true;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'river';
  mesh.receiveShadow = true;
  mesh.userData.update = (dt) => {
    normalMap.offset.y -= dt * 0.03;
    normalMap.offset.x += dt * 0.004;
  };
  return mesh;
}

/** The bridges drawn: a deck under each span's road, a parapet each side, and piers down into the river. */
function buildBridges(ctx) {
  const b = new MeshBuilder();
  const W = ctx.sim.world;
  for (const br of ctx.bridges) {
    const { ax, az, ux, uz, len, ha, hb, hw } = br;
    const rot = Math.atan2(ux, uz);
    const n = Math.max(1, Math.ceil(len / 12));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
      const x = ax + ux * len * tm, z = az + uz * len * tm, y = lerp(ha, hb, tm);
      const L = len / n + 0.2;
      // The deck: a slab under the road, 1.4 m deep, its edge facing.
      b.addBox(hw * 2 + 1.2, 1.4, L, x, y - 0.66, z, 0x8a8a86, rot);
      // Parapets.
      for (const sd of [-1, 1]) {
        const px = x + uz * (hw + 0.3) * sd, pz = z - ux * (hw + 0.3) * sd;
        b.addBox(0.5, 1.0, L, px, y + 0.5, pz, 0xa3a29c, rot);
      }
      // Solid where it is drawn: the deck, for the bodywork (the wheels ride `terrainAt`, which has it), and
      // the parapets, which a car hits as it would a wall.
      addStaticBox(W, x, y - 0.66, z, hw + 0.6, 0.7, L / 2, GROUP.TERRAIN, rot);
      for (const sd of [-1, 1]) {
        addStaticBox(W, x + uz * (hw + 0.3) * sd, y + 0.5, z - ux * (hw + 0.3) * sd, 0.25, 0.5, L / 2, GROUP.BUILDING, rot);
      }
    }
    // Piers in the water, every 24 m or so.
    const piers = Math.max(1, Math.round(len / 26));
    for (let k = 1; k < piers; k++) {
      const t = k / piers;
      const x = ax + ux * len * t, z = az + uz * len * t, y = lerp(ha, hb, t);
      if (Math.abs(riverSide(x, z)) > WATER_HALF + 4) continue;
      const h = y - 1.3;
      b.addBox(hw * 1.4, h, 2.2, x, h / 2, z, 0x7a7974, rot);
    }
  }
  if (!b.vertexCount) return [];
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  buildingDetail(mesh, 'panel');
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'bridges';
  return [mesh];
}

// =====================================================================
//  The docks
// =====================================================================

function buildDocks(ctx) {
  const { rng } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  const W = ctx.sim.world;
  const solid = (x, y, z, hx, hy, hz, rot = 0, group = GROUP.BUILDING) => addStaticBox(W, x, ctx.at(x, z) + y, z, hx, hy, hz, group, rot);
  const COLOURS = [0xb8432f, 0x2f6aa8, 0x3f8a4a, 0xd9a03a, 0x6b6f75, 0x9b3e7a, 0xc9c6bd, 0x255c5c];
  // Container stacks in rows, back from the water, clear of the roads.
  for (let z = DOCKS.z0 + 20; z < DOCKS.z1 - 10; z += 16) {
    const xq = riverX(z) + WATER_HALF + BANK_RUN + 40;
    for (let x = xq + 10; x < DOCKS.x1 - 20; x += 16) {
      if (rng() < 0.3) continue;
      if (ctx.graph.overlapsRoad(x, z, 14, 4, Math.PI / 2, 3)) continue;
      if (nearBuilding(W, x, z, 7)) continue;
      const stack = randInt(rng, 1, 3);
      const s = b.vertexCount;
      for (let k = 0; k < stack; k++) {
        b.addBox(12.2, 2.6, 2.44, x, 1.3 + k * 2.62, z, COLOURS[randInt(rng, 0, COLOURS.length - 1)]);
      }
      pieces.push([s, b.vertexCount, x, z]);
      solid(x, stack * 1.31, z, 6.1, stack * 1.31, 1.22);
    }
  }
  // Cranes on the bank, their booms out over the water.
  for (let k = 0; k < 3; k++) {
    const z = lerp(DOCKS.z0 + 50, DOCKS.z1 - 50, k / 2);
    const x = riverX(z) + WATER_HALF + BANK_RUN + 14;
    const s = b.vertexCount;
    const H = 34;
    for (const [ox, oz] of [[-6, -7], [6, -7], [-6, 7], [6, 7]]) {
      b.addBox(1.2, H, 1.2, x + ox, H / 2, z + oz, 0xd9a520);
    }
    b.addBox(14, 3, 16, x, H + 1.5, z, 0xd9a520);
    b.addBox(70, 2.2, 3, x - 22, H + 4, z, 0xc99414);          // the boom, out over the river
    b.addBox(6, 5, 8, x + 4, H + 5.5, z, 0x3a3d42);            // the cab and machinery
    pieces.push([s, b.vertexCount, x, z]);
    for (const [ox, oz] of [[-6, -7], [6, -7], [-6, 7], [6, 7]]) solid(x + ox, H / 2, z + oz, 0.6, H / 2, 0.6);
  }
  // Warehouses at the back of the yard.
  for (let k = 0; k < 4; k++) {
    const x = DOCKS.x1 - 30, z = lerp(DOCKS.z0 + 40, DOCKS.z1 - 40, k / 3);
    if (ctx.graph.overlapsRoad(x, z, 40, 30, 0, 3) || nearBuilding(W, x, z, 18)) continue;
    const s = b.vertexCount;
    b.addBox(40, 12, 30, x, 6, z, 0x8c8f93);
    b.addTaperedBox(41, 3, 31, x, 13.5, z, 0x5d6166, 1, 0.2);
    pieces.push([s, b.vertexCount, x, z]);
    solid(x, 6, z, 20, 6, 15);
  }
  if (!b.vertexCount) return [];
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  buildingDetail(mesh, 'panel');
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'docks';
  return [chunkMesh(mesh, 200)];
}

// =====================================================================
//  Buildings
// =====================================================================

/**
 * Buildings along every street, both sides, by district: towers downtown, taller toward its middle ("tower
 * downtown"); blocks of flats round it; houses with lawns and drives in the suburbs and the Heights;
 * warehouses by the docks. Each a solid box, lifted onto the ground under its middle and reaching well
 * down into it, so none floats on a slope.
 */
function buildBuildings(ctx, roundabout) {
  const { rng, graph, sim } = ctx;
  const W = sim.world;
  const towers = new MeshBuilder(), houses = new MeshBuilder();
  const tp = [], hp = [];
  const drives = [];
  const ok = (x, z, w, d, rot, r) => {
    if (graph.overlapsRoad(x, z, w, d, rot, 1.5)) return false;
    if (inChannel(x, z, r + 6) || inDocks(x, z, 10)) return false;
    if (roundabout && Math.hypot(x - roundabout.x, z - roundabout.z) < roundabout.r + r + 10) return false;
    if (Math.hypot(x, z) > RING - 40 - r) return false;
    return !nearBuilding(W, x, z, Math.min(w, d) * 0.45);
  };
  for (const e of graph.edges) {
    if (e.kind === 'motorway' || e.kind === 'ramp' || e.kind === 'country' || e.turningHead || e.bridge) continue;
    if (e.width === 11) continue;
    for (const side of [1, -1]) {
      let s = rand(rng, 3, 9);
      while (s < e.length - 6) {
        const p = pointAlong(e, s);
        const dd = dtDist(p.x, p.z);
        const kind = dd < DT_R ? 'tower' : dd < DT_R + 220 ? 'block' : 'house';
        let w, d, h, gap, back;
        if (kind === 'tower') {
          w = rand(rng, 20, 36); d = rand(rng, 18, 34); gap = rand(rng, 1, 4);
          // Up to 150 m at the middle, stepping down toward the edge of the core.
          h = Math.max(24, lerp(150, 34, dd / DT_R) * rand(rng, 0.5, 1));
          back = 1;
        } else if (kind === 'block') {
          w = rand(rng, 16, 28); d = rand(rng, 14, 22); h = rand(rng, 10, 26); gap = rand(rng, 2, 6); back = 1.5;
        } else {
          w = rand(rng, 9, 12); d = rand(rng, 8, 10.5); h = rand(rng, 6, 8.5); gap = rand(rng, 4, 9); back = 5;
        }
        const setback = e.width * 0.5 + (e.pave || 0) + back + d * 0.5;
        const x = p.x + p.nx * side * setback, z = p.z + p.nz * side * setback;
        const rot = Math.atan2(p.nx * side, p.nz * side);
        const r = Math.hypot(w, d) * 0.5;
        if (!ok(x, z, w, d, rot, r)) { s += 5; continue; }
        const fx = -p.nx * side, fz = -p.nz * side;
        const y0 = ctx.at(x, z);
        if (kind === 'house') {
          const st = houses.vertexCount;
          const colour = new THREE.Color().setHSL(rand(rng, 0.05, 0.14), rand(rng, 0.1, 0.35), rand(rng, 0.55, 0.8));
          houses.addBox(w, h + 3, d, x, h / 2 - 1.5, z, colour, rot);
          houses.addTaperedBox(w * 1.06, h * 0.4, d * 1.08, x, h + h * 0.2, z, rng() < 0.5 ? 0x4a3f3a : 0x37393d, 0.15, 1, rot);
          const face = d * 0.5 + 0.06;
          houses.addBox(1.1, 2.1, 0.12, x + fx * face, 1.05, z + fz * face, 0x3a2a20, rot);
          const ox = Math.cos(rot), oz = -Math.sin(rot);
          for (const sg of [-1, 1]) houses.addBox(w * 0.22, 1.2, 0.1, x + fx * face + ox * sg * w * 0.28, h * 0.55, z + fz * face + oz * sg * w * 0.28, 0x1c2630, rot);
          hp.push([st, houses.vertexCount, x, z]);
          // A car on about one drive in six: at Wexbury's third, 724 of them, 180,000 triangles in view.
          if (hash(Math.round(x), Math.round(z), 31) < 0.5) planDrive(drives, x, z, w, d, rot, fx, fz);
        } else {
          const st = towers.vertexCount;
          const tone = rand(rng, 0.32, 0.64), warm = rand(rng, -0.04, 0.05);
          const col = new THREE.Color(tone + warm, tone, tone - warm * 0.6);
          const glass = new THREE.Color(tone * 0.4, tone * 0.46, tone * 0.58);
          const taper = kind === 'tower' ? 0.94 : 1;
          towers.addTaperedBox(w, h + 3, d, x, h / 2 - 1.5, z, col, taper, taper, rot);
          // Glazed bands up it, a darker plinth, and on the tall ones a crown and plant on the roof.
          const bands = kind === 'tower' ? Math.floor(h / 14) : 1;
          for (let k = 0; k < bands; k++) {
            const by = (k + 0.6) * (h / (bands + 0.2));
            const sh = 1 - (1 - taper) * (by / h);
            towers.addBox(w * sh * 1.01, Math.min(5, h * 0.12), d * sh * 0.9, x, by, z, glass, rot);
          }
          towers.addBox(w * 1.02, 2, d * 1.02, x, 1, z, 0x2a2c30, rot);
          if (kind === 'tower' && h > 70) {
            towers.addBox(w * 0.5, 6, d * 0.5, x, h + 3, z, 0x35383d, rot);
            if (h > 110) towers.addBox(0.6, 18, 0.6, x, h + 15, z, 0x9a9da2, rot);
          }
          tp.push([st, towers.vertexCount, x, z]);
        }
        addStaticBox(W, x, y0 + h / 2 - 1.5, z, w / 2, h / 2 + 1.5, d / 2, GROUP.BUILDING, rot);
        s += w + gap;
      }
    }
  }
  // The drives and their cars (world/drives.js).
  const laid = layDrives(sim, graph, drives, (e) => e.pave || 0, ctx.at);
  ctx.parked = laid.parked;
  ctx.driveStrips = laid.strips;
  const out = [];
  for (const [bld, pieces, style, name] of [[towers, tp, 'panel', 'towers'], [houses, hp, 'brick', 'houses']]) {
    if (!bld.vertexCount) continue;
    const mesh = new THREE.Mesh(bld.build(), vertexColorMaterial());
    liftPieces(mesh, ctx.at, pieces);
    buildingDetail(mesh, style);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    // 300 m cells: at the usual 150 the houses were 100 draw calls in a view.
    out.push(chunkMesh(mesh, 300));
  }
  if (laid.mesh) out.push(laid.mesh);
  return out;
}

/** Position and normal a distance along an edge's polyline. */
function pointAlong(e, s) {
  for (const sg of e.segs) {
    if (s <= sg.start + sg.len || sg === e.segs[e.segs.length - 1]) {
      const t = clamp((s - sg.start) / Math.max(1e-6, sg.len), 0, 1);
      const tx = (sg.b.x - sg.a.x) / Math.max(1e-6, sg.len), tz = (sg.b.z - sg.a.z) / Math.max(1e-6, sg.len);
      return { x: lerp(sg.a.x, sg.b.x, t), z: lerp(sg.a.z, sg.b.z, t), tx, tz, nx: -tz, nz: tx };
    }
  }
  const p = e.points[0];
  return { x: p.x, z: p.z, tx: 1, tz: 0, nx: 0, nz: 1 };
}

// =====================================================================
//  Trees
// =====================================================================

/** Woods past the ring and on the hills, street trees in the suburbs, a line along the river's banks. */
function buildTrees(ctx) {
  const { rng, graph, sim } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  const put = (x, z, scale) => {
    if (Math.abs(x) > WORLD_HALF - 60 || Math.abs(z) > WORLD_HALF - 60) return;
    if (graph.overlapsRoad(x, z, 2.4, 2.4, 0, 2.5)) return;
    if (inChannel(x, z, 2) || inDocks(x, z, 10) || dtDist(x, z) < DT_R - 20) return;
    const h = rand(rng, 7, 14) * scale;
    if (nearBuilding(sim.world, x, z, h * 0.4)) return;
    const crown = new THREE.Color().setHSL(rand(rng, 0.22, 0.31), rand(rng, 0.3, 0.46), rand(rng, 0.13, 0.22));
    const s = b.vertexCount;
    drawTree(b, x, z, h, crown, rand(rng, 0, TAU), 0.3);
    pieces.push([s, b.vertexCount, x, z]);
    const y = ctx.at(x, z);
    addStaticBox(sim.world, x, y + 2.6, z, 0.65, 2.6, 0.65, GROUP.PROP);
    addCanopy(sim.world, x, z, y, h * 0.66, h * 0.72, h * 0.8);
  };
  // Copses beyond the ring, and woods on the hills.
  for (let c = 0; c < 150; c++) {
    const a = rng() * TAU, r = rand(rng, RING + 40, WORLD_HALF * 1.35);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const n = randInt(rng, 5, 16), spread = rand(rng, 14, 46);
    for (let i = 0; i < n; i++) put(cx + rand(rng, -spread, spread), cz + rand(rng, -spread, spread), rand(rng, 0.8, 1.25));
  }
  for (const hl of HILLS) {
    for (let i = 0; i < hl.r * 0.35; i++) {
      const a = rng() * TAU, r = Math.sqrt(rng()) * hl.r * 0.9;
      put(hl.x + Math.cos(a) * r, hl.z + Math.sin(a) * r, rand(rng, 0.9, 1.3));
    }
  }
  // Along the river's banks, above the water.
  for (let z = -RIVER_END + 60; z < RIVER_END - 60; z += 14) {
    if (rng() < 0.45) continue;
    for (const sd of [-1, 1]) {
      const d = WATER_HALF + BANK_RUN + rand(rng, 4, 9);
      const k = riverSlope(z), l = Math.sqrt(1 + k * k);
      put(riverX(z) + sd * d / l, z - sd * d * k / l, rand(rng, 0.85, 1.15));
    }
  }
  // Street trees in the suburbs.
  for (const e of graph.edges) {
    if (e.kind !== 'street' && e.kind !== 'lane') continue;
    const m = e.points[Math.floor(e.points.length / 2)];
    if (dtDist(m.x, m.z) < DT_R + 200) continue;
    for (let s = 12; s < e.length - 12; s += rand(rng, 22, 40)) {
      const p = pointAlong(e, s), side = rng() < 0.5 ? 1 : -1;
      const off = e.width * 0.5 + (e.pave || 0) + 1.2;
      put(p.x + p.nx * off * side, p.z + p.nz * off * side, rand(rng, 0.7, 1.0));
    }
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  treeDetail(mesh);
  mesh.castShadow = true;
  mesh.name = 'trees';
  const low = lowTrees(b);
  if (low) liftPieces(low, ctx.at, b.lowPieces);
  // In 240 m cells, not the usual 120: a 3 km map's trees at 120 were 92 draw calls in a view.
  return chunkTrees(mesh, low, 240);
}
