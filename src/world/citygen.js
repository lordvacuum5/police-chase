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
import { approachesAt, addNodeWedges, sliceLine } from './junctions.js';
import { GROUP, groups, RAPIER, addStaticBox, addCanopy, nearBuilding, EDGE_FACE } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, closestOnSegment, TAU } from '../util/math.js';
import {
  WORLD_HALF, GRID_N, KERB_H, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, makeHeightAt, buildGround, buildRoadMeshes, DRAW_ORDER,
} from './common.js';
import { buildHeightGrid, addHeightfield, buildTerrainMesh, liftMesh, liftPieces } from './terrain.js';
import { planDrive, layDrives } from './drives.js';
import { litWindows } from './windows.js';

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
/**
 * The raised motorway: "the entire motorway should be raised up with like kind of complicated different roads
 * coming off ... one section of it raised up, it should go through downtown ... make sure it's high enough so
 * it doesn't interrupt the camera". The ring stands RAISE m over the ground, the downtown expressway RAISE_DT;
 * nothing that crosses under either may have less than CLEAR m over it.
 */
const RAISE = 10;
const RAISE_DT = 15;
const CLEAR = 5.5;
/**
 * A ramp's rise, 0 at its foot to 1 at its deck, by how far along it is from the foot (0..1): level for its
 * first third -- at grade, where it meets its streets and passes the ones round them -- then easing up.
 */
function rampRise(u) {
  const t = clamp((u - 0.33) / 0.67, 0, 1);
  return t * t * (3 - 2 * t);
}
const raiseAt = (x, z) => lerp(RAISE_DT, RAISE, smooth(DT_R, DT_R + 350, Math.hypot(x - DT.x, z - DT.z)));
/** The expressway's line through downtown: between Fifteenth and Sixteenth Streets. */
const EXPRESS_Z = 47;
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
  // The ground before the roads shape it: what the raised roads' clearances are checked against while laid.
  ctx.base = cityRelief(WORLD_HALF);

  // --- roads ---------------------------------------------------------
  const grid = buildStreets(ctx);
  buildDiagonals(ctx, grid);
  const ring = buildRingMotorway(ctx);
  // The expressway first, its ends on the ring kept from the slip roads: one joined the ring at the same
  // junction, and its barriers ran across the deck -- "some of the ramps onto the highway are blocked".
  buildExpressway(ctx, ring);
  connectRamps(ctx, grid, ring);
  buildCountryRoads(ctx, ring);
  buildCulDeSacs(ctx, grid);
  const roundabout = buildRoundabout(ctx, grid);
  graph.addTurningHeads(15, 10, WORLD_HALF);
  planCarPark(ctx);
  // After the turning heads, which would have put one on each alley's end.
  buildAlleys(ctx);
  // Traffic lights downtown only: at every one of the city's junctions they were 1,595 heads, and with the
  // avenues' junctions too still 927 -- each in four instanced meshes drawn whole every frame, 290,000
  // triangles of a suburban view's 1,000,000.
  graph.signalFilter = (node) => dtDist(node.x, node.z) < DT_R + 60;
  graph.finalise();
  // Every ground road's polyline a point every 6 m: drawn on the hills from one junction to the next as a single
  // straight strip, a street cut a chord under the rise between them -- "some roads almost slightly raised, so
  // you almost drive it on grass, even though you can see the road just below". (Raised roads keep theirs:
  // their decks are drawn from their own long sections.)
  for (const e of graph.edges) {
    if (e.elevated) continue;
    const out = [e.points[0]];
    for (let k = 0; k < e.points.length - 1; k++) {
      const p = e.points[k], q = e.points[k + 1], L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.ceil(L / 6);
      for (let m = 1; m < n; m++) out.push({ x: lerp(p.x, q.x, m / n), z: lerp(p.z, q.z, m / n) });
      out.push(q);
    }
    if (out.length !== e.points.length) graph.setEdgePoints(e, out);
  }
  graph._buildIndex();
  markBridges(ctx);
  nameRoads(graph);

  // --- ground --------------------------------------------------------
  const base = ctx.base;
  // Downtown is level already (cityRelief): a flatten disc round it filled the river in where they met.
  const flatten = [];
  // The docks' yard, level, kept back from the bank so the river is not filled in.
  for (let z = DOCKS.z0 + 40; z < DOCKS.z1; z += 60) {
    const x = riverX(z) + WATER_HALF + BANK_RUN + 70;
    flatten.push({ x, z, r: 60, fade: 30, h: L0 });
  }
  // Nor the ground under a raised road: it is the ground, and the road is up on its deck.
  const skipClaim = (e, x, z) => e.elevated || (e.bridge && inChannel(x, z, 6));
  const hgrid = buildHeightGrid(base, { half: WORLD_HALF, graph, flatten, skipClaim });
  ctx.grid = hgrid;
  // The bridges' decks, level from bank to bank; the height of anything is the deck where there is one.
  // At the bank's level at either end, even an end out over the water.
  const bankY = (x, z) => (inChannel(x, z, -2) ? L0 : hgrid.at(x, z));
  for (const b of ctx.bridges) {
    const p0 = b.e.points[0], p1 = b.e.points[b.e.points.length - 1];
    const y0 = bankY(p0.x, p0.z), y1 = bankY(p1.x, p1.z);
    b.ha = lerp(y0, y1, b.t0); b.hb = lerp(y0, y1, b.t1);
  }
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
  // The raised roads' decks, now the ground is known; and every junction's height, so a car asking for its
  // road is told the one at its own level (RoadGraph.levelOn, nearestNode).
  computeDecks(ctx, hgrid);
  graph.levelGround = at;
  for (const n of graph.nodes) if (n.y === undefined) n.y = at(n.x, n.z);

  // --- surfaces ------------------------------------------------------
  paintPavements(ctx);
  rasteriseRoads(graph, surface);
  // The ground's own grip grid, for shaping the ground drawn (buildTerrain); then the strips under the raised
  // roads marked road too, so the AI's "is that car on a road" -- asked of the ground under it -- is right for a
  // car up on the motorway. A wheel on a deck is told road by the deck (Vehicle, `sim.decks`).
  ctx.groundSurfAt = makeSurfaceAt(surface.slice());
  for (const e of graph.edges) {
    if (!e.elevated) continue;
    for (const sg of e.segs) {
      const steps = Math.max(1, Math.ceil(sg.len / 3));
      for (let k = 0; k <= steps; k++) paintDisc(surface, lerp(sg.a.x, sg.b.x, k / steps), lerp(sg.a.z, sg.b.z, k / steps), e.width * 0.5, SURF_ROAD);
    }
  }
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
  // All in cells: one mesh each, the roads were 58,000 triangles drawn wherever you looked.
  meshes.push(chunkMesh(lifted[0], 300), chunkMesh(lifted[1], 300), chunkMesh(lifted[2], 300));
  if (wear) {
    liftMesh(wear, at, 0.06);
    wear.material.polygonOffsetFactor = -4;
    wear.material.polygonOffsetUnits = -8;
    meshes.push(wear.geometry.index ? wear : chunkMesh(wear, 300));
  }
  meshes.push(buildPavements(ctx));
  meshes.push(...buildBridges(ctx));
  meshes.push(...buildDecks(ctx));
  meshes.push(...buildCarPark(ctx));
  meshes.push(...buildAlleyClutter(ctx));
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
    // Under a bridge too: asked whether a deck was below the car, a car in the water under one was dry.
    inWater: (x, z, y) => y < WATER + 0.4 && riverOn(z) > 0.3 && Math.abs(riverSide(x, z)) < WATER_HALF + BANK_RUN * 0.6,
    water: WATER,
    clearAt: (x, z) => inChannel(x, z, 2),
    // The raised roads' deck colliders: a wheel on one is on road (Vehicle).
    decks: ctx.decks,
    trafficCount: 28,
    // What is hidden past the fog (Game._fogCull): the map's cells of static meshes, by name.
    fogCull: ['roads', 'markings', 'towers', 'houses', 'kerbs', 'pavements', 'trees', 'decks', 'deck-markings', 'deck-edges', 'deck-slabs',
      'deck-barriers', 'deck-piers', 'docks', 'bridges', 'road-wear', 'driveways', 'verges', 'parked', 'carpark'],
    update: (game, dt) => { water.userData.update(dt || 1 / 60); if (ctx.binsUpdate) ctx.binsUpdate(); },
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
  // Not through the water on the way: two junctions on one bank with the river bending between them put nine
  // streets into it -- "some roads go into the water".
  const wetOn = (p, q) => {
    const L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.max(1, Math.ceil(L / 4));
    for (let m = 0; m <= n; m++) if (inChannel(lerp(p.x, q.x, m / n), lerp(p.z, q.z, m / n), (ROAD_KIND[kind] ? ROAD_KIND[kind].width : 15) * 0.5 + 3)) return true;
    return false;
  };
  if (cross < 0) {
    for (let k = 0; k < line.length - 1; k++) if (wetOn(line[k], line[k + 1])) return null;
    return graph.addEdge(a, b, kind, pts.length ? pts : null, opts);
  }
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
  // Raised all the way round, over the river too: no river split, and no junction with anything it passes
  // over (`bridge`: graph.finalise does not stitch it to what it crosses).
  for (const n of ring) n.elevated = true;
  for (let i = 0; i < ring.length; i++) {
    const e = graph.addEdge(ring[i], ring[(i + 1) % ring.length], 'motorway', null, { bridge: true });
    if (e) e.elevated = true;
  }
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
  // Not from a ground road under the ring itself: one slip road's foot stood directly beneath the deck.
  if (distToRing(anchor.x, anchor.z) < half + 25) return null;
  const candidates = ring.map((n, i) => ({ i, d: dist2(n.x, n.z, aim.x, aim.z) })).sort((p, q) => p.d - q.d);
  for (const cand of candidates) {
    const idx = cand.i;
    const N = ring[idx];
    if (junctions.some((j) => dist2(N.x, N.z, j.node.x, j.node.z) < 260)) continue;
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
    // Up from the ground at the anchor to the ring's deck at N, clear of every road it passes over.
    if (!rampClear(ctx, full, ctx.base(anchor.x, anchor.z), ctx.base(N.x, N.z) + raiseAt(N.x, N.z))) continue;
    const ramp = graph.addEdge(anchor, N, 'ramp', [...approach, taper[0], taper[1], taper[2]], { bridge: true });
    if (ramp) ramp.elevated = true;
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
    if (e.elevated) continue;
    const pts = e.points;
    let over = false;
    for (let k = 0; k < pts.length - 1 && !over; k++) {
      if (riverOn(pts[k].z) > 0.2 && Math.sign(riverSide(pts[k].x, pts[k].z)) !== Math.sign(riverSide(pts[k + 1].x, pts[k + 1].z))) over = true;
    }
    // Or one that only reaches into the water: nine bridges had one end out in the river, and the half from the
    // bank to it was laid as a street -- a dam across half the river, "some roads go into the water".
    if (!over) over = pts.some((p) => inChannel(p.x, p.z, -2));
    e.bridge = over;
    if (!over) continue;
    // The deck in pieces, one a segment of the road's own (6 m) polyline, over the channel and a little beyond
    // it: a curved bridge follows its road, where one straight deck end to end left the road running off it.
    // Heights along it by distance, bank level to bank level (set once the ground is known: `t` here).
    const hw = e.width * 0.5 + 0.6;
    let acc = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (len > 1e-3 && inChannel(mx, mz, 12)) {
        ctx.bridges.push({
          e, ax: a.x, az: a.z, bx: b.x, bz: b.z, len, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, hw,
          t0: acc / e.length, t1: (acc + len) / e.length, pier: k % 4 === 0,
          minX: Math.min(a.x, b.x) - hw - 2, maxX: Math.max(a.x, b.x) + hw + 2,
          minZ: Math.min(a.z, b.z) - hw - 2, maxZ: Math.max(a.z, b.z) + hw + 2,
        });
      }
      acc += len;
    }
  }
}

