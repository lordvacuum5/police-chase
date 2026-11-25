// Ashfield City: the American map, rebuilt.
//
// "It was the first map we ever made ... I'd never play on it because it's just the most boring map in the
// world." It was a 2 km square of flat grid inside a ring motorway. Now, asked for piece by piece:
//
//   * bigger -- "if it was the biggest map, it'd be really cool": 3 km across (WORLD_HALF 1500, against
//     2 km for Wexbury and Haldon Vale), set by maps.js `half` before the build;
//   * a river through the middle, north to south, in a channel below the streets, crossed by bridges;
//     most of the car under, it floods (main.js, `waterAt`);
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
import { RoadGraph, ROAD_KIND, LANE_LINES } from './roadgraph.js';
import { approachesAt, addNodeWedges, sliceLine } from './junctions.js';
import { GROUP, groups, RAPIER, addStaticBox, addCanopy, nearBuilding, EDGE_FACE } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, closestOnSegment, TAU } from '../util/math.js';
import {
  WORLD_HALF, GRID_N, KERB_H, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, makeHeightAt, buildGround, buildRoadMeshes, DRAW_ORDER, LIFT, ROAD_OVER, PAVE_OVER, trueDepth,
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
 * A ramp's rise, 0 at its foot to 1 at its deck, by how far along it is from the foot (0..1): level for the
 * first `flat` of it -- at grade, where it meets its streets and passes the ones round them -- then easing up.
 * A third, unless the ramp was laid with its own (RAMP_FLATS, rampClear): where it climbs is where it is too low
 * to drive under and too high to drive over, and that has to fall between the streets, not across one.
 */
function rampRise(u, flat = 0.33) {
  const t = clamp((u - flat) / (1 - flat), 0, 1);
  return t * t * (3 - 2 * t);
}
/** The level stretches a ramp may be laid with, as shares of its length: the usual third first. */
const RAMP_FLATS = [0.33, 0.27, 0.39, 0.21, 0.45, 0.15, 0.51, 0.09, 0.57];
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
  graph.exactCells = true;
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
  // The country roads before the grid's slip roads, so a slip road is laid knowing where they are: one ran
  // 2 m over a country road built after it.
  buildCountryRoads(ctx, ring);
  connectRamps(ctx, grid, ring);
  buildCulDeSacs(ctx, grid);
  const roundabout = buildRoundabout(ctx, grid);
  // None under a ramp: a turning head added after it stood where one came down, 0.4 m under its slab.
  const rampSegs = [];
  for (const e of graph.edges) {
    if (e.kind !== 'ramp') continue;
    for (let k = 0; k < e.points.length - 1; k++) rampSegs.push([e.points[k], e.points[k + 1]]);
  }
  graph.addTurningHeads(15, 10, WORLD_HALF, (x, z, r) => rampSegs.some(([p, q]) => closestOnSegment(x, z, p.x, p.z, q.x, q.z).dist < r + ROAD_KIND.ramp.width * 0.5 + 4));
  planCarPark(ctx);
  // After the turning heads, which would have put one on each alley's end.
  buildAlleys(ctx);
  // Traffic lights downtown only: at every one of the city's junctions they were 1,595 heads, and with the
  // avenues' junctions too still 927 -- each in four instanced meshes drawn whole every frame, 290,000
  // triangles of a suburban view's 1,000,000.
  graph.signalFilter = (node) => dtDist(node.x, node.z) < DT_R + 60;
  joinBridges(ctx);
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
  // With the stretches of ramp that lie on the ground in it: the ground drawn is let down under them as it is
  // under a street.
  ctx.streetSurfAt = makeSurfaceAt(surface.slice());
  // What the wheels ride is the streets' own, not the strips under the raised roads marked road below.
  const kerbAt = makeHeightAt(surface.slice(), PAVE_OVER, ROAD_OVER);
  const groundSurf = surface.slice();
  for (const e of graph.edges) {
    if (e.kind !== 'ramp' || !e.deck) continue;
    for (let d = 0; d <= e.length; d += 2) {
      const p = pointAlong(e, d);
      if (graph.levelOn(e, p.x, p.z) - at(p.x, p.z) < 0.8) paintDisc(groundSurf, p.x, p.z, e.width * 0.5 + 0.6, SURF_ROAD);
    }
  }
  ctx.groundSurfAt = makeSurfaceAt(groundSurf);
  for (const e of graph.edges) {
    if (!e.elevated) continue;
    for (const sg of e.segs) {
      const steps = Math.max(1, Math.ceil(sg.len / 3));
      for (let k = 0; k <= steps; k++) paintDisc(surface, lerp(sg.a.x, sg.b.x, k / steps), lerp(sg.a.z, sg.b.z, k / steps), e.width * 0.5, SURF_ROAD);
    }
  }
  ctx.surfAt = makeSurfaceAt(surface);
  const heightAt = (x, z) => at(x, z) + kerbAt(x, z);

  // --- visuals -------------------------------------------------------
  const meshes = [];
  buildGround(ctx);          // the plate under it all and the wall at the edge, not the flat mesh
  meshes.push(...buildTerrain(ctx, hgrid));
  const [tarmac, markings, kerbs, wear] = buildRoadMeshes(ctx);
  const lifted = liftRoads(ctx, [tarmac, markings, kerbs]);
  // The kerbs in cells: one mesh of them was 77,000 triangles drawn wherever you looked.
  // All in cells: one mesh each, the roads were 58,000 triangles drawn wherever you looked.
  meshes.push(trueDepth(chunkMesh(lifted[0], 300), DRAW_ORDER.tarmac), chunkMesh(lifted[1], 300), trueDepth(chunkMesh(lifted[2], 300), DRAW_ORDER.tarmac + 0.3));
  if (wear) {
    liftMesh(wear, at, LIFT);
    // Over the tarmac's true depth (trueDepth), not its pulled one: more, and it was drawn over tyres.
    wear.material.polygonOffsetFactor = -1;
    wear.material.polygonOffsetUnits = -2;
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
    /** The water's surface over (x, z), or null where there is none. */
    waterAt: (x, z) => (riverOn(z) > 0.3 && Math.abs(riverSide(x, z)) < WATER_HALF + BANK_RUN * 0.6 ? WATER : null),
    clearAt: (x, z) => inChannel(x, z, 2),
    // The raised roads' deck colliders: a wheel on one is on road (Vehicle).
    decks: ctx.decks,
    walls: ctx.walls,
    /** Stretches of raised road with no barrier (world/jumps.js). */
    jumps: ctx.jumps,
    // 28 to 50: "maybe we should have denser traffic ... it just looks so empty". Simulated only within 100 m, not 150.
    trafficCount: 110,
    // Seen coming from as far as the fog lets you: what may come into being in view does so past it.
    trafficFar: 560,
    trafficSim: 100,
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
  // In pieces of no more than 40 m: graph.finalise finds where roads cross by comparing the segments in
  // neighbouring cells, and Broadway as one 876 m segment crossed a dozen streets with no junction at all.
  {
    const raw = [a, ...pts, b], dense = [];
    for (let k = 0; k < raw.length - 1; k++) {
      const p = raw[k], q = raw[k + 1], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 40));
      if (k > 0) dense.push({ x: p.x, z: p.z });
      for (let m = 1; m < n; m++) dense.push({ x: lerp(p.x, q.x, m / n), z: lerp(p.z, q.z, m / n) });
    }
    pts = dense;
  }
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
  // The two banks, BANK m out of the river either side, found along the whole road (not just within the
  // segment that crosses: in 40 m pieces that never reached the bank, and a bridge ended mid-river).
  const BANK = WATER_HALF + BANK_RUN + 16;
  const S = [0];
  for (let k = 1; k < line.length; k++) S.push(S[k - 1] + Math.hypot(line[k].x - line[k - 1].x, line[k].z - line[k - 1].z));
  const at = (sv) => {
    let k = 0;
    while (k < line.length - 2 && S[k + 1] < sv) k++;
    const u = (sv - S[k]) / Math.max(1e-6, S[k + 1] - S[k]);
    return { x: lerp(line[k].x, line[k + 1].x, u), z: lerp(line[k].z, line[k + 1].z, u) };
  };
  const sNear = Math.sign(riverSide(a.x, a.z)), sFar = Math.sign(riverSide(b.x, b.z));
  const sc = S[cross];
  let s0 = null, s1 = null;
  for (let sv = sc; sv >= 0; sv -= 1) { const pt = at(sv), v = riverSide(pt.x, pt.z); if (Math.sign(v) === sNear && Math.abs(v) >= BANK) { s0 = sv; break; } }
  for (let sv = S[cross + 1]; sv <= S[S.length - 1]; sv += 1) { const pt = at(sv), v = riverSide(pt.x, pt.z); if (Math.sign(v) === sFar && Math.abs(v) >= BANK) { s1 = sv; break; } }
  if (s0 === null || s1 === null || s1 - s0 < 20 || s0 < 15 || S[S.length - 1] - s1 < 15) return null;
  const p0 = at(s0), p1 = at(s1);
  const n0 = graph.addNode(p0.x, p0.z, 'bridge');
  const n1 = graph.addNode(p1.x, p1.z, 'bridge');
  // The road's own points short of the near bank and past the far one; the span straight between the banks.
  const before = line.slice(1, -1).filter((_, i) => S[i + 1] < s0 - 1);
  const after = line.slice(1, -1).filter((_, i) => S[i + 1] > s1 + 1);
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
      if (inChannel(p.x, p.z, 26) || inDocks(p.x, p.z, -30) || !insideRing(p.x, p.z, 90)) { nodes[i][j] = null; continue; }
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