/** The ground-level roads laid so far, as segments: what a raised road must clear. */
function groundSegs(ctx) {
  const out = [];
  for (const e of ctx.graph.edges) {
    if (e.elevated || e.dead) continue;
    const pts = e.points;
    for (let k = 0; k < pts.length - 1; k++) out.push({ a: pts[k], b: pts[k + 1], half: e.width * 0.5 });
  }
  return out;
}

/**
 * A ramp along `pts` from height `y0` at its first point to `y1` at its last: does it clear every ground road
 * it passes over by CLEAR, leaving out the stretch at its foot that meets its own street? And is it no
 * steeper than 9%?
 */
function rampClear(ctx, pts, y0, y1) {
  let L = 0;
  const S = [0];
  for (let k = 1; k < pts.length; k++) { L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z); S.push(L); }
  if (Math.abs(y1 - y0) > L * 0.67 * 0.09) return false;
  const foot = y0 < y1 ? 0 : L;
  // Not the streets that meet at its foot: it joins them there, it does not pass over them.
  const fp = foot === 0 ? pts[0] : pts[pts.length - 1];
  const segs = groundSegs(ctx).filter((sg) => Math.hypot(sg.a.x - fp.x, sg.a.z - fp.z) > 1 && Math.hypot(sg.b.x - fp.x, sg.b.z - fp.z) > 1);
  for (let k = 0; k < pts.length - 1; k++) {
    const len = S[k + 1] - S[k], n = Math.max(1, Math.ceil(len / 4));
    for (let m = 0; m <= n; m++) {
      const s = S[k] + len * m / n;
      if (Math.abs(s - foot) < 30) continue;
      const x = lerp(pts[k].x, pts[k + 1].x, m / n), z = lerp(pts[k].z, pts[k + 1].z, m / n);
      const y = y0 < y1 ? lerp(y0, y1, rampRise(s / L)) : lerp(y1, y0, rampRise(1 - s / L));
      for (const sg of segs) {
        if (closestOnSegment(x, z, sg.a.x, sg.a.z, sg.b.x, sg.b.z).dist > sg.half + 5.5) continue;
        // At grade (still on the ground) is a road meeting a road; over it is a bridge. In between is a wall.
        const up = y - ctx.base(x, z);
        if (up > 0.8 && up < CLEAR) return false;
      }
    }
  }
  return true;
}

/**
 * The downtown expressway: off the ring on the west, raised RAISE_DT m through the middle of downtown and over
 * the river, back onto the ring on the east. Junctions every 150 m or so, and from some of them ramps down
 * into the streets -- "complicated different roads coming off".
 */
function buildExpressway(ctx, ring) {
  const { graph } = ctx;
  const ringAt = (x, z) => {
    let best = null, bd = Infinity;
    for (const n of ring) { const d = dist2(n.x, n.z, x, z); if (d < bd) { bd = d; best = n; } }
    return best;
  };
  const W = ringAt(-RING, EXPRESS_Z), E = ringAt(RING, EXPRESS_Z);
  ctx.junctions.push({ node: W }, { node: E });
  const nodes = [W];
  for (let x = W.x + 170; x < E.x - 120; x += 150) {
    // Easing onto the expressway's line from where it leaves the ring.
    const z = x < 0 ? lerp(W.z, EXPRESS_Z, smooth(W.x, W.x + 420, x)) : lerp(E.z, EXPRESS_Z, smooth(E.x, E.x - 420, x));
    const n = graph.addNode(x, z, 'express');
    n.elevated = true;
    nodes.push(n);
  }
  nodes.push(E);
  ctx.express = [];
  for (let k = 0; k < nodes.length - 1; k++) {
    const e = graph.addEdge(nodes[k], nodes[k + 1], 'dual', null, { bridge: true });
    if (e) { e.elevated = true; e.express = true; ctx.express.push(e); }
  }
  // Ramps down: from every other expressway junction, leaving along it, to a street junction 190-420 m off.
  const cands = graph.nodes.filter((n) => n.type === 'cross' && !n.elevated);
  let made = 0;
  // From any junction along it (not every other, as first), a ramp's top at least 250 m from another's: the
  // rule that keeps a ramp from hugging the expressway turned some junctions down, and the -980 one with them.
  const tops = [];
  for (let k = 1; k < nodes.length - 1 && made < 8; k++) {
    const A = nodes[k];
    if (tops.some((t) => Math.hypot(t.x - A.x, t.z - A.z) < 250)) continue;
    for (const dirSign of [1, -1]) {
      const to = dirSign > 0 ? nodes[k + 1] : nodes[k - 1];
      let dx = to.x - A.x, dz = to.z - A.z;
      const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
      let best = null, bl = Infinity;
      for (const G of cands) {
        const gx = G.x - A.x, gz = G.z - A.z, gl = Math.hypot(gx, gz);
        if (gl < 190 || gl > 420 || gl > bl) continue;
        const ahead = gx * dx + gz * dz;
        if (ahead < gl * 0.6) continue;                        // the way it is going, not back
        const side = -gx * dz + gz * dx;
        if (Math.abs(side) < gl * 0.3) continue;               // well off to one side, not under it
        // Leaving along the expressway, then curving away down to the street: the control point near the
        // junction (a fifth of the way), so it parts from the expressway quickly.
        const c1 = { x: A.x + dx * gl * 0.2, z: A.z + dz * gl * 0.2 };
        const pts = [];
        for (let m = 0; m <= 10; m++) {
          const u = m / 10, iu = 1 - u;
          pts.push({ x: iu * iu * A.x + 2 * iu * u * c1.x + u * u * G.x, z: iu * iu * A.z + 2 * iu * u * c1.z + u * u * G.z });
        }
        if (pts.some((q) => inChannel(q.x, q.z, 10))) continue;
        // Clear of the expressway's own deck within 70 m, and staying clear: the one at -980 hugged it, its
        // centre 2.5 m from the expressway's, and dropped away underneath it -- a car meant for it stayed up
        // on the expressway, and the ramp was undriveable.
        let hugs = false, run = 0;
        for (let m = 1; m < pts.length && !hugs; m++) {
          const segL = Math.hypot(pts[m].x - pts[m - 1].x, pts[m].z - pts[m - 1].z), steps = Math.ceil(segL / 4);
          for (let k = 1; k <= steps; k++) {
            run += segL / steps;
            if (run < 70) continue;
            const x = lerp(pts[m - 1].x, pts[m].x, k / steps), z = lerp(pts[m - 1].z, pts[m].z, k / steps);
            let near = Infinity;
            for (let q = 0; q < nodes.length - 1; q++) near = Math.min(near, closestOnSegment(x, z, nodes[q].x, nodes[q].z, nodes[q + 1].x, nodes[q + 1].z).dist);
            if (near < ROAD_KIND.dual.width * 0.5 + ROAD_KIND.ramp.width * 0.5 + 2) { hugs = true; break; }
          }
        }
        if (hugs) continue;
        const top = ctx.base(A.x, A.z) + raiseAt(A.x, A.z);
        if (!rampClear(ctx, pts, top, ctx.base(G.x, G.z))) continue;
        bl = gl; best = { G, pts };
      }
      if (!best) continue;
      const e = graph.addEdge(A, best.G, 'ramp', best.pts.slice(1, -1), { bridge: true });
      if (e) { e.elevated = true; made++; if (!tops.includes(A)) tops.push(A); }
    }
  }
  ctx.expressRamps = made;
  if (typeof window !== 'undefined') window.__cityRamps = { express: made };
}

/**
 * Every raised road's deck height along it, now the ground is known: for the ring and the expressway the
 * ground (the plain's level over the river) averaged over 100 m plus their raise, held to their junctions'
 * heights at the ends and to 6% between; for a ramp, from its street's level up to the deck it joins, eased
 * at both ends, and never under the ground.
 */
function computeDecks(ctx, hgrid) {
  const { graph } = ctx;
  const ground = (x, z) => (inChannel(x, z, 0) ? L0 : hgrid.at(x, z));
  const smoothGround = (x, z) => {
    let s = 0, c = 0;
    for (const r of [0, 25, 50]) for (let a = 0; a < 6; a++) { s += ground(x + Math.cos(a) * r, z + Math.sin(a) * r); c++; }
    return s / c;
  };
  for (const n of graph.nodes) if (n.elevated) n.y = smoothGround(n.x, n.z) + raiseAt(n.x, n.z);
  const levelOf = (n) => (n.elevated ? n.y : hgrid.at(n.x, n.z));
  /**
   * How far from node `n` edge `e` still overlaps another raised road leaving `n`: for that far it is held
   * level with the junction. Climbing from the junction straight away, the expressway's deck rose out of the
   * ring's like a low ceiling over its lanes, and a ramp dropping away under the bigger road's deck ran into
   * its edge: "FELL" at the ring, and 0.53 damage the other way, driving the expressway end to end.
   */
  const distTo = (pts, x, z) => {
    let best = Infinity;
    for (let k = 0; k < pts.length - 1; k++) best = Math.min(best, closestOnSegment(x, z, pts[k].x, pts[k].z, pts[k + 1].x, pts[k + 1].z).dist);
    return best;
  };
  const holdAt = (e, n, atA) => {
    let hold = 0;
    for (const ap of approachesAt(graph, n)) {
      if (ap.edge === e || !ap.edge.elevated) continue;
      const need = e.width * 0.5 + ap.edge.width * 0.5 + 1.5;
      for (let d = 0; d <= Math.min(200, e.length * 0.45); d += 2) {
        const p = pointAlong(e, atA ? d : e.length - d);
        // And 25 m on past where they part: a car straddling the nose meets two level decks, not one
        // dropping away from the other (0.38 damage at 7 m/s, driven down the expressway past a ramp).
        if (distTo(ap.edge.points, p.x, p.z) > need) { hold = Math.max(hold, d + 25); break; }
        if (d + 2 > Math.min(200, e.length * 0.45)) hold = Math.max(hold, d);
      }
    }
    return hold;
  };
  // The bigger roads first, then the ramps, which while they overlap one follow its deck.
  const order = graph.edges.filter((e) => e.elevated).sort((a, b) => (a.kind === 'ramp') - (b.kind === 'ramp'));
  for (const e of order) {
    const holdA = graph.nodes[e.a].elevated ? holdAt(e, graph.nodes[e.a], true) : 0;
    const holdB = graph.nodes[e.b].elevated ? holdAt(e, graph.nodes[e.b], false) : 0;
    const S = [], P = [];
    for (const sg of e.segs) {
      const steps = Math.max(1, Math.ceil(sg.len / 5));
      for (let k = 0; k < steps; k++) { S.push(sg.start + sg.len * k / steps); P.push({ x: lerp(sg.a.x, sg.b.x, k / steps), z: lerp(sg.a.z, sg.b.z, k / steps) }); }
    }
    S.push(e.length); P.push(e.points[e.points.length - 1]);
    const ya = levelOf(graph.nodes[e.a]), yb = levelOf(graph.nodes[e.b]);
    const L = e.length;
    const Y = new Array(S.length);
    if (e.kind === 'ramp') {
      // Over the stretch between the holds, from whichever end is on the ground (rampRise).
      // While it still overlaps the bigger road at its top, at that road's own height there, not the junction's:
      // held at the junction's while the expressway sloped away beside it, its slab's edge stood 0.6 m up in
      // the expressway's lanes (0.38 damage at 7 m/s, driven down it).
      // The one it leaves alongside: the bigger road's piece pointing most nearly the way the ramp goes (the first
      // one found could be the piece going the other way, and the ramp followed a deck it was nowhere near).
      const mainAt = (n) => {
        if (!n.elevated) return null;
        const aps = approachesAt(graph, n);
        const mine = aps.find((ap) => ap.edge === e);
        let best = null, bd = -2;
        for (const ap of aps) {
          if (ap.edge === e || !ap.edge.elevated || ap.edge.kind === 'ramp' || !ap.edge.deck) continue;
          const dot = mine ? ap.dir.x * mine.dir.x + ap.dir.z * mine.dir.z : 0;
          if (dot > bd) { bd = dot; best = ap.edge; }
        }
        return best;
      };
      const mainA = mainAt(graph.nodes[e.a]), mainB = mainAt(graph.nodes[e.b]);
      const s0 = holdA, s1 = Math.max(s0 + 1, L - holdB);
      // 4 cm under it, so where the two overlap its surface never stands proud of the bigger road's.
      const yTop = (k, main) => graph.levelOn(main, P[k].x, P[k].z) - 0.04;
      const ea = mainA ? yTop(Math.min(S.length - 1, S.findIndex((v) => v >= s0) < 0 ? 0 : S.findIndex((v) => v >= s0)), mainA) : ya;
      const lastIn = (() => { let k = S.length - 1; while (k > 0 && S[k] > s1) k--; return k; })();
      const eb = mainB ? yTop(lastIn, mainB) : yb;
      for (let k = 0; k < S.length; k++) {
        if (S[k] <= s0 && mainA) { Y[k] = yTop(k, mainA); continue; }
        if (S[k] >= s1 && mainB) { Y[k] = yTop(k, mainB); continue; }
        const u = clamp((S[k] - s0) / (s1 - s0), 0, 1);
        const y = ea < eb ? lerp(ea, eb, rampRise(u)) : lerp(eb, ea, rampRise(1 - u));
        Y[k] = Math.max(y, ground(P[k].x, P[k].z) + 0.05);
      }
    } else {
      for (let k = 0; k < S.length; k++) {
        const mid = smoothGround(P[k].x, P[k].z) + raiseAt(P[k].x, P[k].z);
        const pin = 1 - smooth(0, 60, Math.min(S[k], L - S[k]));
        Y[k] = lerp(mid, lerp(ya, yb, S[k] / L), pin);
      }
      const held = (k) => S[k] <= holdA || S[k] >= L - holdB;
      for (let k = 0; k < S.length; k++) if (held(k)) Y[k] = S[k] <= holdA ? ya : yb;
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 1; k < S.length; k++) if (!held(k)) Y[k] = clamp(Y[k], Y[k - 1] - (S[k] - S[k - 1]) * 0.06, Y[k - 1] + (S[k] - S[k - 1]) * 0.06);
        for (let k = S.length - 2; k >= 0; k--) if (!held(k)) Y[k] = clamp(Y[k], Y[k + 1] - (S[k + 1] - S[k]) * 0.06, Y[k + 1] + (S[k + 1] - S[k]) * 0.06);
      }
    }
    Y[0] = ya; Y[S.length - 1] = yb;
    e.deck = { s: S, y: Y };
  }
}