/**
 * Is (x, z) inside the ring motorway by `pad` m? The grid's corners stood out past its rounded corners, and
 * their streets crossed the country roads beyond it with no junction.
 */
function insideRing(x, z, pad) {
  const lim = RING - pad;
  if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
  const st = RING - RING_CORNER;
  const dx = Math.max(0, Math.abs(x) - st), dz = Math.max(0, Math.abs(z) - st);
  return Math.hypot(dx, dz) < RING_CORNER - pad;
}

/** The ring motorway: a rounded square, sampled finely on its corners. Raised all the way round. */
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
function addSlipRoad(ctx, ring, anchor, aim, depth = 0) {
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
    // Off the end of a street, straight on along it: it left a corner, and a notch of grass in the road; one turned back
    // beside the street itself.
    if (anchor.edges.length === 1) {
      const e = graph.edges[anchor.edges[0]], pts = e.points, q = e.a === anchor.id ? pts[1] : pts[pts.length - 2];
      const l = Math.hypot(anchor.x - q.x, anchor.z - q.z) || 1;
      adx = (anchor.x - q.x) / l; adz = (anchor.z - q.z) / l;
    }
    // Leaving at 45 degrees or more to every street at its foot, where it can.
    else {
      const dirs = anchor.edges.map((id) => {
        const e = graph.edges[id], q = e.a === anchor.id ? e.points[1] : e.points[e.points.length - 2];
        return Math.atan2(q.z - anchor.z, q.x - anchor.x);
      });
      const gap = (t) => Math.min(...dirs.map((o) => Math.abs(Math.atan2(Math.sin(t - o), Math.cos(t - o)))));
      const t0a = Math.atan2(adz, adx);
      let turn = 0;
      if (gap(t0a) < 0.78) {
        for (let k = 1; k <= 14 && !turn; k++) for (const q of [k * 0.08, -k * 0.08]) if (!turn && gap(t0a + q) >= 0.78) turn = q;
      }
      adx = Math.cos(t0a + turn); adz = Math.sin(t0a + turn);
    }
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
    // Rounded off (corner cutting, its ends kept): ten points, it had a 19-degree corner where the curve off the
    // street met the taper alongside the ring, and a car on it at speed went into the barrier.
    let full = [anchor, ...approach, taper[0], taper[1], taper[2], N];
    for (let it = 0; it < 3; it++) {
      const out = [full[0]];
      for (let i = 0; i < full.length - 1; i++) {
        const a = full[i], b = full[i + 1];
        if (i > 0) out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
        if (i < full.length - 2) out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
      }
      out.push(full[full.length - 1]);
      full = out;
    }
    if (full.some((q) => inChannel(q.x, q.z, 8))) continue;
    // Neither out along the countryside nor, from a junction found for it (depth), short and tight: the two first laid so,
    // 216 and 257 m with bends of 66-80 m, the AI stopped at the foot of (tests/everyroad.js).
    const long = full.reduce((l, q, k) => (k ? l + Math.hypot(q.x - full[k - 1].x, q.z - full[k - 1].z) : 0), 0);
    if (long > 760 || (depth && long < 300)) continue;
    // Not off along a street at its foot: four left theirs at 9-12 degrees, two roads lying over each other for 60 m.
    {
      const far = (pts) => {
        let i = 1;
        while (i < pts.length - 1 && Math.hypot(pts[i].x - anchor.x, pts[i].z - anchor.z) < 30) i++;
        const l = Math.hypot(pts[i].x - anchor.x, pts[i].z - anchor.z) || 1;
        return { x: (pts[i].x - anchor.x) / l, z: (pts[i].z - anchor.z) / l };
      };
      const d = far(full);
      const along = anchor.edges.some((id) => {
        const e = graph.edges[id], o = far(e.a === anchor.id ? e.points : e.points.slice().reverse());
        return d.x * o.x + d.z * o.z > 0.9;
      });
      if (along) continue;
    }
    let sharpest = 0;
    for (let i = 1; i < full.length - 1; i++) {
      const ux = full[i - 1].x - full[i].x, uz = full[i - 1].z - full[i].z;
      const vx = full[i + 1].x - full[i].x, vz = full[i + 1].z - full[i].z;
      const ul = Math.hypot(ux, uz) || 1, vl = Math.hypot(vx, vz) || 1;
      sharpest = Math.max(sharpest, Math.PI - Math.acos(clamp((ux * vx + uz * vz) / (ul * vl), -1, 1)));
    }
    if (sharpest > 1.25) continue;
    // And no bend tighter than 40 m: the angle at each point was all that was asked, and five slip roads had a
    // bend of 12-20 m -- a car on it at speed went into the barrier. Measured over 6 m either side every 3 m.
    {
      const dense = [];
      for (let i = 0; i < full.length - 1; i++) {
        const a = full[i], b = full[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3));
        for (let m = 0; m < n; m++) dense.push({ x: lerp(a.x, b.x, m / n), z: lerp(a.z, b.z, m / n) });
      }
      dense.push(full[full.length - 1]);
      let tight = false;
      for (let i = 2; i < dense.length - 2 && !tight; i++) {
        const a = dense[i - 2], b = dense[i], c = dense[i + 2];
        const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ac = Math.hypot(c.x - a.x, c.z - a.z);
        const area = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
        if (area > 1e-6 && (ab * bc * ac) / (4 * area) < (depth ? 110 : 40)) tight = true;
      }
      if (tight) continue;
    }
    // Up from the ground at the anchor to the ring's deck at N, clear of every road it passes over.
    const flat = rampClear(ctx, full, ctx.base(anchor.x, anchor.z), ctx.base(N.x, N.z) + raiseAt(N.x, N.z), true,
      [...ring, ring[0]], half);
    if (flat === null) continue;
    // Never along the ground across a street: from the last street it would cross, at its nearest junction, instead.
    // Three ran flush over five streets with no junction there, their kerbs and markings carried on across.
    if (depth < 4) {
      // 40 m on from its level stretch, too: a street it crosses there is crossed flush, or CLEAR of it, which it
      // cannot yet be at 9%.
      const at = lastFlushCrossing(ctx, full, flat * ctx.rampSpan + 40, anchor);
      if (at) {
        const made = addSlipRoad(ctx, ring, at, aim, depth + 1);
        if (made) return made;
        // Nor one from there: the same line, a street as far as the junction and a slip road from it.
        let k = -1, bd = 12;
        for (let i = 0; i < full.length - 1; i++) {
          const dd = closestOnSegment(at.x, at.z, full[i].x, full[i].z, full[i + 1].x, full[i + 1].z).dist;
          if (dd < bd) { bd = dd; k = i; }
        }
        const clearOf = (q) => Math.hypot(q.x - at.x, q.z - at.z) > 6;
        const rest = k < 0 ? null : [at, ...full.slice(k + 1).filter(clearOf)];
        const flat2 = rest && rampClear(ctx, rest, ctx.base(at.x, at.z), ctx.base(N.x, N.z) + raiseAt(N.x, N.z), true, [...ring, ring[0]], half);
        if (flat2 !== null && rest) {
          graph.addEdge(anchor, at, 'street', full.slice(1, k + 1).filter(clearOf));
          const ramp = graph.addEdge(at, N, 'ramp', rest.slice(1, -1), { bridge: true });
          if (ramp) { ramp.elevated = true; ramp.flat = flat2; }
          junctions.push({ node: N });
          return N;
        }
      }
    }
    const ramp = graph.addEdge(anchor, N, 'ramp', full.slice(1, -1), { bridge: true });
    if (ramp) { ramp.elevated = true; ramp.flat = flat; }
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
    // The road's own points, from the roundabout out, and only those outside it: as they were, one laid the other
    // way ran to the roundabout, back, and there again on top of itself, 186 m of road in 92.
    const pts = (e.a === centre.id ? e.points : e.points.slice().reverse()).slice(1, -1)
      .filter((p) => Math.hypot(p.x - centre.x, p.z - centre.z) > R + 8);
    graph.addEdge(best, o, e.kind, pts.length ? pts : null);
    e.dead = true;
  }
  graph.edges = graph.edges.filter((e) => !e.dead);
  graph.edges.forEach((e, i) => { e.id = i; });
  for (const n of graph.nodes) n.edges = [];
  graph.edges.forEach((e) => { graph.nodes[e.a].edges.push(e.id); graph.nodes[e.b].edges.push(e.id); });
  return { x: centre.x, z: centre.z, r: R };
}

/**
 * Bridges that cross over the water meet in a junction. The stitching leaves bridges alone (a crossing there is one
 * over the other, as a rule), and Broadway's ran across Twentieth Street's with nothing joining them, their decks
 * up to 30 cm apart: one's slab stood out of the other's tarmac, under it and unseen -- "right in front of me there
 * is an invisible wall ... it's like where the road crosses". Both are at the bank's level where they meet.
 */
function joinBridges(ctx) {
  const { graph } = ctx;
  for (let guard = 0; guard < 20; guard++) {
    const spans = graph.edges.filter((e) => e.bridge && !e.elevated && !e.dead);
    let hit = null;
    for (let i = 0; i < spans.length && !hit; i++) {
      for (let j = i + 1; j < spans.length && !hit; j++) {
        const A = spans[i], B = spans[j];
        if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const p = graph.nodes[A.a], q = graph.nodes[A.b], r = graph.nodes[B.a], t = graph.nodes[B.b];
        const d = (q.x - p.x) * (t.z - r.z) - (q.z - p.z) * (t.x - r.x);
        if (Math.abs(d) < 1e-6) continue;
        const u = ((r.x - p.x) * (t.z - r.z) - (r.z - p.z) * (t.x - r.x)) / d;
        const v = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d;
        if (u > 0.02 && u < 0.98 && v > 0.02 && v < 0.98) hit = { A, B, x: p.x + (q.x - p.x) * u, z: p.z + (q.z - p.z) * u };
      }
    }
    if (!hit) break;
    const n = graph.addNode(hit.x, hit.z, 'cross');
    for (const e of [hit.A, hit.B]) {
      const opts = { width: e.width, lanes: e.lanes, speed: e.speed, bridge: true };
      for (const [a, b] of [[e.a, n.id], [n.id, e.b]]) {
        const ne = graph.addEdge(graph.nodes[a], graph.nodes[b], e.kind, null, opts);
        if (ne) { ne.overWater = true; if (e.pave !== undefined) ne.pave = e.pave; }
      }
      e.dead = true;
    }
    graph.edges = graph.edges.filter((e) => !e.dead);
    graph.edges.forEach((e, i) => { e.id = i; });
    for (const m of graph.nodes) m.edges = [];
    graph.edges.forEach((e) => { graph.nodes[e.a].edges.push(e.id); graph.nodes[e.b].edges.push(e.id); });
  }
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
  // Kept until a road is added.
  if (ctx._segs && ctx._segs.n === ctx.graph.edges.length) return ctx._segs.out;
  const out = [];
  for (const e of ctx.graph.edges) {
    if (e.elevated || e.dead) continue;
    const pts = e.points;
    for (let k = 0; k < pts.length - 1; k++) out.push({ a: pts[k], b: pts[k + 1], half: e.width * 0.5, e });
  }
  ctx._segs = { n: ctx.graph.edges.length, out };
  return out;
}

/**
 * The junction (a ground road's end within 30 m) nearest the last street that `pts` crosses in its first `run` m, where
 * a slip road from `foot` still lies on the ground, or a new one at the crossing; null when it crosses none.
 */
function lastFlushCrossing(ctx, pts, run, foot) {
  const { graph } = ctx;
  let d = 0, last = null;
  for (let k = 0; k < pts.length - 1 && d < run; k++) {
    const p = pts[k], q = pts[k + 1], len = Math.hypot(q.x - p.x, q.z - p.z);
    for (const sg of groundSegs(ctx)) {
      const bx = q.x - p.x, bz = q.z - p.z, dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, den = bx * dz - bz * dx;
      if (Math.abs(den) < 1e-9) continue;
      const u = ((sg.a.x - p.x) * dz - (sg.a.z - p.z) * dx) / den, v = ((sg.a.x - p.x) * bz - (sg.a.z - p.z) * bx) / den;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const x = p.x + bx * u, z = p.z + bz * u, at = d + len * u;
      if (at > run || Math.hypot(x - foot.x, z - foot.z) < 25 || (last && at < last.at)) continue;
      last = { at, x, z, e: sg.e };
    }
    d += len;
  }
  if (!last) return null;
  const ends = [last.e.a, last.e.b].map((id) => graph.nodes[id]).filter((n) => n !== foot && !n.elevated)
    .map((n) => ({ n, d: Math.hypot(n.x - last.x, n.z - last.z) })).sort((a, b) => a.d - b.d);
  if (ends.length && ends[0].d < 30) return ends[0].n;
  // Nowhere near one: a new junction, the street split there.
  const e = last.e, n = graph.addNode(last.x, last.z, 'cross');
  let seg = 0, bd = Infinity;
  for (let k = 0; k < e.points.length - 1; k++) {
    const dd = closestOnSegment(n.x, n.z, e.points[k].x, e.points[k].z, e.points[k + 1].x, e.points[k + 1].z).dist;
    if (dd < bd) { bd = dd; seg = k; }
  }
  const opts = { width: e.width, lanes: e.lanes, speed: e.speed, bridge: e.bridge, y: e.y };
  for (const [a, b, mid] of [[graph.nodes[e.a], n, e.points.slice(1, seg + 1)], [n, graph.nodes[e.b], e.points.slice(seg + 1, -1)]]) {
    const ne = graph.addEdge(a, b, e.kind, mid.length ? mid : null, opts);
    for (const k of Object.keys(e)) if (!(k in ne)) ne[k] = e[k];
  }
  e.dead = true;
  graph.reindexEdges();
  return n;
}

/**
 * A ramp along `pts` from height `y0` at its first point to `y1` at its last: is it no steeper than 9%, and
 * does it cross no ground road except flush with it or with CLEAR under it, but in the mouth of the junction at
 * its foot?
 *
 * It used to leave out the 30 m at its foot and every street that met there. But a ramp that comes down
 * across a junction's corner is still a metre or four up as it passes over the junction's other streets, and
 * its slab and barriers wall them off: "the bridge is kind of like cutting it into the road there ... there's
 * a junction. You can't actually get through one of the sides." Four ramps did (tests/cityaudit.js). Between
 * 0.3 m (flush with the road: no barrier there, buildDecks) and CLEAR, it is a lip or a wall.
 */