/**
 * The raised roads drawn and made solid: a deck with its markings, its slab's edge and underside, a crash
 * barrier each side (open where roads join), piers down to the ground where there is no road under them.
 * The deck's surface is a collider the wheels ride (a group the AI's sweeps and sight lines do not see), and
 * noted in `ctx.decks` so a wheel on it is on road; the barriers and piers are walls.
 */
function buildDecks(ctx) {
  const { graph } = ctx;
  const W = ctx.sim.world;
  const top = new MeshBuilder(), paint = new MeshBuilder(), under = new MeshBuilder(), piers = new MeshBuilder();
  const barrier = new MeshBuilder(), kerb = new MeshBuilder();
  const DECK = 0x2a2d31, SLAB = 0xb4b2ab, BAR = 0xc9c7c0, EDGE = 0xa9a7a0;
  const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; };
  const opened = new Map();
  // Which side of `e` (+1 the offset side) the other road `o` is on, leaving their junction: from where `o`
  // actually is a little way along, not the two directions at the junction itself -- at a shallow split those
  // are nearly parallel, and the answer came out backwards often enough to put a barrier in the lane.
  const sideOf = (ee, atA, o, odir, edir) => {
    const d = Math.min(30, ee.length * 0.3);
    const p = pointAlong(ee, atA ? d : ee.length - d);
    let best = Infinity, cx = 0, cz = 0;
    for (let k = 0; k < o.points.length - 1; k++) {
      const r = closestOnSegment(p.x, p.z, o.points[k].x, o.points[k].z, o.points[k + 1].x, o.points[k + 1].z);
      if (r.dist < best) { best = r.dist; cx = o.points[k].x + (o.points[k + 1].x - o.points[k].x) * r.t; cz = o.points[k].z + (o.points[k + 1].z - o.points[k].z) * r.t; }
    }
    const s = (cx - p.x) * -p.tz + (cz - p.z) * p.tx;
    if (Math.abs(s) > 0.5) return s > 0 ? 1 : -1;
    return odir.x * -edir.z + odir.z * edir.x >= 0 ? 1 : -1;
  };
  const deckRGB = new THREE.Color(DECK).toArray();
  const lift = (b, from, fn) => {
    for (let k = from; k < b.pos.length / 3; k++) b.pos[k * 3 + 1] += fn(b.pos[k * 3], b.pos[k * 3 + 2]);
  };
  ctx.decks = new Set();
  const colliderFrom = (b, from, group) => {
    const n = b.pos.length / 3 - from;
    if (n < 3) return null;
    const v = new Float32Array(b.pos.slice(from * 3));
    const idx = new Uint32Array(n);
    for (let k = 0; k < n; k++) idx[k] = k;
    // FIX_INTERNAL_EDGES: a body sliding over a mesh of separate triangles catches on the edges between them
    // ("ghost" contacts) -- 0.36 damage at 27 m/s on a flat stretch of the expressway.
    const desc = (group === GROUP.RAMP ? RAPIER.ColliderDesc.trimesh(v, idx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES) : RAPIER.ColliderDesc.trimesh(v, idx))
      .setCollisionGroups(groups(group, 0xFFFF));
    // The crash barriers nearly frictionless, whatever touches them: "I want it so there's not much friction,
    // so you can kind of scrape along the crash barrier."
    if (group === GROUP.BUILDING) desc.setFriction(0.02).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    else desc.setFriction(0.9);
    return W.createCollider(desc);
  };
  const busy = (n) => n.edges.length >= 3;
  for (const e of graph.edges) {
    if (!e.elevated) continue;
    const half = e.width * 0.5;
    const yOf = (x, z) => graph.levelOn(e, x, z);
    // The deck's surface, and its collider.
    let s0 = top.vertexCount;
    top.addRibbon(e.points, e.width + 1.2, 0, DECK);
    lift(top, s0, yOf);
    const c = colliderFrom(top, s0, GROUP.RAMP);
    if (c) ctx.decks.add(c.handle);
    // The slab's underside.
    s0 = under.vertexCount;
    under.addRibbon(e.points, e.width + 1.2, -1.4, SLAB);
    lift(under, s0, yOf);
    // Barriers, both sides, all the way -- open only on the side another raised road leaves from, for as far
    // as the two run side by side; and on a ramp, not down where it is still on the ground. They used to stop
    // 40 m short of every junction with a third road, both sides, which on the expressway and the ring was an
    // 80 m stretch of open edge at every slip road.
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    const n0 = e.points[0], n1 = e.points[Math.min(1, e.points.length - 1)];
    const m0 = e.points[e.points.length - 2] || n0, m1 = e.points[e.points.length - 1];
    const dirA = norm(n1.x - n0.x, n1.z - n0.z), dirB = norm(m1.x - m0.x, m1.z - m0.z);
    // How far each side's barrier stays open at a node: as far as another raised road leaving it there still
    // overlaps this one -- their centrelines nearer than their half widths and a margin. On that road's side;
    // and on a ramp leaving a bigger road, both sides, since for that stretch it runs on top of the bigger road's
    // deck. "Fell" the first time it was driven end to end: a ramp's barrier began at its junction, standing in
    // the expressway's lanes, and a car at 105 km/h hit it and went over the side where the expressway's own
    // barrier was open.
    const distTo = (pts, x, z) => {
      let best = Infinity;
      for (let k = 0; k < pts.length - 1; k++) best = Math.min(best, closestOnSegment(x, z, pts[k].x, pts[k].z, pts[k + 1].x, pts[k + 1].z).dist);
      return best;
    };
    const openAt = (n, atA, dir) => {
      const out = new Map();
      for (const ap of approachesAt(graph, n)) {
        if (ap.edge === e || !ap.edge.elevated) continue;
        // Until the two decks' edges (each half + 0.6) stop touching, with 0.2 m to spare: no gap between them.
        const need = half + ap.edge.width * 0.5 + 1.0;
        let sep = 0;
        for (let d = 0; d <= Math.min(260, e.length); d += 2) {
          const p = pointAlong(e, atA ? d : e.length - d);
          sep = d;
          if (distTo(ap.edge.points, p.x, p.z) > need) break;
        }
        const side = sideOf(e, atA, ap.edge, ap.dir, dir);
        out.set(side, Math.max(out.get(side) || 0, sep));
        // A ramp's far side, only while the ramp is still on top of the bigger road's deck (its far edge inside
        // the other's): open for the whole run alongside, "sometimes on the highway there's no crash barrier".
        if (e.kind === 'ramp' && ap.edge.kind !== 'ramp') {
          const inside = ap.edge.width * 0.5 - half + 1;
          let far = 0;
          if (inside > 0) {
            for (let d = 0; d <= Math.min(260, e.length); d += 2) {
              const p = pointAlong(e, atA ? d : e.length - d);
              far = d;
              if (distTo(ap.edge.points, p.x, p.z) > inside) break;
            }
            far += 4;
          }
          out.set(-side, Math.max(out.get(-side) || 0, far));
        }
      }
      return out;
    };
    const openA = openAt(a, true, dirA), openB = openAt(b, false, dirB);
    for (const [sd, d] of openA) opened.set(`${e.id}:${a.id}:${sd}`, d);
    for (const [sd, d] of openB) opened.set(`${e.id}:${b.id}:${sd}`, d);
    // A pale concrete edge strip each side under the barrier, and the slab's edge down 1.4 m -- each side only
    // where its barrier is: where a ramp still runs with the motorway, both used to be drawn across the
    // motorway's own deck, and the ramp looked to begin before it came off ("the road should start where it
    // comes off, not like before it starts coming off").
    for (const sg of [1, -1]) {
      const side = sliceLine(e.points, openA.get(sg) || 0, e.length - (openB.get(sg) || 0));
      if (!side || side.length < 2) continue;
      s0 = kerb.vertexCount;
      kerb.addRibbon(side, 1.0, 0.1, EDGE, sg * (half + 0.1));
      lift(kerb, s0, yOf);
      s0 = under.vertexCount;
      under.addWall(side, -1.4, 0.1, SLAB, sg * (half + 0.6));
      lift(under, s0, yOf);
    }
    // Markings: a white line along each edge of every raised road, and its lanes dashed. "You can almost see
    // the road, but it has no like edges on it": the deck was a dark sheet as dark as the streets under it,
    // with nothing to say where it stopped.
    // Each stops where the barrier on its side opens, and the lanes where either does: across a junction's
    // mouth they ran on over the other road's deck.
    s0 = paint.vertexCount;
    for (const sg of [1, -1]) {
      const ln = sliceLine(e.points, openA.get(sg) || 0, e.length - (openB.get(sg) || 0));
      if (ln && ln.length > 1) paint.addRibbon(ln, 0.22, 0.04, PALETTE.marking, sg * (half - 0.5));
    }
    // The lanes stop only where this road ends into another -- open both sides, as the expressway at the ring
    // -- and carry on past a slip road joining one side (they stopped there too, for the length of the merge).
    const mid = sliceLine(e.points, Math.min(openA.get(1) || 0, openA.get(-1) || 0), e.length - Math.min(openB.get(1) || 0, openB.get(-1) || 0));
    if (mid && mid.length > 1) {
      if (e.kind === 'motorway') for (const off of [e.width / 6, -e.width / 6]) paint.addDashedRibbon(mid, 0.28, 0.04, PALETTE.marking, 6, 9, off);
      else if (e.kind === 'dual') paint.addDashedRibbon(mid, 0.28, 0.04, PALETTE.marking, 6, 9, 0);
    }
    lift(paint, s0, yOf);
    // How far along it is still within 0.8 m of the ground (a ramp's foot): no barrier there.
    let lowFrom = 0, lowTo = e.length;
    if (e.kind === 'ramp') {
      const footAtA = !a.elevated;
      const S = e.deck.s, Y = e.deck.y;
      for (let k = 0; k < S.length; k++) {
        const pk = pointAlong(e, S[k]);
        if (Y[k] - ctx.at(pk.x, pk.z) < 0.8) { if (footAtA) lowFrom = S[k]; else { lowTo = Math.min(lowTo, S[k]); break; } }
      }
    }
    for (const sg of [1, -1]) {
      const from = Math.max(lowFrom, openA.get(sg) || 0);
      const to = Math.min(lowTo, e.length - (openB.get(sg) || 0));
      if (to - from < 4) continue;
      const line = sliceLine(e.points, from, to);
      if (!line || line.length < 2) continue;
      s0 = barrier.vertexCount;
      const off = sg * (half + 0.3);
      barrier.addWall(line, 0, 1.05, BAR, off);
      barrier.addWall(line, 0, 1.05, BAR, off + sg * 0.4);
      barrier.addRibbon(line, 0.4, 1.05, BAR, off + sg * 0.2);
      lift(barrier, s0, yOf);
      colliderFrom(barrier, s0, GROUP.BUILDING);
    }
    // Piers every 30 m where the deck is well up: two columns under its edges and a beam across them, each
    // column only where no road runs under it (paving and the river will do). They were a single block as wide
    // as the road, standing on the pavement, and its top was level with the slab's underside, which flickered.
    for (let sAlong = 15; sAlong < e.length - 10; sAlong += 30) {
      const p = pointAlong(e, sAlong);
      const yd = yOf(p.x, p.z);
      const rot = Math.atan2(p.tx, p.tz);
      const legs = [];
      for (const sg of [1, -1]) {
        const lx = p.x + p.nx * sg * (half - 2.2), lz = p.z + p.nz * sg * (half - 2.2);
        const yg = ctx.at(lx, lz);
        if (yd - yg < 3.5) continue;
        let clear = ctx.groundSurfAt(lx, lz) !== SURF_ROAD;
        // "Make sure the pillars are not too much in the way of the road": 3 m clear of any road's edge.
        for (let a8 = 0; a8 < 8; a8++) for (const r of [1.5, 3, 3.8]) if (ctx.groundSurfAt(lx + Math.cos(a8 * 0.785) * r, lz + Math.sin(a8 * 0.785) * r) === SURF_ROAD) clear = false;
        if (clear && !nearBuilding(W, lx, lz, 1.2)) legs.push({ lx, lz, yg });
      }
      if (!legs.length) continue;
      for (const { lx, lz, yg } of legs) {
        const h = yd - 2.45 - yg + 1.0;
        piers.addBox(1.5, h, 1.5, lx, yg - 1.0 + h / 2, lz, SLAB, rot);
        addStaticBox(W, lx, yg - 1.0 + h / 2, lz, 0.75, h / 2, 0.75, GROUP.BUILDING, rot);
      }
      // The beam: its top 5 cm under the slab's underside.
      piers.addBox(e.width + 0.6, 1.0, 1.8, p.x, yd - 1.45 - 0.05 - 0.5, p.z, SLAB, rot);
    }
  }
  // The corners of every junction up on the raised roads: the deck filled in between each pair of roads
  // meeting there, out to where their barriers start, and a barrier round the outside -- at a T, the corner
  // you turn across; where a ramp splits off, its nose. Without them a car turning off the ring onto the
  // expressway, a little wide, went over the open corner: the first end-to-end drive "fell" 34 m in.
  const lineHit = (p, d, q, f) => {
    const den = d.x * f.z - d.z * f.x;
    if (Math.abs(den) < 1e-3) return null;
    const t = ((q.x - p.x) * f.z - (q.z - p.z) * f.x) / den;
    return { x: p.x + d.x * t, z: p.z + d.z * t };
  };
  for (const n of graph.nodes) {
    if (!n.elevated) continue;
    const app = approachesAt(graph, n).filter((ap) => ap.edge.elevated);
    if (app.length < 2) continue;
    for (let i = 0; i < app.length; i++) {
      const A = app[i], B = app[(i + 1) % app.length];
      if (app.length === 2 && i === 1) break;
      let th = B.ang - A.ang;
      if (th <= 0) th += Math.PI * 2;
      if (th > 2.7) continue;                       // a road carrying on through: nothing to close
      // Each road's edge on the side facing the other, and how far along its barrier opens.
      const sideTo = (ap, other) => {
        const e = ap.edge, atA = ap.end === 'a';
        const pts = e.points;
        const q0 = atA ? pts[0] : pts[pts.length - 2], q1 = atA ? pts[1] : pts[pts.length - 1];
        const dir = norm(q1.x - q0.x, q1.z - q0.z);
        const sd = sideOf(e, atA, other.edge, other.dir, dir);
        const d = opened.get(`${e.id}:${n.id}:${sd}`) || 0;
        const p = pointAlong(e, atA ? d : e.length - d);
        // The offset side's normal, from the edge's own a-to-b direction (as addRibbon's offsets go).
        const nx = -p.tz * sd, nz = p.tx * sd;
        return { e, d, p, nx, nz, half: e.width * 0.5 };
      };
      const a = sideTo(A, B), b = sideTo(B, A);
      if (!a.d && !b.d) continue;
      // Where a ramp splits off at a shallow angle the two decks run together until they part; there, a short
      // barrier across the V between their barriers' ends: its nose. A corner filled in there instead reached a
      // hundred metres out along both and let a car off the side of it (the drive down the ramp at -980 ended on
      // the street under it).
      if (th < 0.6) {
        const bA = { x: a.p.x + a.nx * (a.half + 0.3), z: a.p.z + a.nz * (a.half + 0.3) };
        const bB = { x: b.p.x + b.nx * (b.half + 0.3), z: b.p.z + b.nz * (b.half + 0.3) };
        if (Math.hypot(bA.x - bB.x, bA.z - bB.z) < 6) {
          const yA = graph.levelOn(a.e, bA.x, bA.z), yB = graph.levelOn(b.e, bB.x, bB.z);
          const b0 = barrier.vertexCount;
          const line = [bA, bB];
          barrier.addWall(line, 0, 1.05, BAR, 0.2);
          barrier.addWall(line, 0, 1.05, BAR, -0.2);
          barrier.addRibbon(line, 0.4, 1.05, BAR, 0);
          for (let k = b0; k < barrier.pos.length / 3; k++) barrier.pos[k * 3 + 1] += Math.max(yA, yB);
          colliderFrom(barrier, b0, GROUP.BUILDING);
        }
        continue;
      }
      // The deck's corner: where the two deck edges, run back toward the junction, meet.
      const edgeA = { x: a.p.x + a.nx * (a.half + 0.6), z: a.p.z + a.nz * (a.half + 0.6) };
      const edgeB = { x: b.p.x + b.nx * (b.half + 0.6), z: b.p.z + b.nz * (b.half + 0.6) };
      let C = lineHit(edgeA, A.dir, edgeB, B.dir) || { x: (edgeA.x + edgeB.x) / 2, z: (edgeA.z + edgeB.z) / 2 };
      // Not beyond the two points (an obtuse corner would put it out past them): clamp toward the junction.
      if (Math.hypot(C.x - n.x, C.z - n.z) > Math.max(Math.hypot(edgeA.x - n.x, edgeA.z - n.z), Math.hypot(edgeB.x - n.x, edgeB.z - n.z)) * 1.2) {
        C = { x: (edgeA.x + edgeB.x) / 2, z: (edgeA.z + edgeB.z) / 2 };
      }
      const y = n.y;
      const s0 = top.vertexCount;
      for (const [p, q] of [[edgeA, C], [C, edgeB]]) {
        // Wound to face up whichever way round the corner goes.
        const cr = (p.x - n.x) * (q.z - n.z) - (p.z - n.z) * (q.x - n.x);
        const tri = cr < 0 ? [n, p, q] : [n, q, p];
        for (const v of tri) { top.pos.push(v.x, y, v.z); top.norm.push(0, 1, 0); top.col.push(...deckRGB); }
      }
      const c = colliderFrom(top, s0, GROUP.RAMP);
      if (c) ctx.decks.add(c.handle);
      // The barrier round it, on the corner's edge -- at a corner, not where a ramp merges at a shallow angle:
      // every road here runs both ways, and a car (the police's, too) coming up a slip road may turn back the
      // other way along the ring; a nose across the merge left four of 13 slip roads undriveable that way.
      if (th > 2.4 || app.length > 3) continue;
      const bA = { x: a.p.x + a.nx * (a.half + 0.3), z: a.p.z + a.nz * (a.half + 0.3) };
      const bB = { x: b.p.x + b.nx * (b.half + 0.3), z: b.p.z + b.nz * (b.half + 0.3) };
      const bC = lineHit(bA, A.dir, bB, B.dir) || C;
      const line = Math.hypot(bC.x - n.x, bC.z - n.z) > Math.hypot(C.x - n.x, C.z - n.z) * 1.3 ? [bA, bB] : [bA, bC, bB];
      const b0 = barrier.vertexCount;
      barrier.addWall(line, 0, 1.05, BAR, 0.2);
      barrier.addWall(line, 0, 1.05, BAR, -0.2);
      barrier.addRibbon(line, 0.4, 1.05, BAR, 0);
      for (let k = b0; k < barrier.pos.length / 3; k++) barrier.pos[k * 3 + 1] += y;
      colliderFrom(barrier, b0, GROUP.BUILDING);
    }
  }
  // Where raised roads meet: the wedges between them, at the junction's height.
  for (const n of graph.nodes) {
    if (!n.elevated) continue;
    const app = approachesAt(graph, n).filter((a) => a.edge.elevated);
    if (app.length < 2) continue;
    const s0 = top.vertexCount;
    addNodeWedges(top, n, app, (e) => e.width * 0.5 + 0.6, 0, () => DECK);
    lift(top, s0, () => n.y);
    const c = colliderFrom(top, s0, GROUP.RAMP);
    if (c) ctx.decks.add(c.handle);
  }
  const out = [];
  const mk = (b, name, opts = {}, tex = null) => {
    if (!b.vertexCount) return;
    const m = new THREE.Mesh(b.build(), vertexColorMaterial(opts));
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    if (tex === 'tarmac') groundDetail(m, 'tarmac');
    else if (tex === 'panel') buildingDetail(m, 'panel');
    out.push(chunkMesh(m, 300));
  };
  // Pushed back in depth: where a ramp's foot lies on the street it meets, 1 cm under it and a shade
  // different, the two flickered; the street now always wins.
  mk(top, 'decks', { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }, 'tarmac');
  mk(paint, 'deck-markings', { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  // Lit a little of their own: from below, the sky's light reaches a slab's underside only as the ground's
  // green bounce, and the concrete read as dark olive.
  const lift2 = { emissive: 0x403f3c };
  mk(kerb, 'deck-edges', {});
  mk(under, 'deck-slabs', { side: THREE.DoubleSide, ...lift2 }, 'panel');
  mk(barrier, 'deck-barriers', { side: THREE.DoubleSide, ...lift2 });
  mk(piers, 'deck-piers', lift2, 'panel');
  return out;
}

/**
 * Back alleys through the downtown blocks, north to south between two streets. "Alleys ... make sure the
 * police cars can follow you down. Any police car ... If the police van can't, that's fine ... I just don't want
 * to like make it easy for the criminal." 7 m wide (ROAD_KIND.alley): room for a police car, and in the
 * graph like any road, so the police route down them as readily as you do. Run a couple of metres into the
 * street at each end so graph.finalise makes the junctions where they meet it. Not every block: about half,
 * picked by a hash of the block, and not the car park's.
 */
function buildAlleys(ctx) {
  const { graph } = ctx;
  let n = 0;
  for (let i = 0; i < GX.length - 1; i++) {
    for (let j = 0; j < GZ.length - 1; j++) {
      const x = (GX[i] + GX[i + 1]) / 2, z0 = GZ[j], z1 = GZ[j + 1];
      if (dtDist(x, (z0 + z1) / 2) > DT_R - 70) continue;
      if (GX[i + 1] - GX[i] < 55) continue;
      if (hash(i, j, 41) > 0.5) continue;
      if (ctx.carPark && Math.abs(x - ctx.carPark.x) < 50 && Math.abs((z0 + z1) / 2 - ctx.carPark.z) < 50) continue;
      if (inChannel(x, z0, 20) || inChannel(x, z1, 20)) continue;
      const a = graph.addNode(x, z0 - 2, 'alley'), b = graph.addNode(x, z1 + 2, 'alley');
      const e = graph.addEdge(a, b, 'alley');
      if (e) n++;
    }
  }
  ctx.alleys = n;
}

/**
 * A multi-storey car park downtown: "Downtown car park, yep." Three decks and a roof over the ground floor,
 * 4.2 m apart, a ramp up each long side going opposite ways, so you climb in a spiral -- up the south side
 * heading east, along the east end, up the north side heading west, and round again to the roof. Each deck
 * covers the whole footprint but for the ramps' runs; low walls keep a car on a deck from dropping onto the
 * ramp beside it; a parapet round each deck's edge; columns. The decks and ramps are surfaces the wheels ride
 * as road (`ctx.decks`). Not in the road graph: the police follow you in off it, as they would across a field.
 */
function buildCarPark(ctx) {
  const W = ctx.sim.world;
  const { x: cx, z: cz } = ctx.carPark;
  const LX = 48, LZ = 36, STRIP = 6.5, END = 7, STOREY = 4.2, LEVELS = 3;
  const X0 = cx - LX / 2, X1 = cx + LX / 2, Z0 = cz - LZ / 2, Z1 = cz + LZ / 2;
  const G = ctx.at(cx, cz) + KERB_H;
  const b = new MeshBuilder();
  const CON = 0x9a9893, DECK = 0x4a4c50, WALL = 0xb9b6ae, STRIPE = 0xe0b43a;
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const solid = (x, y, z, hx, hy, hz, quat, group, deck) => {
    const body = W.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }));
    const c = W.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.9).setCollisionGroups(groups(group, 0xFFFF)), body);
    if (deck) ctx.decks.add(c.handle);
  };
  const slab = (x0, x1, z0, z1, y, colour) => {
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    b.addBox(hx * 2, 0.4, hz * 2, x, y - 0.2, z, colour);
    solid(x, y - 0.2, z, hx, 0.2, hz, q.identity(), GROUP.RAMP, true);
  };
  const wall = (x0, x1, z0, z1, y, h = 1.1) => {
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2, hx = Math.max(0.15, (x1 - x0) / 2), hz = Math.max(0.15, (z1 - z0) / 2);
    b.addBox(hx * 2, h, hz * 2, x, y + h / 2, z, WALL);
    solid(x, y + h / 2, z, hx, h / 2, hz, q.identity(), GROUP.BUILDING, false);
  };
  const levelY = (k) => G + k * STOREY;
  // Decks 1..3: the whole footprint but the two strips' ramp runs.
  for (let k = 1; k <= LEVELS; k++) {
    const y = levelY(k);
    slab(X0, X1, Z0 + STRIP, Z1 - STRIP, y, DECK);                                 // the middle
    for (const [z0, z1] of [[Z0, Z0 + STRIP], [Z1 - STRIP, Z1]]) {
      slab(X0, X0 + END, z0, z1, y, DECK);                                         // the ends of the strips
      slab(X1 - END, X1, z0, z1, y, DECK);
    }
    // Parapets round the edge, and low walls between the middle and the ramp runs.
    wall(X0, X1, Z0 - 0.3, Z0, y); wall(X0, X1, Z1, Z1 + 0.3, y);
    wall(X0 - 0.3, X0, Z0, Z1, y); wall(X1, X1 + 0.3, Z0, Z1, y);
    wall(X0 + END, X1 - END, Z0 + STRIP - 0.3, Z0 + STRIP, y, 0.9);
    wall(X0 + END, X1 - END, Z1 - STRIP, Z1 - STRIP + 0.3, y, 0.9);
    // Bays painted on the middle.
    for (let x = X0 + END + 1; x < X1 - END - 1; x += 2.6) {
      b.addQuadY(x - 0.06, Z0 + STRIP + 0.6, x + 0.06, Z0 + STRIP + 0.6, x + 0.06, Z0 + STRIP + 5.4, x - 0.06, Z0 + STRIP + 5.4, y + 0.01, 0xd8dadd);
      b.addQuadY(x - 0.06, Z1 - STRIP - 5.4, x + 0.06, Z1 - STRIP - 5.4, x + 0.06, Z1 - STRIP - 0.6, x - 0.06, Z1 - STRIP - 0.6, y + 0.01, 0xd8dadd);
    }
  }
  // The ramps: level k to k+1, the south strip heading east on even k, the north strip heading west on odd.
  const run = LX - END * 2, rise = STOREY, ang = Math.atan2(rise, run), len = Math.hypot(run, rise);
  for (let k = 0; k < LEVELS; k++) {
    const south = k % 2 === 0;
    const z = south ? Z0 + STRIP / 2 : Z1 - STRIP / 2;
    const y = levelY(k) + rise / 2;
    // Up toward +x on the south side, toward -x on the north.
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), south ? ang : -ang);
    m4.compose(ps.set(cx, y - 0.2, z), q, sc.set(len, 0.4, STRIP));
    b.addGeometry(box, m4, CON);
    // A yellow stripe up each edge.
    for (const off of [-STRIP / 2 + 0.2, STRIP / 2 - 0.2]) {
      m4.compose(ps.set(cx, y + 0.01, z + off), q, sc.set(len, 0.02, 0.15));
      b.addGeometry(box, m4, STRIPE);
    }
    const qq = q.clone();
    solid(cx, y - 0.2, z, len / 2, 0.2, STRIP / 2, qq, GROUP.RAMP, true);
  }
  // Columns, ground to roof, round the middle.
  for (let x = X0 + END; x <= X1 - END + 0.1; x += (X1 - X0 - END * 2) / 3) {
    for (const z of [Z0 + STRIP, Z1 - STRIP]) {
      const h = levelY(LEVELS) - G;
      b.addBox(0.6, h, 0.6, x, G + h / 2, z + (z < cz ? 0.6 : -0.6), CON);
      addStaticBox(W, x, G + h / 2, z + (z < cz ? 0.6 : -0.6), 0.3, h / 2, 0.3, GROUP.BUILDING);
    }
  }
  // A sign on the roof's edge.
  b.addBox(10, 2.2, 0.3, cx, levelY(LEVELS) + 2.2, Z0 - 0.4, 0x1d4fc4);
  b.addBox(1.8, 1.8, 0.32, cx, levelY(LEVELS) + 2.2, Z0 - 0.42, 0xffffff);
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  buildingDetail(mesh, 'panel');
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'carpark';
  return [mesh];
}

/**
 * Dumpsters and bins along the alleys, against their walls: what makes a gap between two towers an alley.
 * "They cannot be solid ... Ideally you would be able to like push them a bit like bales. They don't need to
 * break apart." Each is a body of its own weight (BIN_MASS), asleep where it stands -- Rapier spends nothing
 * on it -- until something knocks it; then it is shoved, and its instance follows the body until it settles.
 * Never on another road: where an alley crossed a street, some stood out in the street's carriageway.
 */
const BIN_MASS = { big: 160, small: 35 };

function buildAlleyClutter(ctx) {
  const { graph } = ctx;
  const W = ctx.sim.world;
  const COLS = [0x2f5d3a, 0x2c4a6e, 0x5a5f63, 0x6e4a2c];
  const spots = { big: [], small: [] };
  for (const e of graph.edges) {
    if (e.kind !== 'alley') continue;
    for (let s = 10; s < e.length - 10; s += 13 + hash(Math.round(e.points[0].x), Math.round(s), 61) * 10) {
      const p = pointAlong(e, s);
      const side = hash(Math.round(p.x), Math.round(p.z), 62) < 0.5 ? 1 : -1;
      const off = e.width * 0.5 - 0.3;
      const x = p.x + p.nx * side * off, z = p.z + p.nz * side * off;
      if (onOtherRoad(graph, e, x, z) || onOtherRoad(graph, e, p.x, p.z)) continue;
      const big = hash(Math.round(x), Math.round(z), 63) < 0.6;
      spots[big ? 'big' : 'small'].push({ x, z, y: ctx.at(x, z), rot: Math.atan2(p.tx, p.tz), col: COLS[Math.floor(hash(Math.round(z), Math.round(x), 64) * COLS.length)] });
    }
  }
  const out = [], bins = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), ps = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), c = new THREE.Color();
  for (const kind of ['big', 'small']) {
    const list = spots[kind];
    if (!list.length) continue;
    const [w, h, d] = kind === 'big' ? [1.2, 1.3, 2.0] : [0.7, 1.0, 0.7];
    const geo = new THREE.BoxGeometry(w, h, d);
    const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), list.length);
    im.name = 'alley-bins';
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((sp, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.rot);
      const body = W.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(sp.x, sp.y + h / 2, sp.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.8).setAngularDamping(1.5).setSleeping(true));
      // Its collider reaching HILL_SINK below what is drawn: the ground the bodies rest on is that far under
      // the ground drawn and driven (terrain.js), and a bin knocked awake settled into the road.
      W.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2 + 0.175, d / 2).setTranslation(0, -0.175, 0)
        .setDensity(BIN_MASS[kind] / (w * (h + 0.35) * d)).setFriction(0.6)
        .setCollisionGroups(groups(GROUP.STREET, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.BUILDING | GROUP.STREET | GROUP.PROP)), body);
      m4.compose(ps.set(sp.x, sp.y + h / 2, sp.z), q, one);
      im.setMatrixAt(i, m4);
      im.setColorAt(i, c.setHex(sp.col));
      bins.push({ body, im, i });
    });
    im.computeBoundingSphere();
    out.push(im);
  }
  // Every frame (the map's update): the ones knocked awake follow their bodies; the bounds once they settle.
  ctx.binsUpdate = () => {
    let moved = null;
    for (const bn of bins) {
      if (bn.body.isSleeping()) { if (bn.moving) { bn.moving = false; (moved || (moved = new Set())).add(bn.im); } continue; }
      bn.moving = true;
      const t = bn.body.translation(), r = bn.body.rotation();
      m4.compose(ps.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), one);
      bn.im.setMatrixAt(bn.i, m4);
      bn.im.instanceMatrix.needsUpdate = true;
    }
    if (moved) for (const im of moved) im.computeBoundingSphere();
  };
  return out;
}