function rampClear(ctx, pts, yFoot, yTop, footFirst, main, mainHalf) {
  let L = 0;
  const S = [0];
  for (let k = 1; k < pts.length; k++) { L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z); S.push(L); }
  // The foot is the end on the ground -- not the lower end: on Ashfield Heights a slip road comes down from its
  // foot on the hill to the ring.
  const fp = footFirst ? pts[0] : pts[pts.length - 1];
  // Only the streets near it: all of the city's, for each of some hundreds of ramps tried, were 9 s of loading.
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const q of pts) { bx0 = Math.min(bx0, q.x - 30); bx1 = Math.max(bx1, q.x + 30); bz0 = Math.min(bz0, q.z - 30); bz1 = Math.max(bz1, q.z + 30); }
  const segs = groundSegs(ctx).filter((sg) => Math.max(sg.a.x, sg.b.x) > bx0 && Math.min(sg.a.x, sg.b.x) < bx1
    && Math.max(sg.a.z, sg.b.z) > bz0 && Math.min(sg.a.z, sg.b.z) < bz1);
  const rampHalf = ROAD_KIND.ramp.width * 0.5;
  // The junction's mouth: where the ramp is the road joining it, as far out as its widest street's edge and
  // the ramp's own half-width past that.
  let mouth = 0;
  for (const sg of segs) {
    if (Math.hypot(sg.a.x - fp.x, sg.a.z - fp.z) < 1 || Math.hypot(sg.b.x - fp.x, sg.b.z - fp.z) < 1) mouth = Math.max(mouth, sg.half);
  }
  mouth += rampHalf + 4;
  // Each sample once: where it is, how far from the foot, and whether any street is under it.
  const samples = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const len = S[k + 1] - S[k], n = Math.max(1, Math.ceil(len / 3));
    for (let m = 0; m <= n; m++) {
      const s = S[k] + len * m / n;
      const x = lerp(pts[k].x, pts[k + 1].x, m / n), z = lerp(pts[k].z, pts[k + 1].z, m / n);
      if (Math.hypot(x - fp.x, z - fp.z) < mouth) continue;
      const over = segs.some((sg) => closestOnSegment(x, z, sg.a.x, sg.a.z, sg.b.x, sg.b.z).dist < sg.half + rampHalf + 1);
      if (over) samples.push({ d: footFirst ? s : L - s, base: ctx.base(x, z) });
    }
  }
  // How far it runs alongside the road it joins at its top, held at that road's height (computeDecks holdAt:
  // while it overlaps, and 25 m on), up to 200 m or 45% of it. It climbs between its level stretch and there.
  const need = rampHalf + mainHalf + 1.5;
  let hold = 0;
  for (let d = 0; d <= Math.min(200, L * 0.45); d += 2) {
    const sv = footFirst ? L - d : d;
    let k = 0;
    while (k < pts.length - 2 && S[k + 1] < sv) k++;
    const u = clamp((sv - S[k]) / Math.max(1e-6, S[k + 1] - S[k]), 0, 1);
    const x = lerp(pts[k].x, pts[k + 1].x, u), z = lerp(pts[k].z, pts[k + 1].z, u);
    let near = Infinity;
    for (let q = 0; q < main.length - 1; q++) near = Math.min(near, closestOnSegment(x, z, main[q].x, main[q].z, main[q + 1].x, main[q + 1].z).dist);
    hold = d;
    if (near > need) { hold = d + 25; break; }
  }
  const span = Math.max(1, L - hold);
  ctx.rampSpan = span;
  // The ground where it leaves it, `d` m from the foot.
  const leaveAt = (d) => {
    const sv = footFirst ? d : L - d;
    let k = 0;
    while (k < pts.length - 2 && S[k + 1] < sv) k++;
    const u = clamp((sv - S[k]) / Math.max(1e-6, S[k + 1] - S[k]), 0, 1);
    return ctx.base(lerp(pts[k].x, pts[k + 1].x, u), lerp(pts[k].z, pts[k + 1].z, u));
  };
  for (const flat of RAMP_FLATS) {
    // No steeper than 9% on average where it climbs.
    if (Math.abs(yTop - yFoot) > span * (1 - flat) * 0.09) continue;
    const leave = leaveAt(flat * span);
    // With a margin each way: the deck as built climbs over a slightly shorter stretch (computeDecks holds it
    // level at its top), and came out 0.4 m over a street planned as flush.
    // Its level stretch lies on the ground (computeDecks), then it climbs from where it leaves it. With a
    // margin each way, for the deck as built climbing over a slightly shorter stretch (held level at its top).
    if (samples.every((q) => { const r = rampRise(q.d / span, flat); const up = r <= 0 ? 0 : lerp(leave, yTop, r) - q.base; return up < 0.1 || up >= CLEAR + 0.3; })) return flat;
  }
  return null;
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
        const flat = rampClear(ctx, pts, ctx.base(G.x, G.z), top, false, nodes, ROAD_KIND.dual.width * 0.5);
        if (flat === null) continue;
        bl = gl; best = { G, pts, flat };
      }
      if (!best) continue;
      const e = graph.addEdge(A, best.G, 'ramp', best.pts.slice(1, -1), { bridge: true });
      if (e) { e.elevated = true; e.flat = best.flat; made++; if (!tops.includes(A)) tops.push(A); }
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
        // Level for as many metres from the foot as it was laid with (rampClear chose where it climbs), then up
        // to the top of the stretch between the holds.
        // A share of the stretch it climbs over, between its foot and the hold at its top (as rampClear planned).
        const flatM = (e.flat !== undefined ? e.flat : 0.33) * (s1 - s0);
        // From the end on the ground (on Ashfield Heights that is the higher end).
        const footAtA = !graph.nodes[e.a].elevated;
        const dFoot = footAtA ? S[k] - s0 : s1 - S[k];
        const t = clamp((dFoot - flatM) / Math.max(1, s1 - s0 - flatM), 0, 1);
        const lp = pointAlong(e, clamp(footAtA ? s0 + flatM : s1 - flatM, 0, L));
        const leave = ground(lp.x, lp.z) + 0.05;
        // On the ground under it while level, not at the foot's height: level at the foot's height, where the
        // ground fell away it stood 0.4 m proud of a street it crossed. Then up from where it leaves the ground --
        // not from the ground under it all the way, or it dipped with every sunken street it passed over (39%
        // for 3 m).
        const y = t <= 0 ? ground(P[k].x, P[k].z) + 0.05 : lerp(leave, footAtA ? eb : ea, t * t * (3 - 2 * t));
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
 * Stretches of the ring with no barrier, to jump off: "you could add some more sections with no crash barrier if you want.
 * That could be kind of fun." Where, and whether on the city's side of it; picked by tests/jumpsites.js from where all of
 * 18 ways off the edge, both ways along, come down with nothing in the way.
 */
const JUMPS = [
  [-1150, -16, 'in'], [-571, -1150, 'in'], [-44, -1150, 'in'], [313, -1150, 'in'], [691, -1150, 'in'], [1150, -193, 'in'],
  [1150, 522, 'in'], [631, 1150, 'in'], [-184, 1150, 'in'], [-522, 1150, 'in'], [-1150, 571, 'in'],
  [1150, -760, 'out'], [442, 1150, 'out'], [373, -1150, 'out'],
];
/** How long each is, m. */
const JUMP_LEN = 46;

/** JUMPS found on the ring: { edge, s, side, x, z, y, nx, nz, tx, tz }, out from the road along n. */
function planJumps(graph) {
  const out = [];
  for (const [x, z, way] of JUMPS) {
    let best = null;
    for (const e of graph.edges) {
      if (e.kind !== 'motorway' || !e.elevated) continue;
      for (const sg of e.segs) {
        const r = closestOnSegment(x, z, sg.a.x, sg.a.z, sg.b.x, sg.b.z);
        if (!best || r.dist < best.d) best = { d: r.dist, e, s: sg.start + sg.len * r.t };
      }
    }
    if (!best || best.d > 12 || best.e.length < JUMP_LEN + 8) continue;
    const e = best.e, s = clamp(best.s, JUMP_LEN / 2 + 3, e.length - JUMP_LEN / 2 - 3), p = pointAlong(e, s);
    const inward = -p.tz * p.x + p.tx * p.z < 0;
    const side = inward === (way === 'in') ? 1 : -1;
    const nx = -p.tz * side, nz = p.tx * side;
    out.push({ edge: e, s, side, x: p.x + nx * e.width * 0.5, z: p.z + nz * e.width * 0.5, y: graph.levelOn(e, p.x, p.z), nx, nz, tx: p.tx, tz: p.tz, len: JUMP_LEN });
  }
  return out;
}

/**
 * The raised roads drawn and made solid: a deck with its markings, its slab's edge and underside, a crash
 * barrier each side (open where roads join), piers down to the ground where there is no road under them.
 * The deck's surface is a collider the wheels ride (a group the AI's sweeps and sight lines do not see), and
 * noted in `ctx.decks` so a wheel on it is on road; the barriers and piers are walls.
 */
function buildDecks(ctx) {
  // A slice that starts on one of its points has two there, one on the other: no direction between them, and the
  // first length of barrier stood square across the ramp (four slip roads walled off).
  const slice5 = (pts, from, to) => {
    const l = sliceLine(pts, from, to);
    if (!l) return null;
    const out = l.filter((p, k) => k === 0 || k === l.length - 1 || Math.hypot(p.x - l[k - 1].x, p.z - l[k - 1].z) > 0.01);
    while (out.length > 2 && Math.hypot(out[1].x - out[0].x, out[1].z - out[0].z) < 0.02) out.splice(1, 1);
    while (out.length > 2 && Math.hypot(out[out.length - 1].x - out[out.length - 2].x, out[out.length - 1].z - out[out.length - 2].z) < 0.02) out.splice(out.length - 2, 1);
    return out.length > 1 ? out : null;
  };
  const { graph } = ctx;
  const W = ctx.sim.world;
  const top = new MeshBuilder(), paint = new MeshBuilder(), under = new MeshBuilder(), piers = new MeshBuilder();
  const barrier = new MeshBuilder(), kerb = new MeshBuilder();
  const DECK = 0x2a2d31, SLAB = 0xb4b2ab, BAR = 0xc9c7c0, EDGE = 0xa9a7a0;
  const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; };
  const deckRGB = new THREE.Color(DECK).toArray(), slabRGB = new THREE.Color(SLAB).toArray();
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
    // Not on the walls down a ramp's sides: it takes a face for the outside of a solid, and a car came at the other.
    const desc = (group === GROUP.RAMP ? RAPIER.ColliderDesc.trimesh(v, idx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES) : RAPIER.ColliderDesc.trimesh(v, idx))
      .setCollisionGroups(groups(group, 0xFFFF));
    // The crash barriers nearly frictionless, whatever touches them: "I want it so there's not much friction,
    // so you can kind of scrape along the crash barrier."
    if (group === GROUP.BUILDING) desc.setFriction(0.02).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    else desc.setFriction(0.9);
    return W.createCollider(desc);
  };
  // Is (x, z), on the edge of `e`, out on another raised road's deck at the same height? The wall follows the outside
  // of all the decks together, so the edge of one lying on another has none. Asked of every other raised road: the
  // wall was pieced together from what each knew of the roads at its own ends, and where a slip road joins it was
  // ends and overlaps -- "can you just see the inconsistency with like the wall there? ... I really wish it would
  // be a smooth wall".
  const raisedBoxes = graph.edges.filter((o) => o.elevated).map((o) => {
    const b = { o, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const q of o.points) { b.x0 = Math.min(b.x0, q.x - 20); b.x1 = Math.max(b.x1, q.x + 20); b.z0 = Math.min(b.z0, q.z - 20); b.z1 = Math.max(b.z1, q.z + 20); }
    return b;
  });
  const coverNear = new Map();
  const covered = (e, x, z) => {
    let list = coverNear.get(e);
    if (!list) {
      const m = raisedBoxes.find((q) => q.o === e);
      list = raisedBoxes.filter((q) => q.o !== e && q.x0 < m.x1 && q.x1 > m.x0 && q.z0 < m.z1 && q.z1 > m.z0);
      coverNear.set(e, list);
    }
    for (const { o, x0, x1, z0, z1 } of list) {
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      let d = Infinity;
      for (const sg of o.segs) d = Math.min(d, closestOnSegment(x, z, sg.a.x, sg.a.z, sg.b.x, sg.b.z).dist);
      if (d > o.width * 0.5 + 0.28) continue;
      if (Math.abs(graph.levelOn(o, x, z) - graph.levelOn(e, x, z)) < 1.5) return true;
    }
    return false;
  };
  // Where along `e`, in metres, its edge on side `sg` is an outside edge: [[d0, d1], ...], to 5 cm.
  const freeRuns = (e, sg, from, to) => {
    const off = e.width * 0.5 + 0.3;
    const cov = (d) => { const q = pointAlong(e, d); return covered(e, q.x - q.tz * sg * off, q.z + q.tx * sg * off); };
    const out = [];
    let was = cov(from), start = was ? null : from, last = from;
    for (let d = Math.min(to, from + 1); ; d = Math.min(to, d + 1)) {
      const c = cov(d);
      if (c !== was) {
        let a = last, b = d;
        while (b - a > 0.05) { const m = (a + b) / 2; if (cov(m) === was) a = m; else b = m; }
        if (c) { if (a - start > 0.3) out.push([start, a]); start = null; } else start = b;
        was = c;
      }
      last = d;
      if (d >= to) break;
    }
    if (start !== null && to - start > 0.3) out.push([start, to]);
    return out;
  };
  ctx.jumps = planJumps(graph);
  // The wall's lines as the roads' edges give them, joined end to end below.
  const wallLines = [];
  for (const e of graph.edges) {
    if (!e.elevated) continue;
    const half = e.width * 0.5;
    const yOf = (x, z) => graph.levelOn(e, x, z);
    // A point every 5 m, as its heights are: the motorway's straights were drawn from their two ends, 189 m
    // apart, and its deck and barriers ran straight while the road's height curved -- 2.5 m out at the worst,
    // a barrier down inside the deck, and a car off the edge (tests/deckgaps.js deckError).
    const line5 = [e.points[0]];
    for (let k = 0; k < e.points.length - 1; k++) {
      const p = e.points[k], q = e.points[k + 1], m = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 5));
      for (let j = 1; j <= m; j++) line5.push({ x: lerp(p.x, q.x, j / m), z: lerp(p.z, q.z, j / m) });
    }
    // The deck's surface, and its collider.
    let s0 = top.vertexCount;
    top.addRibbon(line5, e.width + 1.2, 0, DECK);
    lift(top, s0, yOf);
    const c = colliderFrom(top, s0, GROUP.RAMP);
    if (c) ctx.decks.add(c.handle);
    // The slab's underside.
    s0 = under.vertexCount;
    under.addRibbon(line5, e.width + 1.2, -1.4, SLAB);
    lift(under, s0, yOf);
    // Barriers, both sides, all the way -- open only on the side another raised road leaves from, for as far
    // as the two run side by side; and on a ramp, not down where it is still on the ground. They used to stop
    // 40 m short of every junction with a third road, both sides, which on the expressway and the ring was an
    // 80 m stretch of open edge at every slip road.
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    // How far along it is still within 0.35 m of the ground (a ramp's foot): no barrier there. (It was 0.8 m: a
    // civilian pulling over for a siren went over the lip and could not get back on.)
    let lowFrom = 0, lowTo = e.length;
    if (e.kind === 'ramp') {
      const footAtA = !a.elevated;
      const S = e.deck.s, Y = e.deck.y;
      for (let k = 0; k < S.length; k++) {
        const pk = pointAlong(e, S[k]);
        if (Y[k] - ctx.at(pk.x, pk.z) < 0.35) { if (footAtA) lowFrom = S[k]; else { lowTo = Math.min(lowTo, S[k]); break; } }
      }
    }
    // A pale concrete edge strip each side under the barrier, and the slab's edge down 1.4 m -- each side only
    // where its barrier is: where a ramp still runs with the motorway, both used to be drawn across the
    // motorway's own deck, and the ramp looked to begin before it came off ("the road should start where it
    // comes off, not like before it starts coming off").
    const sides = new Map([1, -1].map((sg) => [sg, freeRuns(e, sg, 0, e.length)]));
    for (const sg of [1, -1]) {
      for (const [d0, d1] of sides.get(sg)) {
        // Not where it lies on the ground: a pale kerb across every street it runs flush with.
        const f0 = Math.max(lowFrom, d0), f1 = Math.min(lowTo, d1);
        if (f1 - f0 < 0.3) continue;
        const side = slice5(line5, f0, f1);
        if (!side || side.length < 2) continue;
        s0 = kerb.vertexCount;
        kerb.addRibbon(side, 1.0, 0.1, EDGE, sg * (half + 0.1));
        lift(kerb, s0, yOf);
        s0 = under.vertexCount;
        under.addWall(side, -1.4, 0.1, SLAB, sg * (half + 0.6));
        lift(under, s0, yOf);
        // The wall along it, but for the stretches to jump off, its ends there turned out away from the road.
        const cuts = ctx.jumps.filter((j) => j.edge === e && j.side === sg && j.s > f0 && j.s < f1);
        let from = f0;
        for (const j of [...cuts, null]) {
          const to = j ? j.s - j.len / 2 : f1, flareA = from > f0, flareB = !!j;
          const part = to - from > 1 ? slice5(line5, from, to) : null;
          if (j) from = j.s + j.len / 2;
          if (!part || part.length < 2) continue;
          wallLines.push(part.map((q, k) => {
            const p = part[Math.max(0, k - 1)], r = part[Math.min(part.length - 1, k + 1)], l = Math.hypot(r.x - p.x, r.z - p.z) || 1;
            const near = Math.min(flareA ? k : 9, flareB ? part.length - 1 - k : 9);
            const o = half + 0.3 + (near === 0 ? 1.2 : near === 1 ? 0.35 : 0);
            const x = q.x - (r.z - p.z) / l * sg * o, z = q.z + (r.x - p.x) / l * sg * o;
            return { x, y: yOf(x, z), z };
          }));
        }
        // Red and white along the edge where there is none.
        for (const j of cuts) {
          for (let d = j.s - j.len / 2; d < j.s + j.len / 2 - 0.5; d += 2) {
            const bit = slice5(line5, d, Math.min(d + 2, j.s + j.len / 2));
            if (!bit || bit.length < 2) continue;
            s0 = kerb.vertexCount;
            kerb.addRibbon(bit, 0.9, 0.115, Math.round((d - j.s) / 2) & 1 ? 0xb3261e : 0xe8e6df, sg * (half + 0.1));
            lift(kerb, s0, yOf);
          }
        }
      }
    }
    // Markings: a white line along each edge of every raised road, and its lanes dashed. "You can almost see
    // the road, but it has no like edges on it": the deck was a dark sheet as dark as the streets under it,
    // with nothing to say where it stopped.
    // Each stops where the barrier on its side opens, and the lanes where either does: across a junction's
    // mouth they ran on over the other road's deck.
    s0 = paint.vertexCount;
    for (const sg of [1, -1]) {
      for (const [d0, d1] of sides.get(sg)) {
      const ln = slice5(line5, d0, d1);
      if (!ln || ln.length < 2) continue;
      // Broken where it lies on a street: the lines ran across its carriageway.
      let run = [];
      const flush = () => { if (run.length > 1) paint.addRibbon(run, 0.22, 0.04, PALETTE.marking, sg * (half - 0.5)); run = []; };
      for (let k = 0; k < ln.length; k++) {
        const q = ln[k], r = ln[Math.min(k + 1, ln.length - 1)], o = ln[Math.max(0, k - 1)], l = Math.hypot(r.x - o.x, r.z - o.z) || 1;
        const ex = q.x - (r.z - o.z) / l * sg * (half - 0.5), ez = q.z + (r.x - o.x) / l * sg * (half - 0.5);
        if (yOf(q.x, q.z) - ctx.at(q.x, q.z) < 0.4 && ctx.streetSurfAt(ex, ez) === SURF_ROAD) flush(); else run.push(q);
      }
      flush();
      }
    }
    // The lanes stop only where this road ends into another -- open both sides, as the expressway at the ring
    // -- and carry on past a slip road joining one side (they stopped there too, for the length of the merge).
    const endsIn = (n, atA) => {
      if (approachesAt(graph, n).some((ap) => ap.edge !== e && ap.edge.kind === e.kind && ap.edge.elevated)) return 0;
      const on = (sg) => { const r = sides.get(sg); return r.length ? (atA ? r[0][0] : e.length - r[r.length - 1][1]) : e.length; };
      return Math.min(on(1), on(-1), e.length * 0.45);
    };
    const mid = slice5(line5, endsIn(a, true), e.length - endsIn(b, false));
    if (mid && mid.length > 1) {
      // Two yellow lines down the middle, and the lanes each side of them dashed (roadgraph.js LANES). It was three lanes
      // across the whole of it, and the traffic both ways in the one in the middle.
      for (const off of LANE_LINES[e.kind] || []) for (const sg of [1, -1]) paint.addDashedRibbon(mid, 0.24, 0.04, PALETTE.marking, 4, 9, off * sg);
      if (LANE_LINES[e.kind]) for (const sg of [1, -1]) paint.addRibbon(mid, 0.2, 0.04, 0xd9a514, 0.32 * sg);
    }
    lift(paint, s0, yOf);
    // A raised road low over the ground is solid to it: walls down both its sides while there is no room to drive
    // under it, and one across where there begins to be. It was a surface and two barriers and nothing else --
    // "my car kind of phased through", from the side, and "if I try to go underneath it, I can just phase
    // straight through. It needs to stop me".
    {
      const HEAD = 3.8;                     // deck over ground: 1.4 of slab and 2.4 to drive under
      const info = line5.map((p) => { const y = yOf(p.x, p.z); return { p, y, g: ctx.at(p.x, p.z), lift: y - ctx.at(p.x, p.z) }; });
      const nrm = (k) => { const p = line5[Math.max(0, k - 1)], q = line5[Math.min(line5.length - 1, k + 1)], l = Math.hypot(q.x - p.x, q.z - p.z) || 1; return { x: -(q.z - p.z) / l, z: (q.x - p.x) / l }; };
      const quad = (A, B, n) => {
        // A, B: { x, z, lo, hi }
        for (const v of [[A.x, A.lo, A.z], [B.x, B.lo, B.z], [B.x, B.hi, B.z], [A.x, A.lo, A.z], [B.x, B.hi, B.z], [A.x, A.hi, A.z]]) {
          under.pos.push(v[0], v[1], v[2]); under.norm.push(n.x, 0, n.z); under.col.push(...slabRGB);
        }
      };
      const w0 = under.vertexCount;
      for (let k = 0; k < line5.length - 1; k++) {
        const A = info[k], B = info[k + 1];
        const lowA = A.lift > 0.3 && A.lift < HEAD, lowB = B.lift > 0.3 && B.lift < HEAD;
        if (!lowA && !lowB) continue;
        const na = nrm(k), nb = nrm(k + 1);
        for (const sg of [1, -1]) {
          const o = sg * (half + 0.6);
          const at = (I, n) => ({ x: I.p.x + n.x * o, z: I.p.z + n.z * o, lo: I.g - 1.2, hi: I.y + 0.1 });
          quad(at(A, na), at(B, nb), { x: na.x * sg, z: na.z * sg });
        }
      }
      for (let k = 0; k < line5.length - 1; k++) {
        const A = info[k], B = info[k + 1];
        if ((A.lift < HEAD) === (B.lift < HEAD)) continue;
        const I = A.lift < HEAD ? A : B, kk = A.lift < HEAD ? k : k + 1, n = nrm(kk), o = half + 0.6;
        if (I.lift < 0.3) continue;
        const out1 = A.lift < HEAD ? 1 : -1;
        quad({ x: I.p.x + n.x * o, z: I.p.z + n.z * o, lo: I.g - 1.2, hi: I.y - 0.05 }, { x: I.p.x - n.x * o, z: I.p.z - n.z * o, lo: I.g - 1.2, hi: I.y - 0.05 }, { x: n.z * out1, z: -n.x * out1 });
      }
      colliderFrom(under, w0, GROUP.BUILDING);
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
      // Solid, as its legs are: on sloping ground its low end came down to a car's height, and a car went through it.
      addStaticBox(W, p.x, yd - 2, p.z, e.width / 2 + 0.3, 0.5, 0.9, GROUP.BUILDING, rot);
    }
  }
  // Where a road carries on through a joint it turns a little, and its two pieces, each cut square, leave a wedge
  // open on the outside of the turn: the deck filled there, and the barrier carried across it.
  for (const n of graph.nodes) {
    if (!n.elevated) continue;
    const app = approachesAt(graph, n).filter((ap) => ap.edge.elevated);
    for (let i = 0; i < app.length; i++) {
      for (let j = i + 1; j < app.length; j++) {
        const A = app[i], B = app[j];
        if (A.edge.kind !== B.edge.kind || A.dir.x * B.dir.x + A.dir.z * B.dir.z > -0.74) continue;
        for (const side of [1, -1]) {
          const at = (ap, sx, off) => ({ x: n.x - sx * ap.dir.z * side * off, z: n.z + sx * ap.dir.x * side * off });
          const pa = at(A, 1, A.half + 0.6), pb = at(B, -1, B.half + 0.6);
          if ((pa.x - pb.x) * A.dir.x + (pa.z - pb.z) * A.dir.z < 0.02) continue;      // the inside: they overlap
          const cr = (pa.x - n.x) * (pb.z - n.z) - (pa.z - n.z) * (pb.x - n.x);
          const w0 = top.vertexCount;
          for (const v of cr < 0 ? [n, pa, pb] : [n, pb, pa]) { top.pos.push(v.x, n.y, v.z); top.norm.push(0, 1, 0); top.col.push(...deckRGB); }
          const c = colliderFrom(top, w0, GROUP.RAMP);
          if (c) ctx.decks.add(c.handle);
        }
      }
    }
  }
  // The lines joined end to end, nearest ends first, into walls that run on -- round the ring, down a slip road --
  // and each made as one solid. In pieces a car sliding along one caught where the next began, and on the edges
  // between a piece's own triangles ("I just hit almost an invisible little, a tiny almost joint, and then I just
  // like went 100% damage"): 418 of 502 slides at 180 km/h wrecked it (tests/scrape.js).
  const ends = [];
  wallLines.forEach((l, k) => { ends.push({ k, at: 0, p: l[0] }, { k, at: 1, p: l[l.length - 1] }); });
  const pairs = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const p = ends[i].p, q = ends[j].p, d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < 3.4 && Math.abs(p.y - q.y) < 1) pairs.push({ i, j, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const link = new Array(ends.length).fill(-1);
  const dirOut = (en) => {
    const l = wallLines[en.k], a = en.at ? l[l.length - 2] : l[1], L = Math.hypot(en.p.x - a.x, en.p.z - a.z) || 1;
    return { x: (en.p.x - a.x) / L, z: (en.p.z - a.z) / L };
  };
  for (const { i, j, d } of pairs) {
    if (link[i] !== -1 || link[j] !== -1) continue;
    const u = dirOut(ends[i]), v = dirOut(ends[j]);
    const back = u.x * v.x + u.z * v.z > 0.5;
    if (back && d > 1.5) continue;
    if (d < 0.5 || back) {
      const mx = (ends[i].p.x + ends[j].p.x) / 2, mz = (ends[i].p.z + ends[j].p.z) / 2, my = (ends[i].p.y + ends[j].p.y) / 2;
      for (const en of [ends[i], ends[j]]) { en.p.x = mx; en.p.z = mz; en.p.y = my; }
    }
    // Not on round a hairpin: at the point between a slip road and the motorway the two walls meet and stop.
    if (back) { link[i] = -2; link[j] = -2; } else { link[i] = j; link[j] = i; }
  }
  const usedLine = new Set(), chains = [];
  const walk = (k0, enterAt) => {
    const pts = [];
    let k = k0, en = enterAt, closed = false;
    for (;;) {
      usedLine.add(k);
      pts.push(...(en === 0 ? wallLines[k] : wallLines[k].slice().reverse()));
      const j = link[k * 2 + (en === 0 ? 1 : 0)];
      if (j < 0) break;
      const nk = ends[j].k;
      if (nk === k0) { closed = true; break; }
      if (usedLine.has(nk)) break;
      k = nk; en = ends[j].at;
    }
    chains.push({ pts, closed });
  };
  for (let k = 0; k < wallLines.length; k++) if (!usedLine.has(k) && link[k * 2] < 0) walk(k, 0);
  for (let k = 0; k < wallLines.length; k++) if (!usedLine.has(k) && link[k * 2 + 1] < 0) walk(k, 1);
  for (let k = 0; k < wallLines.length; k++) if (!usedLine.has(k)) walk(k, 0);
  ctx.walls = [];
  const barRGB = new THREE.Color(BAR).toArray();
  for (const { pts, closed } of chains) {
    // Nothing nearer than 0.6 m to the last, and no step back on itself.
    let P = [];
    for (const q of pts) {
      const l = P[P.length - 1], m = P[P.length - 2];
      if (l && Math.hypot(q.x - l.x, q.z - l.z) < 0.6) continue;
      if (m && (l.x - m.x) * (q.x - l.x) + (l.z - m.z) * (q.z - l.z) < 0) P.pop();
      P.push(q);
    }
    if (closed && P.length > 3 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].z - P[P.length - 1].z) < 0.6) P.pop();
    if (P.length < 2) continue;
    // A point every 2.5 m, and its line rounded off, nowhere moved over 0.3 m: the ring's corners turned 5 degrees at
    // a time, every 26 m, and at 180 km/h each was a knock. (Up to 3 m on to the road, to ease the 25-degree turn
    // where a slip road's wall meets the motorway's, left three slip roads undriveable.)
    {
      const R0 = closed ? [...P, P[0]] : P, Q = [];
      for (let k = 0; k < R0.length - 1; k++) {
        const a = R0[k], b = R0[k + 1], m = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2.5));
        for (let t = 0; t < m; t++) Q.push({ x: lerp(a.x, b.x, t / m), y: lerp(a.y, b.y, t / m), z: lerp(a.z, b.z, t / m) });
      }
      if (!closed) Q.push(R0[R0.length - 1]);
      const N = Q.length;
      let cur = Q.map((q) => ({ ...q }));
      for (let it = 0; it < 24; it++) {
        const nx = cur.map((q, k) => {
          if (!closed && (k === 0 || k === N - 1)) return q;
          const a = cur[(k - 1 + N) % N], b = cur[(k + 1) % N], o = Q[k];
          let x = q.x + ((a.x + b.x) / 2 - q.x) * 0.6, z = q.z + ((a.z + b.z) / 2 - q.z) * 0.6;
          const d = Math.hypot(x - o.x, z - o.z);
          if (d > 0.3) { x = o.x + (x - o.x) * 0.3 / d; z = o.z + (z - o.z) * 0.3 / d; }
          return { x, y: q.y, z };
        });
        cur = nx;
      }
      P = cur;
    }
    const n = P.length, T = 0.2, H = 1.05;
    const V = new Float32Array(n * 12);
    for (let k = 0; k < n; k++) {
      const a = P[closed ? (k - 1 + n) % n : Math.max(0, k - 1)], b = P[closed ? (k + 1) % n : Math.min(n - 1, k + 1)], p = P[k];
      let d1x = p.x - a.x, d1z = p.z - a.z, d2x = b.x - p.x, d2z = b.z - p.z;
      const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
      if (l1 < 1e-6) { d1x = d2x / l2; d1z = d2z / l2; } else { d1x /= l1; d1z /= l1; }
      if (l2 < 1e-6) { d2x = d1x; d2z = d1z; } else { d2x /= l2; d2z /= l2; }
      let mx = -d1z - d2z, mz = d1x + d2x;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const w = T * Math.min(1.6, 1 / Math.max(0.5, mx * -d1z + mz * d1x));
      V.set([p.x + mx * w, p.y - 0.15, p.z + mz * w, p.x + mx * w, p.y + H, p.z + mz * w,
        p.x - mx * w, p.y + H, p.z - mz * w, p.x - mx * w, p.y - 0.15, p.z - mz * w], k * 12);
    }
    const at = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const A = k * 4, B = ((k + 1) % n) * 4, p = P[k], p2 = P[(k + 1) % n];
      for (let f = 0; f < 4; f++) {
        const f2 = (f + 1) % 4;
        if (f === 3) continue;                    // its underside is not seen
        const q0 = at(A + f), q1 = at(B + f), q2 = at(B + f2), q3 = at(A + f2);
        const e1 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]], e2 = [q3[0] - q0[0], q3[1] - q0[1], q3[2] - q0[2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        // Out from the wall's middle.
        const gx = (q0[0] + q1[0] + q2[0] + q3[0]) / 4 - (p.x + p2.x) / 2, gy = (q0[1] + q1[1] + q2[1] + q3[1]) / 4 - (p.y + p2.y) / 2 - H / 2,
          gz = (q0[2] + q1[2] + q2[2] + q3[2]) / 4 - (p.z + p2.z) / 2;
        const flip = nx * gx + ny * gy + nz * gz < 0;
        const nl = (Math.hypot(nx, ny, nz) || 1) * (flip ? -1 : 1);
        nx /= nl; ny /= nl; nz /= nl;
        for (const q of flip ? [q0, q2, q1, q0, q3, q2] : [q0, q1, q2, q0, q2, q3]) { barrier.pos.push(...q); barrier.norm.push(nx, ny, nz); barrier.col.push(...barRGB); }
      }
    }
    if (!closed) {
      const L = (n - 1) * 4;
      for (const c of [0, L]) {
        const o = c === 0 ? { x: P[0].x - P[1].x, z: P[0].z - P[1].z } : { x: P[n - 1].x - P[n - 2].x, z: P[n - 1].z - P[n - 2].z };
        const ol = Math.hypot(o.x, o.z) || 1;
        for (const i of [0, 1, 2, 0, 2, 3]) { barrier.pos.push(...at(c + i)); barrier.norm.push(o.x / ol, 0, o.z / ol); barrier.col.push(...barRGB); }
      }
    }
    // What cars hit is not that mesh. A car sliding along a mesh catches the edges between its triangles whatever
    // is asked of the engine (FIX_INTERNAL_EDGES as well): 5 mm off the wall, the next triangle's edge stopped it
    // dead from 47 m/s. It is blocks, each as long as the wall runs straight to 3 cm, and each run on a little
    // past its ends with its faces tapered in, so where one gives over to the next there is no edge to meet.
    const R = closed ? [...P, P[0]] : P;
    const keepPt = new Uint8Array(R.length);
    keepPt[0] = keepPt[R.length - 1] = 1;
    const split = (a, b) => {
      let worst = 0, w = -1;
      const A = R[a], B = R[b], dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz || 1;
      for (let k = a + 1; k < b; k++) {
        const u = ((R[k].x - A.x) * dx + (R[k].z - A.z) * dz) / l2;
        const e2 = Math.max(Math.hypot(A.x + dx * u - R[k].x, A.z + dz * u - R[k].z), Math.abs(lerp(A.y, B.y, clamp(u, 0, 1)) - R[k].y) / 5);
        if (e2 > worst) { worst = e2; w = k; }
      }
      if (worst > 0.03) { keepPt[w] = 1; split(a, w); split(w, b); }
    };
    if (closed) { const m = R.length >> 1; keepPt[m] = 1; split(0, m); split(m, R.length - 1); } else split(0, R.length - 1);
    const K = R.filter((_, k) => keepPt[k]);
    for (let k = 0; k < K.length - 1; k++) {
      const A = K[k], B = K[k + 1], L = Math.hypot(B.x - A.x, B.z - A.z);
      if (L < 0.05) continue;
      const dx = (B.x - A.x) / L, dz = (B.z - A.z) / L, gr = (B.y - A.y) / L;
      const open0 = !closed && k === 0, open1 = !closed && k === K.length - 2;
      // Where the next turns away its run-on stuck out of that one's face; so there its face is brought in along the
      // next one's own, 2 cm under it, and what a car meets is always one wall's face or the other's.
      const cross = (C, D, sign) => {
        if (!C || !D) return 0;
        const l = Math.hypot(D.x - C.x, D.z - C.z) || 1, ux = (D.x - C.x) / l, uz = (D.z - C.z) / l;
        return sign > 0 ? ux * dz - uz * dx : dx * uz - dz * ux;
      };
      const M = K.length - 1;
      const c0 = open0 ? 0 : cross(K[k > 0 ? k - 1 : M - 1], K[k > 0 ? k : M], 1), c1 = open1 ? 0 : cross(K[k + 1 < M ? k + 1 : 0], K[k + 1 < M ? k + 2 : 1], -1);
      const ov0 = Math.min(2, 0.3 / Math.max(1e-3, Math.abs(c0))), ov1 = Math.min(2, 0.3 / Math.max(1e-3, Math.abs(c1)));
      const tip = (sd, cr, ov) => (sd === -Math.sign(cr) ? T - ov * Math.abs(cr) - 0.02 : T - 0.02);
      const pts3 = [];
      for (const [d, tp, tm] of [[-ov0, tip(1, c0, ov0), tip(-1, c0, ov0)], [0, T, T], [L, T, T], [L + ov1, tip(1, c1, ov1), tip(-1, c1, ov1)]]) {
        if ((d < 0 && open0) || (d > L && open1)) continue;
        for (const [sd, t] of [[1, tp], [-1, tm]]) for (const h of [-0.3, H + 0.25]) pts3.push(A.x + dx * d - dz * t * sd, A.y + gr * d + h, A.z + dz * d + dx * t * sd);
      }
      const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts3));
      if (!hull) continue;
      W.createCollider(hull.setCollisionGroups(groups(GROUP.BUILDING, 0xFFFF))
        // Nearly frictionless, whatever touches it: "I want it so there's not much friction, so you can kind of
        // scrape along the crash barrier."
        .setFriction(0.02).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min));
      ctx.wallBlocks = (ctx.wallBlocks || 0) + 1;
    }
    ctx.walls.push({ n, closed, ends: closed ? null : [P[0], P[n - 1]] });
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
    const c = chunkMesh(m, 300);
    if (name === 'decks') trueDepth(c, DRAW_ORDER.tarmac + 0.5);
    if (name === 'deck-markings') c.traverse((o) => { if (o.isMesh) o.renderOrder = DRAW_ORDER.tarmac + 0.6; });
    out.push(c);
  };
  // Pulled forward in depth, but less than the streets (-3, -6, liftRoads): where a ramp's foot lies on the street
  // it meets the street wins, and over the grass the ramp does. It was pushed back instead, for the first of
  // those, and at a shallow angle the ground a few centimetres under it won: "it shows green grass ... as I get
  // closer, it then turns to tarmac ... it just keeps on going further away".
  mk(top, 'decks', { polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 }, 'tarmac');
  mk(paint, 'deck-markings', { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, depthWrite: false });
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
  let n = 0, run = null;
  const runs = [];
  for (let i = 0; i < GX.length - 1; i++) {
    for (let j = 0; j < GZ.length - 1; j++) {
      // A little off the block's middle: the streets' 40 m pieces put a point at exactly the middle, and a crossing
      // exactly on a point is not found -- 104 alley junctions were left joined to nothing.
      const x = (GX[i] + GX[i + 1]) / 2 + 1.7, z0 = GZ[j], z1 = GZ[j + 1];
      if (dtDist(x, (z0 + z1) / 2) > DT_R - 70) continue;
      if (GX[i + 1] - GX[i] < 55) continue;
      if (hash(i, j, 41) > 0.5) continue;
      if (ctx.carPark && Math.abs(x - ctx.carPark.x) < 50 && Math.abs((z0 + z1) / 2 - ctx.carPark.z) < 50) continue;
      if (inChannel(x, z0, 20) || inChannel(x, z1, 20)) continue;
      // A street at both ends to join: where one had been thinned out, the alley joined nothing there, and a
      // dozen alleys' junctions were cut off from the network -- somewhere a car could be put and not leave.
      const streetAt = (zz) => graph.edges.some((e) => !e.elevated && e.points.some((p, k) => k < e.points.length - 1
        && closestOnSegment(x, zz, p.x, p.z, e.points[k + 1].x, e.points[k + 1].z).dist < 2.5));
      if (!streetAt(z0) || !streetAt(z1)) continue;
      // Joined to the alley in the block before it, if there is one, as one road: two alleys meeting a street
      // from either side crossed it at the same spot, the stitching kept only the first cut, and the second
      // alley was joined to nothing (10 alley junctions cut off).
      if (run && run.i === i && run.j === j - 1) { run.z1 = z1; run.j = j; continue; }
      if (run) runs.push(run);
      run = { i, j, x, z0, z1 };
    }
  }
  if (run) runs.push(run);
  for (const r of runs) {
    const a = graph.addNode(r.x, r.z0 - 2, 'alley'), b = graph.addNode(r.x, r.z1 + 2, 'alley');
    // A point every 20 m: the stitching finds crossings in 60 m cells by where each piece starts, and a 69 m
    // alley in one piece never met the street at its far end (19 alleys crossing a street with no junction).
    const L = r.z1 - r.z0 + 4, k = Math.ceil(L / 20), mid = [];
    for (let m = 1; m < k; m++) mid.push({ x: r.x, z: r.z0 - 2 + L * m / k });
    const e = graph.addEdge(a, b, 'alley', mid.length ? mid : null);
    if (e) n++;
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
        // Let down further in the coarse one, which cuts its corners by more (18 places over a road, tests/farground.js).
        const m = buildTerrainMesh(hgrid, colour, step, step > 5 ? (x, z) => nearRoad(x, z) * 1.8 : nearRoad, 0, patch);
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
    liftMesh(m, ctx.at, LIFT);
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
      // Sloped as the bridge is: level, its low end stood up out of the road it lay under by 17 cm, unseen.
      {
        const pitch = Math.atan2(hb - ha, len), qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
        qy.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch));
        const body = W.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y - 0.86, z).setRotation({ x: qy.x, y: qy.y, z: qy.z, w: qy.w }));
        W.createCollider(RAPIER.ColliderDesc.cuboid(hw + 0.2, 0.7, L / 2).setFriction(0.9).setCollisionGroups(groups(GROUP.TERRAIN, 0xFFFF)), body);
      }
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