/** Where the car park goes: a downtown block west of the middle, kept clear of alleys and buildings. */
function planCarPark(ctx) {
  const i = GX.indexOf(-585), j = GZ.indexOf(-180);
  ctx.carPark = { x: (GX[i] + GX[i + 1]) / 2, z: (GZ[j] + GZ[j + 1]) / 2, hx: 27, hz: 21 };
}

/**
 * Windows lit at night up every tower and block: "tower downtown" -- a skyline. A share of the windows on
 * every face, floor by floor, warm, in a mesh shown only at night (windows.js litWindows), following the
 * tower's taper. Chosen by a hash of where each one is.
 */
function towerWindows(lit, x, z, y0, w, d, h, rot, taper) {
  const c = Math.cos(rot), sn = Math.sin(rot);
  const faces = [
    [sn, c, d / 2, w], [-sn, -c, d / 2, w], [c, -sn, w / 2, d], [-c, sn, w / 2, d],
  ];
  for (const [nx, nz, off, len] of faces) {
    const tx = -nz, tz = nx;
    const n = Math.max(1, Math.floor(len / 3.2));
    for (let y = 4.5; y < h - 3; y += 3.6) {
      const shrink = 1 - (1 - taper) * (y / h);
      for (let k = 0; k < n; k++) {
        const along = (k - (n - 1) / 2) * (len / n) * shrink;
        const px = x + nx * (off * shrink + 0.12) + tx * along, pz = z + nz * (off * shrink + 0.12) + tz * along;
        if (hash(Math.round(px * 3), Math.round(pz * 3) + Math.round(y * 7), 51) > 0.3) continue;
        const hw = 0.8, hh = 0.75, cy = y0 + y;
        lit.addDecalQuad([
          { x: px - tx * hw, y: cy - hh, z: pz - tz * hw }, { x: px + tx * hw, y: cy - hh, z: pz + tz * hw },
          { x: px + tx * hw, y: cy + hh, z: pz + tz * hw }, { x: px - tx * hw, y: cy + hh, z: pz - tz * hw },
        ], { x: nx, y: 0, z: nz }, [0, 0, 0, 0], 0xffc56b);
      }
    }
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
    if (e.kind === 'motorway') { e.name = 'the M1 ring'; continue; }
    if (e.express) { e.name = 'the Downtown Expressway'; continue; }
    if (e.kind === 'ramp') { e.name = 'the slip road'; continue; }
    if (e.kind === 'country') { e.name = COUNTRY_NAMES[(cn++) % COUNTRY_NAMES.length]; continue; }
    if (e.kind === 'lane') { e.name = CLOSE_NAMES[(ln++) % CLOSE_NAMES.length]; continue; }
    if (e.kind === 'alley') { e.name = 'the alley'; continue; }
    const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);
    if (dx > 40 && dz > 40 && Math.abs(dx - dz) < Math.max(dx, dz) * 0.5) e.name = a.z < b.z === a.x < b.x ? 'Broadway' : 'Riverside Avenue';
    else if (dz >= dx) e.name = NS_NAMES[nearestIn(GX, (a.x + b.x) / 2) % NS_NAMES.length];
    else e.name = EW_NAMES[nearestIn(GZ, (a.z + b.z) / 2) % EW_NAMES.length] + ' Street';
    if (e.bridge && !e.elevated) e.name = `the ${e.name.replace(/ Street$| Road$| Avenue$/, '')} Bridge`;
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
  if (e.kind === 'motorway' || e.kind === 'ramp' || e.kind === 'country' || e.kind === 'alley' || e.turningHead) return 0;
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
  const sf = ctx.groundSurfAt;
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
  // Each layer pulled forward by its own amount: the tarmac, then the kerbs over the footway, then the markings
  // over the tarmac. All three at the same offset, centimetres apart, fought over every pixel at a distance --
  // "quite a lot of flickering with the roads".
  const pull = { roads: [-3, -6], kerbs: [-5, -10], markings: [-7, -14] };
  for (const m of meshes) {
    liftMesh(m, ctx.at, 0.06);
    m.material = m.material.clone();
    m.material.depthFunc = THREE.LessEqualDepth;
    m.material.polygonOffset = true;
    const [f, u] = pull[m.name] || [-3, -6];
    m.material.polygonOffsetFactor = f;
    m.material.polygonOffsetUnits = u;
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
      // Its top 8 cm under the road drawn on it: 2 cm, it and the road flickered through each other at a
      // distance ("some bits just near the water").
      b.addBox(hw * 2 + 1.2, 1.4, L, x, y - 0.78, z, 0x8a8a86, rot);
      // Parapets -- not where one would stand on another road: where a street joins the bridge, or two bridges
      // meet at a bank, each piece's parapets ran straight across the other's carriageway ("you've got a wall on
      // all corners blocking ... by the water bit"). Tested at both ends of the piece and its middle.
      // Solid where drawn: the parapets are walls; the deck is for the bodywork (the wheels ride `terrainAt`).
      addStaticBox(W, x, y - 0.78, z, hw + 0.6, 0.7, L / 2, GROUP.TERRAIN, rot);
      for (const sd of [-1, 1]) {
        const px = x + uz * (hw + 0.3) * sd, pz = z - ux * (hw + 0.3) * sd;
        const ends = [[px, pz], [px - ux * L * 0.5, pz - uz * L * 0.5], [px + ux * L * 0.5, pz + uz * L * 0.5]];
        if (ends.some(([qx, qz]) => onOtherRoad(ctx.graph, br.e, qx, qz))) continue;
        b.addBox(0.5, 1.0, L, px, y + 0.5, pz, 0xa3a29c, rot);
        addStaticBox(W, px, y + 0.5, pz, 0.25, 0.5, L / 2, GROUP.BUILDING, rot);
      }
    }
    // A pier in the water every fourth piece, about 24 m.
    if (br.pier) {
      const x = ax, z = az, y = ha;
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
  const lit = new MeshBuilder();
  const tp = [], hp = [];
  const drives = [];
  const ok = (x, z, w, d, rot, r) => {
    if (graph.overlapsRoad(x, z, w, d, rot, 1.5)) return false;
    if (inChannel(x, z, r + 6) || inDocks(x, z, 10)) return false;
    if (roundabout && Math.hypot(x - roundabout.x, z - roundabout.z) < roundabout.r + r + 10) return false;
    if (Math.hypot(x, z) > RING - 40 - r) return false;
    const cp = ctx.carPark;
    if (cp && Math.abs(x - cp.x) < cp.hx + r && Math.abs(z - cp.z) < cp.hz + r) return false;
    if (nearBuilding(W, x, z, Math.min(w, d) * 0.45)) return false;
    // And its corners: packed closer downtown, two towers met at theirs.
    const c = Math.cos(rot), sn = Math.sin(rot);
    for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const lx = ax * w * 0.45, lz = az * d * 0.45;
      if (nearBuilding(W, x + lx * c + lz * sn, z - lx * sn + lz * c, 1)) return false;
    }
    return true;
  };
  for (const e of graph.edges) {
    if (e.kind === 'motorway' || e.kind === 'ramp' || e.kind === 'country' || e.turningHead || e.bridge) continue;
    if (e.width === 11 || e.kind === 'alley') continue;
    for (const side of [1, -1]) {
      let s = rand(rng, 3, 9);
      while (s < e.length - 6) {
        const p = pointAlong(e, s);
        const dd = dtDist(p.x, p.z);
        const kind = dd < DT_R ? 'tower' : dd < DT_R + 220 ? 'block' : 'house';
        let w, d, h, gap, back;
        if (kind === 'tower') {
          // Narrower than they were (20-36 by 18-34): the alleys halve the blocks, and most of them did not fit.
          w = rand(rng, 14, 30); d = rand(rng, 12, 22); gap = rand(rng, 1, 3);
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
          towerWindows(lit, x, z, y0, w, d, h, rot, taper);
        }
        addStaticBox(W, x, y0 + h / 2 - 1.5, z, w / 2, h / 2 + 1.5, d / 2, GROUP.BUILDING, rot);
        s += w + gap;
      }
    }
  }
  // Downtown's empty plots filled: "there's almost too much open space in the center of the town". The
  // buildings above front the streets, and the middle of every block, between them, was bare paving. Towers
  // wherever one still fits, on a 26 m lattice, shorter than the street fronts.
  // The biggest that fits, of four sizes, on an 8 m lattice: the alleys halve the blocks, and a 16-26 m tower fitted few of the
  // halves -- they stayed bare plates of paving.
  for (let gx = DT.x - DT_R; gx < DT.x + DT_R; gx += 8) {
    for (let gz = DT.z - DT_R; gz < DT.z + DT_R; gz += 8) {
      const x = gx + rand(rng, -2, 2), z = gz + rand(rng, -2, 2);
      const dd = dtDist(x, z);
      if (dd > DT_R - 30) continue;
      let w = 0, d = 0, r = 0;
      for (const size of [24, 18, 13, 10]) {
        const ww = size * rand(rng, 0.85, 1.1), dw = size * rand(rng, 0.85, 1.1), rr = Math.hypot(ww, dw) * 0.5;
        if (ok(x, z, ww, dw, 0, rr)) { w = ww; d = dw; r = rr; break; }
      }
      if (!w) continue;
      const h = Math.max(18, lerp(110, 26, dd / DT_R) * rand(rng, 0.45, 0.9));
      const y0 = ctx.at(x, z);
      const st = towers.vertexCount;
      const tone = rand(rng, 0.34, 0.62);
      towers.addTaperedBox(w, h + 3, d, x, h / 2 - 1.5, z, new THREE.Color(tone, tone * 0.98, tone * 0.95), 1, 1, 0);
      for (let k = 0; k < Math.floor(h / 14); k++) towers.addBox(w * 1.01, Math.min(5, h * 0.12), d * 0.9, x, (k + 0.6) * (h / (Math.floor(h / 14) + 0.2)), z, new THREE.Color(tone * 0.4, tone * 0.46, tone * 0.58), 0);
      towers.addBox(w * 1.02, 2, d * 1.02, x, 1, z, 0x2a2c30, 0);
      tp.push([st, towers.vertexCount, x, z]);
      towerWindows(lit, x, z, y0, w, d, h, 0, 1);
      addStaticBox(W, x, y0 + h / 2 - 1.5, z, w / 2, h / 2 + 1.5, d / 2, GROUP.BUILDING, 0);
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
  const litMesh = litWindows(lit);
  if (litMesh) out.push(litMesh);
  return out;
}

/** Is (x, z) on the carriageway of some road other than `e` (with half a metre to spare)? */
function onOtherRoad(graph, e, x, z) {
  for (const o of graph.edgesNear(x, z, 30)) {
    if (o === e || o.dead) continue;
    for (const sg of o.segs) {
      if (closestOnSegment(x, z, sg.a.x, sg.a.z, sg.b.x, sg.b.z).dist < o.width * 0.5 + 0.5) return true;
    }
  }
  return false;
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
