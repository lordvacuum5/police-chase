// Wexbury, rebuilt: a market town on hills, 3 km across, as big as Ashfield City.
//
// "How I want to think of like almost a full remake, just like the American map of the UK map ... maybe put water in it,
// maybe train." Then, of the ideas: a railway with level crossings whose barriers come down (no station); a canal with
// towpaths, humpback bridges and locks; a ford; the market square with stalls on market days; terraced streets with back
// alleys behind them; mini, double and "magic" roundabouts; speed bumps, width restrictions and bus lanes; the bypass with
// laybys; a road climbing a hill to a view back over the town; police that know the shortcuts. "Make it a bit hilly. Just
// make it really good ... Try to make sure it doesn't lag."
//
// The town is the old Wexbury's plan grown out: a crooked core round the market square, ring streets at odd radii joined
// only in places, A-roads curving out to the edge, estates of crescents and closes, the bypass round one side joined by
// roundabouts, lanes between the villages. The railway and the canal are laid across it after the core and the A-roads,
// and every road that met them at a bad angle, too near a junction or running along beside them is taken out: that is how
// a railway cuts a town in two. The ground is Haldon Vale's (world/terrain.js), damped in the town; the railway and its
// train are Haldon's (world/countryextras.js); the water is Ashfield's.

import * as THREE from 'three';
import { addWindows, litWindows } from './windows.js';
import { planDrive, layDrives } from './drives.js';
import { chunkMesh } from './chunks.js';
import { drawTree, treeDetail, chunkTrees, lowTrees } from './trees.js';
import { buildingDetail } from './buildtex.js';
import { groundDetail } from './groundtex.js';
import { RoadGraph, ROAD_KIND, DRIVE_SIDE } from './roadgraph.js';
import { approachesAt, addNodeWedges } from './junctions.js';
import { GROUP, addStaticBox, addCanopy, nearBuilding, EDGE_FACE } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, TAU, smoothstep } from '../util/math.js';
import {
  WORLD_HALF, CELL, GRID_N, KERB_H, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, makeHeightAt, DRAW_ORDER,
  buildGround, buildRoadMeshes, MeshBuilder, vertexColorMaterial, LIFT, ROAD_OVER, PAVE_OVER, trueDepth,
} from './common.js';
import { baseRelief, buildHeightGrid, addHeightfield, buildTerrainMesh, liftMesh, H_STEP } from './terrain.js';
import { spline, segX } from './countrygen.js';
import { makeClearMask, markLine, railGround, buildRailTrack, Railway } from './countryextras.js';
import { rippleNormals } from './citygen.js';

const RINGS = [85, 180, 290, 410, 540, 700];
const RING_NODES = [8, 12, 16, 22, 28, 34];
const TOWN_EDGE = 780;
const BYPASS_R = 940;
/** The market square, paved, m. */
const SQUARE_R = 50;
/** The canal: water half-width, m; the towpath's middle out from the canal's; the water under the towpath; a pound's length. */
/** Half a lock's length, gate to gate, m. */
const LOCK_HALF = 9;
/**
 * The river, where the canal was: "can you put a river where the canal was, going all the way along ... with a nice bridge, a
 * nice textured proper bridge going over it, and same with the train line". A valley CANAL_W either side of its line, CANAL_D
 * deep at the middle under its banks, the water WATER_DOWN under the banks; a cosine, so the banks leave the fields with no edge.
 * CANAL_HALF is how far out the water reaches. (The names are the canal's; it was taken out: "Just remove canals".)
 */
const CANAL_W = 26, CANAL_D = 4.5, WATER_DOWN = 1.5, POUND = 420;
const CANAL_HALF = CANAL_W * Math.acos(2 * WATER_DOWN / CANAL_D - 1) / Math.PI;
const TOW_OFF = CANAL_W + 3.5;
/** How far down the valley is under the bank at `d` m from the line. */
const dipAt = (d) => (d >= CANAL_W ? 0 : CANAL_D * 0.5 * (1 + Math.cos(Math.PI * d / CANAL_W)));
/** The river's fall at the most, m a metre, and how far either side its level is averaged over, m. */
const RIVER_FALL = 0.004, RIVER_SMOOTH = 160;
/** The banks drawn level either side, out this far from the canal's middle, m. */
const BANK_OUT = TOW_OFF + 4;
/** A humpback bridge over the canal: how high, and half its length, m. */
const HUMP_H = 1.5, HUMP_LEN = 11;
/** The ford: how far the lane dips, and the water over its lowest point, m. */
const FORD_DIP = 1.5, FORD_DEEP = 0.32;
/** Speed bumps: how high, and half their length along the road, m. */
// Lower and longer than they were (0.1 m over 3.2), and half as many: "the car feels a little bit like juddery". On the streets a car
// was shaken 1.01 m/s2 rms with them and 0.46 without (tests/shake.js; Ashfield's streets 0.06).
const BUMP_H = 0.08, BUMP_HALF = 2.0;
/** Bits of the clear mask (countryextras makeClearMask). */
const CLEAR_RAIL = 1, CLEAR_CANAL = 2;

export function buildWexbury(sim, scene, seed = 51807) {
  const rng = makeRng(seed);
  const graph = new RoadGraph(48);
  const surface = new Uint8Array(GRID_N * GRID_N);
  const H = WORLD_HALF;
  const ctx = { sim, scene, rng, graph, surface, lrng: makeRng(seed + 777), xrng: makeRng(seed + 7919), props: [] };

  // The hills first: the railway and the canal keep off the big one, and a road climbs it.
  const hills = [
    // Broad rather than sharp: at r 270, h 46, with the rolling ground on top, its sides were 36%, "some very weird movement ... I
    // did hit an invisible wall ... going down. It's a really steep hill, really fast." About 16% at the steepest now.
    { name: 'Wexbury Beacon', ...polar(rng, rand(rng, 0, TAU), 1080, 1200), r: 330, h: 40 },
    { name: 'Clee Down', ...polar(rng, rand(rng, 0, TAU), 1150, 1300), r: 300, h: 30 },
    { name: 'Hob Hill', ...polar(rng, rand(rng, 0, TAU), 700, 900), r: 200, h: 18 },
    { name: 'Castle Knap', ...polar(rng, rand(rng, 0, TAU), 1250, 1350), r: 220, h: 26 },
  ];
  ctx.hills = hills;
  const relief = baseRelief(makeRng(seed + 31), { half: H, hills, scale: 1.0 });
  // Gentler in the town, the full hills beyond it.
  const base = (x, z) => relief(x, z) * lerp(0.5, 1, smoothstep(250, 900, Math.hypot(x, z)));
  ctx.base = base;

  // ---------------------------------------------------------------- the town's bones
  const rings = buildRings(ctx);
  const radials = buildRadials(ctx, rings);
  ctx.bypass = buildBypass(ctx, radials);
  // ---------------------------------------------------------------- the railway and the canal, and what they cut
  ctx.rail = planLine(ctx, 'rail', null);
  // No canal: "Just remove canals ... Can you put a lake or a river in?" A river along where it was, and a lake out in the country.
  ctx.canal = planLine(ctx, 'canal', ctx.rail);
  ctx.lake = planLake(ctx);
  cutForLines(ctx);
  // ---------------------------------------------------------------- everything else, kept off them
  buildEstates(ctx, radials);
  buildLanes(ctx, radials);
  ctx.summit = buildHillRoad(ctx, radials);
  buildAlleys(ctx, rings);
  prune(graph);
  ctx.roundabouts = buildRoundabouts(ctx);
  graph.addTurningHeads(15, 10, H - 40, (x, z, r) => nearLines(ctx, x, z, r + 10));
  prune(graph);
  graph.finalise();
  // Every road's line a point every 6 m, so it lies on the hills (as Ashfield's: citygen.js). The pieces it was in kept, for
  // what is laid along it: in 6 m pieces, the houses (spaced along each piece, none on one under 10 m) were none at all.
  for (const e of graph.edges) {
    e.coarse = e.segs.map((g) => ({ a: g.a, b: g.b, len: g.len, start: g.start }));
    const out = [e.points[0]];
    for (let k = 0; k < e.points.length - 1; k++) {
      const p = e.points[k], q = e.points[k + 1], n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 6);
      for (let m = 1; m < n; m++) out.push({ x: lerp(p.x, q.x, m / n), z: lerp(p.z, q.z, m / n) });
      out.push(q);
    }
    if (out.length !== e.points.length) graph.setEdgePoints(e, out);
  }
  graph._buildIndex();
  nameRoads(ctx);

  // ---------------------------------------------------------------- where the roads meet the lines
  const rail = ctx.rail ? finishRail(ctx) : null;
  const canal = ctx.canal ? finishCanal(ctx) : null;
  ctx.ford = pickFord(ctx);
  const crests = [...(canal ? canal.humps : [])];
  // Asked for more than it gets: the ground under a road is the mean of its long section across the road's width, and a 1.5 m
  // dip 24 m long came out 0.3 m deep.
  if (ctx.ford) crests.push({ edge: ctx.ford.edge.id, s: ctx.ford.s, len: 16, h: -FORD_DIP * 2.4 });
  ctx.bumps = pickBumps(ctx);

  // ---------------------------------------------------------------- the ground
  const flatten = [{ x: 0, z: 0, r: SQUARE_R + 20, fade: 60 }];
  if (ctx.summit) flatten.push({ x: ctx.summit.x, z: ctx.summit.z, r: 30, fade: 30 });
  for (const v of ctx.villages || []) flatten.push({ x: v.x, z: v.z, r: 60, fade: 50 });
  if (ctx.lake) flatten.push({ x: ctx.lake.x, z: ctx.lake.z, r: ctx.lake.R + 10, fade: 40, h: ctx.lake.bank });
  if (canal) for (const f of canal.discs) flatten.push(f);
  // Nothing laid over the river's valley: the roads and the railway cross it on decks (riverDecks), as Ashfield's bridges do. Laid,
  // each stood on a dam across the water.
  const inRiver = (x, z) => !!(ctx.canal && ctx.canal.near(x, z, CANAL_W + 6).d < CANAL_W + 1);
  const hgrid = buildHeightGrid(base, { half: H, graph, flatten, crests, lines: rail ? [railGround(rail)] : [],
    skipClaim: (e, x, z) => inRiver(x, z), skipLine: (x, z) => inRiver(x, z) });
  ctx.grid = hgrid;
  const water = waterGrid(hgrid);
  ctx.water = water;
  if (canal) carveCanal(ctx, canal, hgrid, water);
  if (ctx.lake) carveLake(ctx.lake, hgrid, water);
  if (ctx.ford) carveFord(ctx, ctx.ford, hgrid, water);
  addHeightfield(sim.world, hgrid);
  // The bridges' decks: where there is one, the height of anything is the deck's (as Ashfield's: citygen.js deckAt).
  const deckAt = canal ? riverDecks(ctx, canal, rail, hgrid) : () => -Infinity;
  const at = (x, z) => Math.max(hgrid.at(x, z), deckAt(x, z));
  ctx.at = at;

  // ---------------------------------------------------------------- surfaces
  makeClearMask(ctx);
  if (rail) markLine(ctx, rail.points, 15, CLEAR_RAIL);
  if (canal) markLine(ctx, canal.points, BANK_OUT + 2, CLEAR_CANAL);
  paintSurfaces(ctx);
  rasteriseRoads(graph, surface);
  // The towpath is not marked as road: the ground drawn beside a road is let down, and beyond the canal's bank on the towpath's side
  // that left a ledge the length of the canal. "On one of the sides ... there's almost a drop off."
  ctx.laybys = buildLaybyPlan(ctx);
  for (const l of ctx.laybys) for (const p of l) paintDisc(surface, p.x, p.z, 2.4, SURF_ROAD);
  if (ctx.summit) paintDisc(surface, ctx.summit.x, ctx.summit.z, 26, SURF_ROAD);
  ctx.surfAt = makeSurfaceAt(surface);
  const kerbAt = makeHeightAt(surface, PAVE_OVER, ROAD_OVER);
  const bumpAt = bumpField(ctx.bumps);
  const heightAt = (x, z) => at(x, z) + kerbAt(x, z) + bumpAt(x, z);

  // ---------------------------------------------------------------- visuals
  buildGround(ctx);          // the plate and the wall round the edge; the hills are drawn below
  const meshes = [];
  meshes.push(...buildTerrain(ctx, hgrid));
  const [tarmac, markings, kerbs, wear] = buildRoadMeshes(ctx);
  const lifted = liftRoads(ctx, [tarmac, markings, kerbs]);
  meshes.push(trueDepth(chunkMesh(lifted[0], 300), DRAW_ORDER.tarmac), chunkMesh(lifted[1], 300), trueDepth(chunkMesh(lifted[2], 300), DRAW_ORDER.tarmac + 0.3));
  if (wear) {
    liftMesh(wear, ctx.at, LIFT);
    wear.material.polygonOffsetFactor = -1;
    wear.material.polygonOffsetUnits = -2;
    meshes.push(wear.geometry.index ? wear : chunkMesh(wear, 300));
  }
  meshes.push(buildPavements(ctx));
  meshes.push(buildExtrasFlat(ctx, canal));
  if (canal) meshes.push(...buildBridges(ctx, canal));
  const placed = new Placed();
  ctx.placed = placed;
  meshes.push(...buildLandmarks(ctx));
  meshes.push(...buildFrontages(ctx));
  meshes.push(...buildFurniture(ctx, canal));
  const waterMesh = canal || ctx.ford || ctx.lake ? buildWater(ctx, canal) : null;
  if (waterMesh) meshes.push(waterMesh);
  meshes.push(...buildTrees(ctx));
  if (rail) meshes.push(buildRailTrack(ctx, rail));
  for (const m of meshes) if (m) scene.add(m);
  const railway = rail ? new Railway(ctx, rail, scene) : null;

  const inCanal = (x, z) => water.levelAt(x, z) !== null && !water.fordAt(x, z);
  return {
    graph,
    surface,
    surfaceAt: makeSurfaceAt(surface),
    heightAt,
    terrainAt: at,
    relief: hgrid.max - Math.min(0, hgrid.min) + 4,
    meshes,
    bounds: H,
    hills,
    bypass: ctx.bypass,
    parked: ctx.parked || [],
    driveStrips: ctx.driveStrips || [],
    rail,
    railway,
    clearAt: ctx.clearAt,
    // Bollards and benches to knock over (game/streetprops.js).
    props: ctx.props,
    // The canal: in it, under its surface, is in the water (main.js _checkWater, Game.waterBetween). The ford is water a car
    // wades, never deep enough to flood it, and the police drive through it as the road it is.
    inWater: (x, z, y) => inCanal(x, z) && y < water.levelAt(x, z) + 0.4,
    waterAt: (x, z) => water.levelAt(x, z),
    // What was built, for the rigs (tests/wexbury.js).
    stats: {
      buildings: ctx.buildingCount, railCrossings: rail ? rail.cross.length : 0, bridges: canal ? canal.bridges.map((q) => [Math.round(q.x), Math.round(q.z)]) : [], lockAt: canal ? canal.locks.map((l) => { const q = canal.line.at(l); return [Math.round(q.x), Math.round(q.z)]; }) : [],
      roundaboutAt: ctx.roundabouts.filter((r) => r.magic || r.double).map((r) => [Math.round(r.x), Math.round(r.z)]), locks: canal ? canal.locks.length : 0,
      lake: ctx.lake ? { x: Math.round(ctx.lake.x), z: Math.round(ctx.lake.z), R: ctx.lake.R } : null,
      ford: ctx.ford ? { x: Math.round(ctx.ford.x), z: Math.round(ctx.ford.z) } : null, roundabouts: ctx.roundabouts.map((r) => (r.magic ? 'magic' : r.inMagic ? 'magic-mini' : r.double ? 'double' : 'mini')),
      whyNot: ctx.whyNot, alleys: ctx.alleys, shops: (ctx.signs || []).slice(0, 3).map((g) => [Math.round(g.x), Math.round(g.z), +g.fx.toFixed(2), +g.fz.toFixed(2)]), bumps: ctx.bumps.length, pinches: ctx.pinches, laybys: ctx.laybys.length, marketDay: ctx.marketDay, summit: ctx.summit && { x: Math.round(ctx.summit.x), z: Math.round(ctx.summit.z) },
    },
    // More cars than the old town's 17, on half again as much road each way.
    trafficCount: 44,
    fogCull: ['roads', 'markings', 'kerbs', 'pavements', 'town', 'trees', 'road-wear', 'driveways', 'verges', 'parked', 'furniture', 'extras', 'railway'],
    update: (game, dt) => { if (waterMesh) waterMesh.userData.update(dt || 1 / 60); if (railway) railway.update(game); },
    step: (dt) => { if (railway) railway.step(dt); },
    setNight: (on) => { if (railway) railway.setNight(on); },
    stopDistanceAt: railway ? (x, z, dx, dz, v) => railway.stopDistanceAt(x, z, dx, dz, v) : null,
  };
}

function polar(rng, a, r0, r1) {
  const r = rand(rng, r0, r1);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

// =====================================================================
//  The town's bones
// =====================================================================

/** Ring streets with jittered junctions, joined across only in places; the High Street straight through. */
function buildRings(ctx) {
  const { graph, rng } = ctx;
  const rings = [];
  for (let r = 0; r < RINGS.length; r++) {
    const count = RING_NODES[r], nodes = [];
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + rand(rng, -0.09, 0.09);
      const rad = RINGS[r] + (r ? rand(rng, -22, 22) : rand(rng, -4, 4));
      nodes.push(graph.addNode(Math.cos(a) * rad, Math.sin(a) * rad, 'cross'));
    }
    const kind = r === 0 ? 'lane' : 'street';
    for (let k = 0; k < count; k++) {
      const a = nodes[k], b = nodes[(k + 1) % count];
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5, ml = Math.hypot(mx, mz) || 1, bulge = RINGS[r] * 0.035;
      graph.addEdge(a, b, kind, [{ x: mx + (mx / ml) * bulge, z: mz + (mz / ml) * bulge }]);
    }
    rings.push(nodes);
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (const n of rings[r]) {
      if (rng() < 0.32) continue;
      let best = rings[r + 1][0], bd = Infinity;
      for (const m of rings[r + 1]) { const d = dist2(n.x, n.z, m.x, m.z); if (d < bd) { bd = d; best = m; } }
      graph.addEdge(n, best, r === 0 ? 'lane' : 'street');
    }
  }
  // The High Street, and a second main street across it.
  const findOn = (ring, ang) => {
    let best = ring[0], bd = Infinity;
    for (const n of ring) {
      const d = Math.abs(Math.atan2(Math.sin(Math.atan2(n.z, n.x) - ang), Math.cos(Math.atan2(n.z, n.x) - ang)));
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const hs = rng() * TAU;
  ctx.highStreet = hs;
  // Up to the square from either side, not across it: straight through, it took the market cross with it.
  for (const a of [hs, hs + Math.PI]) graph.addEdge(findOn(rings[2], a), findOn(rings[0], a), 'avenue');
  graph.addEdge(findOn(rings[3], hs + Math.PI / 2), findOn(rings[1], hs + Math.PI / 2), 'avenue');
  return rings;
}

/** A-roads out to the edge of the map, bending as they go. */
function buildRadials(ctx, rings) {
  const { graph, rng } = ctx;
  const outer = rings[rings.length - 1], radials = [], COUNT = 7;
  for (let i = 0; i < COUNT; i++) {
    const ang = (i / COUNT) * TAU + rand(rng, -0.25, 0.25);
    let start = outer[0], bd = Infinity;
    for (const n of outer) {
      const d = Math.abs(Math.atan2(Math.sin(Math.atan2(n.z, n.x) - ang), Math.cos(Math.atan2(n.z, n.x) - ang)));
      if (d < bd) { bd = d; start = n; }
    }
    let prev = start, bearing = ang;
    const chain = [start];
    for (let r = 820; r < WORLD_HALF - 60; r += rand(rng, 130, 190)) {
      bearing += rand(rng, -0.16, 0.16);
      const n = graph.addNode(Math.cos(bearing) * r, Math.sin(bearing) * r, 'cross');
      if (Math.abs(n.x) > WORLD_HALF - 60 || Math.abs(n.z) > WORLD_HALF - 60) break;
      const mx = (prev.x + n.x) * 0.5, mz = (prev.z + n.z) * 0.5, dx = n.x - prev.x, dz = n.z - prev.z, dl = Math.hypot(dx, dz) || 1;
      const bow = rand(rng, -30, 30);
      graph.addEdge(prev, n, 'avenue', [{ x: mx + (-dz / dl) * bow, z: mz + (dx / dl) * bow }]);
      chain.push(n);
      prev = n;
    }
    radials.push({ angle: ang, chain });
  }
  return radials;
}

/** The bypass: a dual carriageway round one side, meeting the A-roads at roundabouts. */
function buildBypass(ctx, radials) {
  const { graph, rng } = ctx;
  const sorted = radials.slice().sort((a, b) => a.angle - b.angle);
  const first = randInt(rng, 0, sorted.length - 1);
  const served = [];
  for (let k = 0; k < 4; k++) served.push(sorted[(first + k) % sorted.length]);
  const junctions = [];
  for (const rad of served) {
    let idx = -1;
    for (let i = 0; i < rad.chain.length - 1; i++) {
      const r0 = Math.hypot(rad.chain[i].x, rad.chain[i].z), r1 = Math.hypot(rad.chain[i + 1].x, rad.chain[i + 1].z);
      if (r0 <= BYPASS_R && r1 >= BYPASS_R) { idx = i; break; }
    }
    if (idx < 0) continue;
    const a = rad.chain[idx], b = rad.chain[idx + 1];
    const r0 = Math.hypot(a.x, a.z), r1 = Math.hypot(b.x, b.z);
    const t = clamp((BYPASS_R - r0) / Math.max(1, r1 - r0), 0.15, 0.85);
    const j = graph.addNode(lerp(a.x, b.x, t), lerp(a.z, b.z, t), 'cross');
    for (const eid of a.edges.slice()) {
      const e = graph.edges[eid];
      if ((e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)) e.dead = true;
    }
    graph.reindexEdges();
    graph.addEdge(a, j, 'avenue');
    graph.addEdge(j, b, 'avenue');
    rad.chain.splice(idx + 1, 0, j);
    junctions.push({ node: j, angle: Math.atan2(j.z, j.x) });
  }
  if (junctions.length < 2) return null;
  // In angle order the short way round: the served A-roads are neighbours.
  junctions.sort((p, q) => p.angle - q.angle);
  let gap = -1, gi = 0;
  for (let i = 0; i < junctions.length; i++) {
    const a = junctions[i].angle, b = junctions[(i + 1) % junctions.length].angle + (i + 1 === junctions.length ? TAU : 0);
    if (b - a > gap) { gap = b - a; gi = i; }
  }
  const order = [];
  for (let k = 1; k <= junctions.length; k++) order.push(junctions[(gi + k) % junctions.length]);
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i].node, b = order[i + 1].node;
    let a0 = order[i].angle, a1 = order[i + 1].angle;
    if (a1 < a0) a1 += TAU;
    const mids = [];
    for (let s = 1; s < 5; s++) {
      const ang = lerp(a0, a1, s / 5), rr = BYPASS_R + rand(rng, -16, 16);
      mids.push({ x: Math.cos(ang) * rr, z: Math.sin(ang) * rr });
    }
    graph.addEdge(a, b, 'dual', mids);
  }
  const circles = [];
  for (const j of order) {
    const c = graph.convertToRoundabout(j.node, 30, 8, 'street');
    if (c) circles.push(c);
  }
  return { junctions: circles };
}

// =====================================================================
//  The railway and the canal
// =====================================================================

/** A polyline with a coarse index: the nearest distance to it, and where along it. */
class Line {
  constructor(points, kind) {
    this.kind = kind;
    this.points = points;
    this.sAt = [0];
    for (let k = 1; k < points.length; k++) this.sAt.push(this.sAt[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z));
    this.length = this.sAt[this.sAt.length - 1];
    this.cell = 40;
    this.map = new Map();
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k], b = points[k + 1];
      const i0 = Math.floor(Math.min(a.x, b.x) / this.cell), i1 = Math.floor(Math.max(a.x, b.x) / this.cell);
      const j0 = Math.floor(Math.min(a.z, b.z) / this.cell), j1 = Math.floor(Math.max(a.z, b.z) / this.cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const key = i * 100003 + j;
        let l = this.map.get(key);
        if (!l) { l = []; this.map.set(key, l); }
        l.push(k);
      }
    }
  }

  /** { d, s, k } of the nearest point within `r` (Infinity if none). */
  near(x, z, r = 40) {
    let best = { d: Infinity, s: 0, k: -1 };
    const c = this.cell, n = Math.ceil(r / c);
    const ci = Math.floor(x / c), cj = Math.floor(z / c), seen = new Set();
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) {
      const l = this.map.get(i * 100003 + j);
      if (!l) continue;
      for (const k of l) {
        if (seen.has(k)) continue;
        seen.add(k);
        const a = this.points[k], b = this.points[k + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
        const t = L2 > 0 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1) : 0;
        const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
        if (d < best.d) best = { d, s: this.sAt[k] + t * Math.sqrt(L2), k };
      }
    }
    return best;
  }

  /** Where a polyline crosses this: [{ x, z, i, t, s, cos }]. `i` its segment, `t` along it, `s` along this. */
  crossings(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2, r = Math.hypot(q.x - p.x, q.z - p.z) / 2 + 2;
      const c = this.cell, n = Math.ceil(r / c) + 1, ci = Math.floor(mx / c), cj = Math.floor(mz / c), seen = new Set();
      for (let a = ci - n; a <= ci + n; a++) for (let b = cj - n; b <= cj + n; b++) {
        const l = this.map.get(a * 100003 + b);
        if (!l) continue;
        for (const k of l) {
          if (seen.has(k)) continue;
          seen.add(k);
          const c0 = this.points[k], c1 = this.points[k + 1];
          if (!segX(p, q, c0, c1)) continue;
          const rx = q.x - p.x, rz = q.z - p.z, sx = c1.x - c0.x, sz = c1.z - c0.z, den = rx * sz - rz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((c0.x - p.x) * sz - (c0.z - p.z) * sx) / den, uu = ((c0.x - p.x) * rz - (c0.z - p.z) * rx) / den;
          const rl = Math.hypot(rx, rz), sl = Math.hypot(sx, sz);
          out.push({ x: p.x + rx * tt, z: p.z + rz * tt, i, t: tt, s: this.sAt[k] + uu * sl, cos: (rx * sx + rz * sz) / (rl * sl) });
        }
      }
    }
    return out;
  }

  at(s) {
    const S = this.sAt, P = this.points;
    let lo = 0, hi = S.length - 1;
    s = clamp(s, 0, this.length);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const a = P[lo], b = P[Math.min(lo + 1, P.length - 1)], L = (S[lo + 1] - S[lo]) || 1, t = (s - S[lo]) / L;
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), dx: (b.x - a.x) / L, dz: (b.z - a.z) / L };
  }
}

/** A road's line from a and b through its control points. */
const lineOf = (graph, e) => (e.points && e.points.length ? e.points : [graph.nodes[e.a], graph.nodes[e.b]]);

/**
 * Is this road's line bad against the railway and canal: across one at a slant, near a junction, more than once, or
 * along beside one? `allow` { rail, canal } says which it may cross at all.
 */
function badForLines(ctx, pts, width, allow) {
  let along = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  const total = along[along.length - 1];
  // Nowhere near the lake: nothing crosses it.
  if (ctx.lake) {
    const lk = ctx.lake, keep = lk.R + width * 0.5 + 8;
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k], q = pts[k + 1], n = Math.max(1, Math.ceil((along[k + 1] - along[k]) / 5));
      for (let m = 0; m <= n; m++) if (Math.hypot(lerp(p.x, q.x, m / n) - lk.x, lerp(p.z, q.z, m / n) - lk.z) < keep) return true;
    }
  }
  for (const L of [ctx.rail, ctx.canal]) {
    if (!L) continue;
    const xs = L.crossings(pts);
    if (xs.length > 1) return true;
    const at = [];
    for (const c of xs) {
      if (!allow[L.kind]) return true;
      if (Math.abs(c.cos) > 0.62) return true;
      const s = along[c.i] + c.t * (along[c.i + 1] - along[c.i]);
      // Not near a junction: for the river, nowhere on its bridge.
      const clear = L.kind === 'canal' ? CANAL_W + 16 : 32;
      if (s < clear || total - s < clear) return true;
      at.push(s);
    }
    // Not along beside it.
    const keep = width * 0.5 + (L.kind === 'rail' ? 10 : CANAL_W + 8);
    if (L.kind === 'lake') continue;
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k], q = pts[k + 1], seg = along[k + 1] - along[k], n = Math.max(1, Math.ceil(seg / 5));
      for (let m = 0; m <= n; m++) {
        const s = along[k] + seg * (m / n);
        if (at.some((a) => Math.abs(a - s) < (L.kind === 'canal' ? CANAL_W * 2 + 10 : 24))) continue;
        if (L.near(lerp(p.x, q.x, m / n), lerp(p.z, q.z, m / n), keep + 2).d < keep) return true;
      }
    }
  }
  return false;
}

/** Near either line, for a turning head or a building. */
function nearLines(ctx, x, z, r) {
  return (ctx.rail && ctx.rail.near(x, z, r + 8).d < r) || (ctx.canal && ctx.canal.near(x, z, r + 8).d < r + CANAL_W)
    || (ctx.lake && Math.hypot(x - ctx.lake.x, z - ctx.lake.z) < r + ctx.lake.R);
}

/** The lake: its bowl reaches R from the middle, LAKE_D deep at the middle, the water LAKE_DOWN under the bank. */
const LAKE_R = 135, LAKE_D = 5, LAKE_DOWN = 1.2;
const lakeDepth = (lk, d, a) => { const R = lk.Rat(a); return d >= R ? 0 : LAKE_D * smoothstep(R, R * 0.45, d); };

/**
 * Where the lake goes: out in the country, in the lowest ground there is, clear of the railway, the hills, the villages and as many
 * roads as can be (any it would meet are taken out, as the railway's are). The best of a grid of places.
 */
function planLake(ctx) {
  const { graph } = ctx, R = LAKE_R;
  let best = null;
  for (let x = -WORLD_HALF + 260; x <= WORLD_HALF - 260; x += 50) {
    for (let z = -WORLD_HALF + 260; z <= WORLD_HALF - 260; z += 50) {
      const r = Math.hypot(x, z);
      // Out in the country, away from the houses: "put a lake in like in the countryside, but like kind of not near any houses".
      if (r < TOWN_EDGE + 220 || r > 1260) continue;
      if (ctx.rail && ctx.rail.near(x, z, R * 1.3 + 80).d < R * 1.3 + 70) continue;
      if (ctx.canal && ctx.canal.near(x, z, R * 1.3 + 120).d < R * 1.3 + 110) continue;
      if (ctx.hills.some((h) => Math.hypot(h.x - x, h.z - z) < h.r * 0.8 + R)) continue;
      let roads = 0, town = false;
      for (const e of graph.edges) {
        if (e.dead) continue;
        const near = lineOf(graph, e).some((q) => Math.hypot(q.x - x, q.z - z) < R * 1.3 + 40);
        if (!near) continue;
        if (e.kind !== 'country') town = true;
        roads += e.kind === 'country' ? 10 : 60;
      }
      if (town) continue;
      const score = ctx.base(x, z) * 2 + roads;
      if (!best || score < best.score) best = { score, x, z };
    }
  }
  if (!best) return null;
  let low = Infinity;
  for (let a = 0; a < 16; a++) low = Math.min(low, ctx.base(best.x + Math.cos(a) * R, best.z + Math.sin(a) * R));
  const bank = Math.max(LAKE_D + 1, low);
  // Not a circle: its edge in and out with the angle.
  const ph = [ctx.xrng() * TAU, ctx.xrng() * TAU, ctx.xrng() * TAU];
  const Rat = (a) => R * (1 + 0.16 * Math.sin(2 * a + ph[0]) + 0.09 * Math.sin(3 * a + ph[1]) + 0.05 * Math.sin(5 * a + ph[2]));
  return { x: best.x, z: best.z, R: R * 1.3, Rat, bank, level: bank - LAKE_DOWN };
}

/** The bowl cut into the ground (smooth enough on the 4 m grid at this size), and its water marked. */
function carveLake(lk, hgrid, water) {
  const { n, half, step, H } = hgrid;
  const i0 = Math.max(0, Math.floor((lk.x - lk.R + half) / step) - 1), i1 = Math.min(n - 1, Math.ceil((lk.x + lk.R + half) / step) + 1);
  const j0 = Math.max(0, Math.floor((lk.z - lk.R + half) / step) - 1), j1 = Math.min(n - 1, Math.ceil((lk.z + lk.R + half) / step) + 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = i * step - half, z = j * step - half, d = Math.hypot(x - lk.x, z - lk.z);
      if (d > lk.R) continue;
      const k = j * n + i;
      H[k] = Math.min(H[k], lk.bank - lakeDepth(lk, d, Math.atan2(z - lk.z, x - lk.x)));
      if (H[k] < lk.level + 0.6) water.lv[k] = lk.level;
    }
  }
}

/**
 * A line across the whole map: the railway through the edge of the town, the canal through the other side. The best of
 * a few dozen tried, by how few of the town's roads it would take out, and for the canal how level the ground under it is.
 */
function planLine(ctx, kind, other) {
  const { graph } = ctx, rng = ctx.xrng, H = WORLD_HALF, far = EDGE_FACE + 60;
  const beacon = ctx.hills[0];
  let best = null;
  for (let t = 0; t < 46; t++) {
    const a = rng() * Math.PI, ux = Math.cos(a), uz = Math.sin(a), nx = -uz, nz = ux;
    if (other) {
      const o = other.dir, d = Math.abs(Math.atan2(Math.sin(a - o), Math.cos(a - o)));
      if (Math.min(d, Math.PI - d) < 0.5) continue;
    }
    const side = rng() < 0.5 ? 1 : -1;
    // Outside the old core (ring 2, 290 m): through it, the railway left the middle of town half built.
    const off = side * (kind === 'rail' ? rand(rng, 330, 470) : rand(rng, 360, 560));
    const ctrl = [];
    for (let k = 0; k <= 8; k++) {
      const s = -2200 + (4400 * k) / 8, w = k === 0 || k === 8 ? 0 : rand(rng, -70, 70);
      ctrl.push({ x: ux * s + nx * (off + w), z: uz * s + nz * (off + w) });
    }
    const all = spline(ctrl, 6).filter((p) => Math.abs(p.x) < far && Math.abs(p.z) < far);
    if (all.length < 50) continue;
    const L = new Line(all, kind);
    if (beacon && L.near(beacon.x, beacon.z, 340).d < 320) continue;
    // What it would take out, of the roads there are now.
    let cut = 0, crosses = 0, dual = false;
    const was = ctx[kind];
    ctx[kind] = L;
    const keep = { rail: kind === 'rail', canal: kind === 'canal' };
    for (const e of graph.edges) {
      if (e.dead) continue;
      const pts = lineOf(graph, e);
      const xs = L.crossings(pts);
      if (xs.length && e.kind === 'dual' && kind === 'rail') dual = true;
      crosses += xs.length;
      const save = ctx[kind === 'rail' ? 'canal' : 'rail'];
      ctx[kind === 'rail' ? 'canal' : 'rail'] = null;
      if (badForLines(ctx, pts, e.width || 15, keep)) cut++;
      ctx[kind === 'rail' ? 'canal' : 'rail'] = save;
    }
    ctx[kind] = was;
    if (dual) continue;
    let rough = 0;
    if (kind === 'canal') {
      let prev = null;
      for (let s = 0; s < L.length; s += 60) {
        const p = L.at(s), h = ctx.base(p.x, p.z);
        if (prev !== null) rough += Math.abs(h - prev);
        prev = h;
      }
    }
    // Through the town, over a good few of its roads: at first the best had 4 level crossings and 3 bridges, out at the edge.
    const score = cut * 4 + Math.max(0, (kind === 'rail' ? 9 : 8) - (crosses - cut)) * 9 + rough * 0.5;
    if (!best || score < best.score) best = { score, L, dir: a };
  }
  if (!best) return null;
  best.L.dir = best.dir;
  return best.L;
}

/** Take out the roads the lines would meet badly. */
function cutForLines(ctx) {
  const { graph } = ctx;
  for (const e of graph.edges) {
    if (e.dead) continue;
    if (badForLines(ctx, lineOf(graph, e), e.width || 15, { rail: e.kind !== 'dual', canal: true })) e.dead = true;
  }
  graph.reindexEdges();
}

/** An edge added after the lines: kept only if it meets them well. */
function guarded(ctx, a, b, kind, mids, allow = { rail: true, canal: true }) {
  const { graph } = ctx;
  const pts = [a, ...(mids || []), b];
  if (badForLines(ctx, pts, (ROAD_KIND[kind] || ROAD_KIND.street).width, allow)) return null;
  return graph.addEdge(a, b, kind, mids && mids.length ? mids : null);
}

/** Everything not joined to the biggest piece of the network, taken out: the lines leave bits of town cut off. */
function prune(graph) {
  const comp = new Int32Array(graph.nodes.length).fill(-1);
  const sizes = [];
  for (const n of graph.nodes) {
    if (comp[n.id] >= 0 || !n.edges.some((id) => !graph.edges[id].dead)) continue;
    const c = sizes.length, stack = [n.id];
    comp[n.id] = c;
    let size = 0;
    while (stack.length) {
      const id = stack.pop();
      size++;
      for (const eid of graph.nodes[id].edges) {
        const e = graph.edges[eid];
        if (e.dead) continue;
        const o = e.a === id ? e.b : e.a;
        if (comp[o] < 0) { comp[o] = c; stack.push(o); }
      }
    }
    sizes.push(size);
  }
  let big = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[big]) big = c;
  let any = false;
  for (const e of graph.edges) {
    if (!e.dead && comp[e.a] !== big) { e.dead = true; any = true; }
  }
  if (any) graph.reindexEdges();
}

/** The railway's crossings on the finished roads, in the form Railway wants (countryextras.js judgeRail). */
function finishRail(ctx) {
  const { graph } = ctx, L = ctx.rail;
  const cross = [];
  for (const e of graph.edges) {
    if (e.dead || e.cut) continue;
    for (const sg of e.segs) {
      for (const c of L.crossings([sg.a, sg.b])) {
        const sx = sg.b.x - sg.a.x, sz = sg.b.z - sg.a.z, sl = Math.hypot(sx, sz) || 1;
        const r = L.at(c.s);
        if (cross.some((o) => Math.abs(o.s - c.s) < 3)) continue;
        cross.push({ s: c.s, edge: e.id, along: sg.start + c.t * sg.len, x: c.x, z: c.z, rdx: sx / sl, rdz: sz / sl, qx: r.dx, qz: r.dz, width: e.width, sin: Math.sqrt(Math.max(0.05, 1 - c.cos * c.cos)) });
      }
    }
  }
  cross.sort((a, b) => a.s - b.s);
  return { points: L.points, sAt: L.sAt, cross, line: L };
}

/**
 * The canal's pounds, levels and bridges. In pounds of about POUND m, each at the mean of the ground under it, joined by
 * locks; the towpath a little over the water. Every road over it is a bridge: a humpback on the small roads, to leave
 * the ground over, near level on the big ones.
 */
function finishCanal(ctx) {
  const { graph } = ctx, L = ctx.canal, H = WORLD_HALF;
  const inside = (p) => Math.abs(p.x) < H - 10 && Math.abs(p.z) < H - 10;
  let s0 = 0, s1 = L.length;
  while (s0 < L.length && !inside(L.at(s0))) s0 += 2;
  while (s1 > 0 && !inside(L.at(s1))) s1 -= 2;
  // The river's level: the ground's along its line, averaged over RIVER_SMOOTH either side, then made to fall all the way, never
  // more than RIVER_FALL a metre, from whichever end is higher. A river has no locks.
  const STEP = 10, N = Math.max(2, Math.ceil((s1 - s0) / STEP) + 1), raw = new Float32Array(N), lev = new Float32Array(N);
  for (let k = 0; k < N; k++) { const q = L.at(s0 + k * STEP); raw[k] = ctx.base(q.x, q.z); }
  const reach = Math.round(RIVER_SMOOTH / STEP);
  for (let k = 0; k < N; k++) {
    let sum = 0, c = 0;
    for (let m = Math.max(0, k - reach); m <= Math.min(N - 1, k + reach); m++) { sum += raw[m]; c++; }
    lev[k] = sum / c;
  }
  const down = lev[0] >= lev[N - 1];
  for (let k = 1; k < N; k++) {
    const a = down ? k : N - 1 - k, b = down ? k - 1 : N - k;
    lev[a] = Math.min(lev[a], lev[b]);
    lev[a] = Math.max(lev[a], lev[b] - RIVER_FALL * STEP);
  }
  for (let k = 0; k < N; k++) lev[k] = Math.max(CANAL_D + 1, lev[k]);
  const towAt = (s) => {
    const f = clamp((s - s0) / STEP, 0, N - 1), k = Math.min(N - 2, Math.floor(f));
    return lerp(lev[k], lev[k + 1], f - k);
  };
  const waterAtS = (s) => towAt(s) - WATER_DOWN;
  const pounds = [{ a: s0, b: s1, wa: s0, wb: s1, tow: lev[0] }], locks = [];
  const discs = [], tow = [], ribbon = [];
  const side = DRIVE_SIDE;
  for (let s = s0; s <= s1; s += 5) {
    const p = L.at(s);
    discs.push({ x: p.x, z: p.z, r: BANK_OUT + 1, fade: 16, h: towAt(s) });
  }
  for (let s = s0; s <= s1; s += 3) {
    const p = L.at(s);
    tow.push({ x: p.x - p.dz * TOW_OFF * side, z: p.z + p.dx * TOW_OFF * side, s });
    ribbon.push({ x: p.x, z: p.z, dx: p.dx, dz: p.dz, s, level: waterAtS(s) });
  }
  // Bridges: the roads over it, on the finished network.
  const humps = [], bridges = [];
  for (const e of graph.edges) {
    if (e.dead || e.cut) continue;
    for (const sg of e.segs) {
      for (const c of L.crossings([sg.a, sg.b])) {
        if (c.s < s0 || c.s > s1) continue;
        const along = sg.start + c.t * sg.len;
        const sx = sg.b.x - sg.a.x, sz = sg.b.z - sg.a.z, sl = Math.hypot(sx, sz) || 1;
        bridges.push({ x: c.x, z: c.z, dx: sx / sl, dz: sz / sl, width: e.width, edge: e, s: c.s, sin: Math.sqrt(Math.max(0.1, 1 - c.cos * c.cos)) });
      }
    }
  }
  return { line: L, points: L.points, s0, s1, pounds, locks, towAt, waterAtS, discs, tow, ribbon, humps, bridges };
}





/**
 * The decks: each road and the railway over the river, from a bank CANAL_W + 3 out on one side to the same on the other, at the
 * ground's level at each end and rising in an arch to clear the water by DECK_CLEAR (the railway's by less, a train's grade being
 * what it is). Returned: the deck's height at (x, z), or -Infinity off every deck.
 */
const DECK_CLEAR = 4.2, RAIL_CLEAR = 3.2;
function riverDecks(ctx, canal, rail, hgrid) {
  const L = canal.line, spans = [];
  const span = (x, z, dx, dz, hw, rail2) => {
    const nr = L.near(x, z, 30), cp = L.at(nr.s), sin = Math.max(0.35, Math.abs(dx * -cp.dz + dz * cp.dx));
    const Lh = (CANAL_W + 3) / sin;
    const ax = x - dx * Lh, az = z - dz * Lh, bx = x + dx * Lh, bz = z + dz * Lh;
    const ha = hgrid.at(ax, az), hb = hgrid.at(bx, bz), lv = canal.waterAtS(nr.s);
    const rise = Math.max(rail2 ? 0.3 : 0.8, lv + (rail2 ? RAIL_CLEAR : DECK_CLEAR) - lerp(ha, hb, 0.5));
    spans.push({ x, z, dx, dz, hw, Lh, ha, hb, rise, lv, rail: rail2, s: nr.s, sin, nx: -cp.dz, nz: cp.dx,
      minX: Math.min(ax, bx) - hw - 2, maxX: Math.max(ax, bx) + hw + 2, minZ: Math.min(az, bz) - hw - 2, maxZ: Math.max(az, bz) + hw + 2 });
  };
  for (const b of canal.bridges) span(b.x, b.z, b.dx, b.dz, b.width * 0.5 + 1.2, false);
  if (rail) for (const c of rail.line.crossings(canal.points)) { const r = rail.line.at(c.s); span(c.x, c.z, r.dx, r.dz, 3.6, true); }
  canal.spans = spans;
  const deck = (b, t) => lerp(b.ha, b.hb, t) + b.rise * Math.sin(Math.PI * t);
  canal.deck = deck;
  return (x, z) => {
    if (ctx.clearAt && !ctx.clearAt(x, z, CLEAR_CANAL)) return -Infinity;
    let best = -Infinity;
    for (const b of spans) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const dx = x - b.x, dz = z - b.z, along = dx * b.dx + dz * b.dz;
      if (Math.abs(along) > b.Lh || Math.abs(dx * b.dz - dz * b.dx) > b.hw) continue;
      best = Math.max(best, deck(b, (along + b.Lh) / (2 * b.Lh)));
    }
    return best;
  };
}

/**
 * The bridges drawn and made solid. "A nice textured proper bridge going over it, and same with the train line, like a proper well
 * done bridge." A road's: a stone deck in an arch, a parapet each side, piers standing in the water. The railway's: the same deck
 * between steel girders. Under each, the river runs on.
 */
function buildBridges(ctx, canal) {
  const W = ctx.sim.world, stone = new MeshBuilder(), steel = new MeshBuilder(), top = new MeshBuilder();
  const tri = (b, p0, p1, p2, colour) => {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const c = new THREE.Color(colour);
    for (const q of [p0, p1, p2]) { b.pos.push(q[0], q[1], q[2]); b.norm.push(nx, ny, nz); b.col.push(c.r, c.g, c.b); }
  };
  const quad = (b, a, bb, c, d, colour) => { tri(b, a, bb, c, colour); tri(b, a, c, d, colour); };
  for (const sp of canal.spans) {
    const N = Math.max(6, Math.ceil((sp.Lh * 2) / 2)), lx = sp.dz, lz = -sp.dx;
    const P = (t, o, dy = 0) => {
      const a = -sp.Lh + 2 * sp.Lh * t, y = canal.deck(sp, t) + dy;
      return [sp.x + sp.dx * a + lx * o, y, sp.z + sp.dz * a + lz * o];
    };
    const wall = sp.rail ? steel : stone, wallCol = sp.rail ? 0x3f4a52 : 0x9a8f7c, deckCol = sp.rail ? 0x5d5852 : 0x8f8676;
    const hw = sp.hw, under = sp.rail ? 1.3 : 1.1, pH = sp.rail ? 1.6 : 1.05, pT = sp.rail ? 0.3 : 0.45;
    for (let k = 0; k < N; k++) {
      const t0 = k / N, t1 = (k + 1) / N;
      // The deck's sides and underside.
      for (const side of [1, -1]) quad(stone, P(t0, hw * side, 0), P(t1, hw * side, 0), P(t1, hw * side, -under), P(t0, hw * side, -under), deckCol);
      quad(top, P(t0, -hw, -under), P(t1, -hw, -under), P(t1, hw, -under), P(t0, hw, -under), 0x5b564e);
      // The parapets (girders on the railway's): outer face, inner face, top.
      for (const side of [1, -1]) {
        const o1 = hw * side, o0 = (hw - pT) * side;
        quad(wall, P(t0, o1, 0), P(t1, o1, 0), P(t1, o1, pH), P(t0, o1, pH), wallCol);
        quad(wall, P(t0, o0, 0.05), P(t1, o0, 0.05), P(t1, o0, pH), P(t0, o0, pH), wallCol);
        quad(top, P(t0, o0, pH), P(t1, o0, pH), P(t1, o1, pH), P(t0, o1, pH), sp.rail ? 0x2f383e : 0xb3a994);
      }
    }
    // The parapets solid, in pieces along the deck.
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      for (const side of [1, -1]) {
        const c = P(t, (hw - pT * 0.5) * side, pH * 0.5);
        addStaticBox(W, c[0], c[1], c[2], pT * 0.5, pH * 0.5, sp.Lh / N + 0.05, GROUP.BUILDING, Math.atan2(sp.dx, sp.dz));
      }
    }
    // Piers: in the water, about every 16 m, and one under each end at the river's edge.
    const span2 = sp.Lh * 2, piers = Math.max(1, Math.round(span2 / 16) - 1);
    for (let k = 1; k <= piers; k++) {
      const t = k / (piers + 1), c = P(t, 0, -under), d = Math.abs((t - 0.5) * span2 * sp.sin);
      const bed = canal.towAt(sp.s) - dipAt(d) - 0.8, h = c[1] - bed;
      if (h < 0.5) continue;
      const rot = Math.atan2(sp.dx, sp.dz);
      stone.addBox(hw * 1.7, h, 1.8, c[0], bed + h * 0.5, c[2], 0x8d8371, rot);
      stone.addTaperedBox(hw * 1.9, 0.5, 2.2, c[0], c[1] - 0.25, c[2], 0x7e7564, 1, 1, rot);
      addStaticBox(W, c[0], bed + h * 0.5, c[2], hw * 0.85, h * 0.5, 0.9, GROUP.BUILDING, rot);
    }
  }
  const out = [];
  for (const [b, tex, name] of [[stone, 'stone', 'bridges'], [steel, 'steel', 'bridges'], [top, 'top', 'bridges']]) {
    if (!b.vertexCount) continue;
    const mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ side: THREE.DoubleSide }));
    if (tex === 'stone') buildingDetail(mesh, 'brick');
    else if (tex === 'steel') buildingDetail(mesh, 'panel');
    else groundDetail(mesh, 'tarmac');
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

/** A water level grid at the height grid's spacing: the canal's and the ford's, null elsewhere. */
function waterGrid(hgrid) {
  const { n, half, step } = hgrid;
  const lv = new Float32Array(n * n).fill(NaN);
  const ford = new Uint8Array(n * n);
  const cellOf = (x, z) => {
    const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
    return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i;
  };
  return {
    lv, ford, cellOf,
    levelAt(x, z) { const k = cellOf(x, z); return k < 0 || Number.isNaN(lv[k]) ? null : lv[k]; },
    fordAt(x, z) { const k = cellOf(x, z); return k >= 0 && ford[k] === 1; },
  };
}

/** Is (x, z) on some road's carriageway, or near enough to it that the ground there is the road's? */
function onARoad(graph, x, z, pad) {
  const r = graph.nearestEdge(x, z, 25);
  return !!(r && r.dist < r.edge.width * 0.5 + pad);
}

/** The river's valley cut into the ground after it is made, smooth at this width on the 4 m grid, and its water marked. */
function carveCanal(ctx, canal, hgrid, water) {
  const { n, half, step, H } = hgrid;
  const L = canal.line, R = CANAL_W;
  const i0 = (x) => Math.max(0, Math.floor((x - R - 4 + half) / step)), i1 = (x) => Math.min(n - 1, Math.ceil((x + R + 4 + half) / step));
  const done = new Uint8Array(n * n);
  for (let s = canal.s0; s <= canal.s1; s += 2) {
    const p = L.at(s);
    for (let j = i0(p.z); j <= i1(p.z); j++) {
      for (let i = i0(p.x); i <= i1(p.x); i++) {
        const k = j * n + i;
        if (done[k]) continue;
        const x = i * step - half, z = j * step - half;
        const nr = L.near(x, z, R + 8);
        if (nr.d > R) continue;
        done[k] = 1;
        // Under the bridges too: nothing was laid there (buildHeightGrid skipClaim).
        H[k] = Math.min(H[k], canal.towAt(nr.s) - dipAt(nr.d));
        if (nr.d < CANAL_HALF + 2) water.lv[k] = canal.waterAtS(nr.s);
      }
    }
  }
}

/** A lane that dips through a stream: the dip is a crest the other way (pickFord); here, the stream either side, and its water. */
function carveFord(ctx, f, hgrid, water) {
  const { n, half, step, H } = hgrid;
  const bottom = hgrid.at(f.x, f.z);
  const level = bottom + FORD_DEEP;
  f.level = level;
  // Across the lane (its normal), out 70 m each way.
  const nx = -f.tz, nz = f.tx;
  f.stream = [];
  for (let o = -70; o <= 70; o += 2) {
    const x = f.x + nx * o, z = f.z + nz * o;
    f.stream.push({ x, z });
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = Math.round((x + half) / step) + di, j = Math.round((z + half) / step) + dj;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const px = i * step - half, pz = j * step - half;
      const across = Math.abs((px - f.x) * f.tx + (pz - f.z) * f.tz);
      if (across > 4.5) continue;
      const k = j * n + i;
      const road = Math.abs(o) < f.edge.width * 0.5 + 1.5;
      if (!road) H[k] = Math.min(H[k], level - 0.55);
      water.lv[k] = level;
      water.ford[k] = 1;
    }
  }
}

/** A country lane well out of town, away from the lines, with room either side: the ford, in the middle of it. */
function pickFord(ctx) {
  const { graph } = ctx;
  let best = null;
  for (const e of graph.edges) {
    if (e.dead || e.cut || (e.kind !== 'country' && e.kind !== 'lane') || e.length < 110 || e.hill) continue;
    const s = e.length / 2;
    const sg = e.segs.find((g) => s >= g.start && s <= g.start + g.len) || e.segs[0];
    const t = (s - sg.start) / (sg.len || 1);
    const x = lerp(sg.a.x, sg.b.x, t), z = lerp(sg.a.z, sg.b.z, t);
    const r = Math.hypot(x, z);
    if (r < 700 || nearLines(ctx, x, z, 90)) continue;
    // Not near another road.
    let clear = true;
    for (const o of graph.edgesNear(x, z, 45)) if (o !== e && !o.dead) clear = false;
    if (!clear) continue;
    const score = Math.abs(r - 1000);
    if (!best || score < best.score) best = { score, edge: e, s, x, z, tx: (sg.b.x - sg.a.x) / (sg.len || 1), tz: (sg.b.z - sg.a.z) / (sg.len || 1) };
  }
  if (best) best.edge.name = 'Watersplash Lane';
  return best;
}

// =====================================================================
//  The rest of the roads
// =====================================================================

/** Estates of crescents and closes, off the A-roads. */
function buildEstates(ctx, radials) {
  const { graph, rng } = ctx;
  const noRail = { rail: false, canal: true };
  for (const rad of radials) {
    for (let k = 0; k < 5; k++) {
      const host = rad.chain[randInt(rng, 0, Math.min(3, rad.chain.length - 1))];
      if (!host || !host.edges.some((id) => !graph.edges[id].dead)) continue;
      const hr = Math.hypot(host.x, host.z);
      if (hr < TOWN_EDGE - 120 || hr > 1250) continue;
      const side = rng() < 0.5 ? 1 : -1;
      // Beside the A-road, not off across the fields: centred that far, the crescents came back to it as long thin spikes.
      const out = Math.atan2(host.z, host.x) + side * Math.PI / 2 + rand(rng, -0.4, 0.4);
      const baseAng = out;
      const R0 = rand(rng, 55, 90);
      const cx = host.x + Math.cos(out) * (R0 + 32), cz = host.z + Math.sin(out) * (R0 + 32);
      if (Math.abs(cx) > WORLD_HALF - 110 || Math.abs(cz) > WORLD_HALF - 110) continue;
      if (rng() < 0.55) {
        // A loop round from the side facing the road, back to it.
        const R = R0, back = Math.atan2(host.z - cz, host.x - cx), a0 = back + 0.75, sweep = TAU - 1.5;
        const arc = [];
        for (let s = 0; s <= 6; s++) {
          const a = a0 + (s / 6) * sweep;
          arc.push(graph.addNode(cx + Math.cos(a) * R, cz + Math.sin(a) * R, 'cross'));
        }
        if (!guarded(ctx, host, arc[0], 'street', null, noRail)) continue;
        for (let s = 0; s < arc.length - 1; s++) guarded(ctx, arc[s], arc[s + 1], 'street', null, noRail);
        guarded(ctx, arc[arc.length - 1], host, 'street', null, noRail);
        // Closes off the crescent.
        for (const a of [arc[2], arc[4]]) {
          if (rng() < 0.5) continue;
          const ang = Math.atan2(a.z - cz, a.x - cx), len = rand(rng, 40, 70);
          const m = graph.addNode(a.x + Math.cos(ang) * len, a.z + Math.sin(ang) * len, 'cross');
          guarded(ctx, a, m, 'lane', null, noRail);
        }
      } else {
        let prev = host, ang = baseAng;
        const legs = randInt(rng, 2, 3);
        for (let s = 0; s < legs; s++) {
          ang += rand(rng, -0.5, 0.5);
          const len = rand(rng, 45, 80);
          const m = graph.addNode(prev.x + Math.cos(ang) * len, prev.z + Math.sin(ang) * len, 'cross');
          if (Math.abs(m.x) > WORLD_HALF - 80 || Math.abs(m.z) > WORLD_HALF - 80) break;
          if (!guarded(ctx, prev, m, 'lane', null, noRail)) break;
          prev = m;
        }
      }
    }
  }
}

/** Lanes between the A-roads' far ends, and two villages out in the country. */
function buildLanes(ctx, radials) {
  const { graph, rng } = ctx;
  const ends = radials.map((r) => {
    for (let k = r.chain.length - 1; k >= 0; k--) if (r.chain[k].edges.some((id) => !graph.edges[id].dead)) return r.chain[k];
    return null;
  }).filter(Boolean);
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i], b = ends[(i + 1) % ends.length];
    if (!a || !b || a === b) continue;
    const mids = [];
    for (let s = 1; s <= 3; s++) {
      const t = s / 4, mx = lerp(a.x, b.x, t), mz = lerp(a.z, b.z, t), pull = rand(rng, -0.18, 0.10);
      mids.push({ x: clamp(mx * (1 + pull), -WORLD_HALF + 70, WORLD_HALF - 70), z: clamp(mz * (1 + pull), -WORLD_HALF + 70, WORLD_HALF - 70) });
    }
    guarded(ctx, a, b, 'country', mids);
  }
  // Lanes from the A-roads' middles out to the lanes, across the country between them.
  for (const rad of radials) {
    const mid = rad.chain[Math.min(2, rad.chain.length - 1)];
    if (!mid) continue;
    const ang = Math.atan2(mid.z, mid.x) + (rng() < 0.5 ? 0.5 : -0.5), r = Math.hypot(mid.x, mid.z) + rand(rng, 160, 260);
    const far = graph.addNode(clamp(Math.cos(ang) * r, -WORLD_HALF + 80, WORLD_HALF - 80), clamp(Math.sin(ang) * r, -WORLD_HALF + 80, WORLD_HALF - 80), 'cross');
    guarded(ctx, mid, far, 'country', [{ x: lerp(mid.x, far.x, 0.5) + rand(rng, -30, 30), z: lerp(mid.z, far.z, 0.5) + rand(rng, -30, 30) }]);
  }
  ctx.villages = [];
  for (const host of [ends[randInt(rng, 0, ends.length - 1)], ends[randInt(rng, 0, ends.length - 1)]]) {
    if (!host || ctx.villages.some((v) => Math.hypot(v.x - host.x, v.z - host.z) < 300)) continue;
    const ring = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + rand(rng, -0.2, 0.2), R = rand(rng, 45, 75);
      const m = graph.addNode(host.x + Math.cos(a) * R, host.z + Math.sin(a) * R, 'cross');
      if (Math.abs(m.x) > WORLD_HALF - 60 || Math.abs(m.z) > WORLD_HALF - 60) continue;
      ring.push(m);
    }
    if (ring.length < 3) continue;
    for (let k = 0; k < ring.length; k++) guarded(ctx, ring[k], ring[(k + 1) % ring.length], 'lane');
    guarded(ctx, host, ring[0], 'lane');
    ctx.villages.push({ x: host.x, z: host.z });
  }
}

/**
 * Up the Beacon: "a long climbing road out of town up onto a hill, with a view back down over the town." From the
 * nearest A-road, in zigzags round the hill, to a car park on the top.
 */
function buildHillRoad(ctx, radials) {
  const { graph, rng } = ctx, hill = ctx.hills[0];
  let from = null, bd = Infinity;
  for (const r of radials) for (const n of r.chain) {
    if (!n.edges.some((id) => !graph.edges[id].dead)) continue;
    const d = Math.hypot(n.x - hill.x, n.z - hill.z);
    if (d < bd && d > hill.r * 0.9) { bd = d; from = n; }
  }
  if (!from) return null;
  const a0 = Math.atan2(from.z - hill.z, from.x - hill.x);
  const steps = [[hill.r * 0.92, 0], [hill.r * 0.72, 0.75], [hill.r * 0.52, -0.1], [hill.r * 0.34, 0.8], [hill.r * 0.18, 0.05]];
  let prev = from;
  const made = [];
  for (const [rr, da] of steps) {
    const a = a0 + da;
    const m = graph.addNode(hill.x + Math.cos(a) * rr, hill.z + Math.sin(a) * rr, 'cross');
    if (Math.abs(m.x) > WORLD_HALF - 80 || Math.abs(m.z) > WORLD_HALF - 80) break;
    const e = guarded(ctx, prev, m, 'country', [{ x: (prev.x + m.x) / 2 + rand(rng, -12, 12), z: (prev.z + m.z) / 2 + rand(rng, -12, 12) }]);
    if (!e) break;
    e.hill = true;
    made.push(e);
    prev = m;
  }
  if (!made.length) return null;
  const top = graph.addNode(hill.x + Math.cos(a0 + 0.4) * 6, hill.z + Math.sin(a0 + 0.4) * 6, 'cross');
  const e = guarded(ctx, prev, top, 'country');
  if (e) e.hill = true;
  return { x: top.x, z: top.z, node: top, name: hill.name };
}

/**
 * Back lanes behind the terraces: "terraced streets with back alleys behind them". Behind about half of each inner ring's
 * stretches, a lane leaves one junction, runs along behind the houses, and comes back to the next. The police take them
 * when they are quicker: "police that know the shortcuts".
 */
function buildAlleys(ctx, rings) {
  const { graph, rng } = ctx;
  let made = 0;
  for (let r = 1; r <= 3; r++) {
    const ring = rings[r];
    for (let k = 0; k < ring.length; k++) {
      if (rng() < 0.45) continue;
      const a = ring[k], b = ring[(k + 1) % ring.length];
      if (!a.edges.some((id) => !graph.edges[id].dead) || !b.edges.some((id) => !graph.edges[id].dead)) continue;
      const aa = Math.atan2(a.z, a.x), ab = aa + Math.atan2(Math.sin(Math.atan2(b.z, b.x) - aa), Math.cos(Math.atan2(b.z, b.x) - aa));
      // Half way to the next ring, where the gardens meet: at 34 m they ran through the backs of the terraces, and 1,209 houses
      // were refused for being on a road (ctx.whyNot) against 426 built.
      const ra = Math.hypot(a.x, a.z), rb = Math.hypot(b.x, b.z), sgn = rng() < 0.5 ? 1 : -1;
      const inset = sgn * (sgn > 0 ? RINGS[r] - RINGS[r - 1] : RINGS[r + 1] - RINGS[r]) * 0.5;
      const mids = [];
      for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const ang = lerp(aa, ab, t), rr = lerp(ra, rb, t) - inset;
        mids.push({ x: Math.cos(ang) * rr, z: Math.sin(ang) * rr });
      }
      if (guarded(ctx, a, b, 'alley', mids, { rail: false, canal: false })) made++;
    }
  }
  ctx.alleys = made;
}

/**
 * Mini roundabouts at a few of the town's crossroads, a double one, and the Magic Roundabout: "proper British roundabouts:
 * mini roundabouts in town, a big double one, and a 'magic roundabout' made of five small ones".
 */
function buildRoundabouts(ctx) {
  const { graph, rng } = ctx;
  const live = (n) => n.edges.filter((id) => !graph.edges[id].dead).length;
  const taken = [];
  const free = (n, r) => !taken.some((t) => Math.hypot(t.x - n.x, t.z - n.z) < r) && !nearLines(ctx, n.x, n.z, 60);
  const out = [];
  // The magic one: a crossroads on the outer ring.
  const outer = graph.nodes.filter((n) => live(n) >= 4 && Math.abs(Math.hypot(n.x, n.z) - RINGS[4]) < 40 && free(n, 200));
  if (outer.length) {
    const c = outer[randInt(rng, 0, outer.length - 1)];
    const ring = graph.convertToRoundabout(c, 34, 10, 'street');
    if (ring) {
      taken.push({ x: c.x, z: c.z });
      out.push({ ...ring, magic: true });
      // A mini roundabout at every way in.
      const near = graph.nodes.filter((n) => n.type === 'roundabout' && Math.abs(Math.hypot(n.x - c.x, n.z - c.z) - 34) < 1 && live(n) >= 3);
      for (const n of near) {
        const m = graph.convertToRoundabout(n, 6.5, 5, 'street');
        if (m) out.push({ ...m, mini: true, inMagic: true });
      }
    }
  }
  // Minis, and one pair close together: the double.
  const towns = graph.nodes.filter((n) => live(n) >= 3 && live(n) <= 4 && n.type !== 'roundabout' && Math.hypot(n.x, n.z) > 140 && Math.hypot(n.x, n.z) < 700);
  for (let i = towns.length - 1; i > 0; i--) { const j = randInt(rng, 0, i); [towns[i], towns[j]] = [towns[j], towns[i]]; }
  let minis = 0, double = false;
  for (const n of towns) {
    if (minis >= 7) break;
    if (!free(n, 110) || live(n) < 3) continue;
    // The double: a neighbour 35-70 m off it, made one too.
    let pair = null;
    if (!double) {
      for (const id of n.edges) {
        const e = graph.edges[id];
        if (e.dead) continue;
        const o = graph.nodes[e.a === n.id ? e.b : e.a];
        const d = Math.hypot(o.x - n.x, o.z - n.z);
        if (d > 35 && d < 75 && live(o) >= 3 && o.type !== 'roundabout') { pair = o; break; }
      }
    }
    const m = graph.convertToRoundabout(n, 9, 6, 'street');
    if (!m) continue;
    taken.push({ x: n.x, z: n.z });
    out.push({ ...m, mini: true });
    minis++;
    if (pair) {
      const m2 = graph.convertToRoundabout(pair, 9, 6, 'street');
      if (m2) { out.push({ ...m2, mini: true, double: true }); double = true; taken.push({ x: pair.x, z: pair.z }); }
    }
  }
  return out;
}

// =====================================================================
//  Naming
// =====================================================================

const CORE_NAMES = ['Market Place', 'Church Lane', 'Bridge Street', 'The Shambles', 'Priory Row', 'Corn Street', 'Butcher Row', 'Friar Lane',
  'Sheep Street', 'Pudding Lane'];
const STREET_NAMES = ['Mill Road', 'Victoria Street', 'Albion Road', 'Chapel Street', 'Elm Grove', 'Queens Road', 'Sackville Street',
  'Beech Avenue', 'Northgate', 'Southgate', 'Westbourne Road', 'Cranleigh Way', 'Abbots Walk', 'Kingsmead', 'Fairfield Road', 'Orchard Rise',
  'The Chase', 'Canal Street', 'Wharf Road', 'Railway Terrace', 'Gasworks Lane', 'Tanners Row', 'Union Street', 'Park Road'];
const ESTATE_NAMES = ['The Crescent', 'Willow Close', 'Hazel Court', 'Meadow Rise', 'Foxglove Close', 'Larkspur Way', 'Copse End',
  'Saxon Close', 'Rowan Drive', 'Heron Way', 'Kingfisher Close', 'Bramble Rise'];
const ALLEY_NAMES = ['Back Lane', 'Cut Throat Alley', 'Ropewalk', 'Tanyard Passage', 'Pump Alley', 'Smithy Lane'];
const A_ROADS = ['A417', 'A429', 'A361', 'A44', 'A433', 'A438', 'A4019'];
const B_ROADS = ['Fosse Way', 'Barrow Lane', 'Coldharbour Lane', 'Mill Track', 'Stannard Lane', 'Long Furlong', 'Holloway', 'Green Lane'];

function nameRoads(ctx) {
  const { graph } = ctx;
  let core = 0, street = 0, estate = 0, a = 0, b = 0, al = 0;
  for (const e of graph.edges) {
    const midR = Math.hypot((graph.nodes[e.a].x + graph.nodes[e.b].x) * 0.5, (graph.nodes[e.a].z + graph.nodes[e.b].z) * 0.5);
    if (e.name) continue;
    if (e.width === 11) { e.name = 'the roundabout'; continue; }
    if (e.kind === 'dual') { e.name = 'the Wexbury bypass'; continue; }
    if (e.hill) { e.name = 'Beacon Hill'; continue; }
    if (e.kind === 'alley') { e.name = ALLEY_NAMES[(al++) % ALLEY_NAMES.length]; continue; }
    if (e.kind === 'avenue') { e.name = midR < 420 ? 'the High Street' : A_ROADS[(a++) % A_ROADS.length]; continue; }
    if (e.kind === 'country') { e.name = B_ROADS[(b++) % B_ROADS.length]; continue; }
    if (e.kind === 'lane') {
      e.name = midR < RINGS[0] + 50 ? CORE_NAMES[(core++) % CORE_NAMES.length] : ESTATE_NAMES[(estate++) % ESTATE_NAMES.length];
      continue;
    }
    e.name = midR < 220 ? CORE_NAMES[(core++) % CORE_NAMES.length] : midR < TOWN_EDGE ? STREET_NAMES[(street++) % STREET_NAMES.length]
      : ESTATE_NAMES[(estate++) % ESTATE_NAMES.length];
  }
  for (const n of graph.nodes) {
    const names = [];
    for (const eid of n.edges) { const nm = graph.edges[eid].name; if (nm && names.indexOf(nm) === -1) names.push(nm); }
    n.name = names.length >= 2 ? `${names[0]} / ${names[1]}` : (names[0] || 'the junction');
  }
}

// =====================================================================
//  Bumps, laybys, surfaces
// =====================================================================

/** Speed bumps on the estate roads and the back streets: "speed bumps ... in town". */
function pickBumps(ctx) {
  const { graph } = ctx, rng = ctx.lrng, out = [];
  for (const e of graph.edges) {
    if (e.dead || e.cut || e.width === 11 || (e.kind !== 'street' && e.kind !== 'lane') || e.length < 90) continue;
    const mid = e.points[Math.floor(e.points.length / 2)], r = Math.hypot(mid.x, mid.z);
    if (r < 160 || r > 1300 || rng() < 0.7) continue;
    for (let s = 35; s < e.length - 35; s += rand(rng, 80, 120)) {
      const sg = e.segs.find((g) => s >= g.start && s <= g.start + g.len);
      if (!sg) continue;
      const t = (s - sg.start) / (sg.len || 1), x = lerp(sg.a.x, sg.b.x, t), z = lerp(sg.a.z, sg.b.z, t);
      if (nearLines(ctx, x, z, 30)) continue;
      if (ctx.canal && ctx.canal.near(x, z, 40).d < 35) continue;
      out.push({ x, z, tx: (sg.b.x - sg.a.x) / (sg.len || 1), tz: (sg.b.z - sg.a.z) / (sg.len || 1), hw: e.width * 0.5 - 0.3 });
    }
  }
  return out;
}

/** The bumps' height over the road at (x, z), by 16 m cells. */
function bumpField(bumps) {
  const cell = 16, map = new Map();
  for (const b of bumps) {
    const r = b.hw + 2;
    for (let i = Math.floor((b.x - r) / cell); i <= Math.floor((b.x + r) / cell); i++) {
      for (let j = Math.floor((b.z - r) / cell); j <= Math.floor((b.z + r) / cell); j++) {
        const key = i * 100003 + j;
        (map.get(key) || map.set(key, []).get(key)).push(b);
      }
    }
  }
  return (x, z) => {
    if (window.__noBumps) return 0;
    const l = map.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell));
    if (!l) return 0;
    for (const b of l) {
      const dx = x - b.x, dz = z - b.z, along = dx * b.tx + dz * b.tz;
      if (along > BUMP_HALF || along < -BUMP_HALF || Math.abs(dx * b.tz - dz * b.tx) > b.hw) continue;
      return BUMP_H * 0.5 * (1 + Math.cos((along / BUMP_HALF) * Math.PI));
    }
    return 0;
  };
}

/** A layby each side of each stretch of the bypass: a strip of tarmac off the carriageway, tapered in at both ends. */
function buildLaybyPlan(ctx) {
  const { graph } = ctx, out = [];
  for (const e of graph.edges) {
    if (e.dead || e.kind !== 'dual' || e.length < 260) continue;
    for (const [frac, side] of [[0.35, 1], [0.65, -1]]) {
      const pts = [];
      const s0 = e.length * frac;
      for (let s = s0 - 45; s <= s0 + 45; s += 3) {
        const sg = e.segs.find((g) => s >= g.start && s <= g.start + g.len);
        if (!sg) continue;
        const t = (s - sg.start) / (sg.len || 1), x = lerp(sg.a.x, sg.b.x, t), z = lerp(sg.a.z, sg.b.z, t);
        const tx = (sg.b.x - sg.a.x) / (sg.len || 1), tz = (sg.b.z - sg.a.z) / (sg.len || 1);
        const ease = smoothstep(0, 22, 45 - Math.abs(s - s0));
        const off = e.width * 0.5 + lerp(0.2, 3.6, ease);
        pts.push({ x: x - tz * off * side, z: z + tx * off * side });
      }
      if (pts.length > 4 && !nearLines(ctx, pts[0].x, pts[0].z, 30)) out.push(pts);
    }
  }
  return out;
}

/** Footway beside the town's roads, and the market square. */
function paintSurfaces(ctx) {
  const { graph, surface } = ctx;
  for (const e of graph.edges) {
    if (e.dead || e.kind === 'country' || e.kind === 'alley' || e.kind === 'dual' || e.turningHead || e.hill) continue;
    const mid = e.points[Math.floor(e.points.length / 2)];
    if (Math.hypot(mid.x, mid.z) > 1350) continue;
    for (const s of e.segs) {
      const steps = Math.max(1, Math.ceil(s.len / Math.max(CELL * 0.9, (e.width * 0.5 + 7) * 0.25)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(s.a.x, s.b.x, t), lerp(s.a.z, s.b.z, t), e.width * 0.5 + (e.kind === 'lane' ? 4.5 : 6.5), SURF_PAVED);
      }
    }
    e.pave = e.kind === 'lane' ? 4.5 : 6.5;
  }
  paintDisc(surface, 0, 0, SQUARE_R, SURF_PAVED);
}

// =====================================================================
//  Drawing the ground
// =====================================================================

function hash(x, z, k) {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z, size, k) {
  const fx = x / size, fz = z / size, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = hash(i, j, k), b = hash(i + 1, j, k), c = hash(i, j + 1, k), d = hash(i + 1, j + 1, k);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return lerp(lerp(a, b, su), lerp(c, d, su), sv);
}

function buildTerrain(ctx, hgrid) {
  const sf = ctx.surfAt, water = ctx.water;
  // Under the pavements too: "on a hill bit with the houses ... the occasional bit where like a bit of green ground poked through
  // instead of the pavement". The footway is drawn from the road's points, 6 m apart, straight between them over the 4 m ground.
  const nearRoad = (x, z) => {
    // Well under water where it is: the far tiles, 12 m a step across a 30 m river, stood up through it in green patches.
    const lv = water.levelAt(x, z);
    if (lv !== null && hgrid.at(x, z) < lv - 0.3 && !water.fordAt(x, z)) return 1.5;
    for (const [ox, oz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
      const v = sf(x + ox, z + oz);
      if (v === SURF_ROAD || v === SURF_PAVED) return 0.45;
    }
    return 0;
  };
  const colour = (x, z, y, c) => {
    const w = water.levelAt(x, z);
    if (w !== null && y < w + 0.6) { c.setHSL(0.10, 0.25, 0.16); return; }
    const r = Math.hypot(x, z);
    // Fields out of town: a patchwork, lighter and darker, some of it ploughed.
    const f = vnoise(x, z, 160, 3);
    if (r > TOWN_EDGE + 80 && f > 0.78) c.setHSL(0.09, 0.28, 0.26 + vnoise(x, z, 30, 5) * 0.04);
    else c.setHSL(0.22 + f * 0.06, 0.32 + vnoise(x, z, 70, 7) * 0.08, 0.25 + vnoise(x, z, 45, 9) * 0.06);
    c.offsetHSL(0, -0.04, Math.min(0.06, y / 600));
  };
  const TILE = 300, TILE_FAR = 450, H = WORLD_HALF;
  const terrain = new THREE.Group();
  terrain.name = 'terrain';
  for (let x0 = -H; x0 < H; x0 += TILE) {
    for (let z0 = -H; z0 < H; z0 += TILE) {
      const patch = { x0, z0, size: TILE }, cx = x0 + TILE / 2, cz = z0 + TILE / 2;
      const lod = new THREE.LOD();
      lod.position.set(cx, 0, cz);
      for (const [step, dist] of [[4, 0], [12, TILE_FAR]]) {
        const m = buildTerrainMesh(hgrid, colour, step, step > 4 ? (x, z) => nearRoad(x, z) * 1.8 : nearRoad, 0, patch);
        m.renderOrder = DRAW_ORDER.ground;
        m.position.set(-cx, 0, -cz);
        lod.addLevel(m, dist);
      }
      terrain.add(lod);
    }
  }
  const plate = { half: EDGE_FACE + 4, at: () => 0 };
  const ring = buildTerrainMesh(plate, (x, z, y, c) => c.setHSL(0.24, 0.32, 0.27), 20, null, H);
  ring.name = 'terrain-edge';
  ring.renderOrder = DRAW_ORDER.ground;
  return [terrain, ring];
}

function liftRoads(ctx, meshes) {
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
  for (const e of graph.edges) if (e.pave && !e.dead) b.addRibbon(e.points, e.width + e.pave * 2, KERB_H, PALETTE.pavement);
  for (const n of graph.nodes) {
    const app = approachesAt(graph, n).filter((a) => a.edge && a.edge.pave);
    if (app.length) addNodeWedges(b, n, app, (e) => e.width * 0.5 + e.pave, KERB_H - 0.001, PALETTE.pavement);
  }
  // The market square: York stone, in 4 m squares that follow the ground.
  for (let x = -SQUARE_R; x < SQUARE_R; x += 4) {
    for (let z = -SQUARE_R; z < SQUARE_R; z += 4) {
      if (Math.hypot(x + 2, z + 2) > SQUARE_R) continue;
      const tone = 0.5 + hash(x, z, 2) * 0.06;
      b.addQuadY(x, z, x + 4, z, x + 4, z + 4, x, z + 4, KERB_H - 0.002, new THREE.Color(tone, tone * 0.96, tone * 0.88));
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

/** Flat things on the ground: the towpath, the laybys, the bus lanes, the car park on the Beacon. */
function buildExtrasFlat(ctx, canal) {
  const { graph } = ctx;
  const b = new MeshBuilder();
  if (canal) {
    // In runs, broken where a road crosses (the bridge is the road's).
    let run = [];
    const flush = () => { if (run.length > 1) b.addRibbon(run, 4.2, 0, 0x6e6555); run = []; };
    for (const p of canal.tow) {
      if (onARoad(graph, p.x, p.z, 1)) { flush(); continue; }
      run.push(p);
    }
    flush();
  }
  for (const l of ctx.laybys) b.addRibbon(l, 4.6, 0, 0x2a2d31);
  // Bus lanes: red down the kerb side of the town's A-roads and the High Street. "bus lanes in town".
  for (const e of graph.edges) {
    if (e.dead || e.kind !== 'avenue') continue;
    const mid = e.points[Math.floor(e.points.length / 2)];
    if (Math.hypot(mid.x, mid.z) > 820 || e.length < 80) continue;
    const pts = e.points.slice(2, -2);
    if (pts.length < 2) continue;
    for (const side of [1, -1]) b.addRibbon(pts, 3.0, 0.004, 0x7a2a24, side * (e.width * 0.5 - 1.8));
  }
  if (ctx.summit) {
    const { x, z } = ctx.summit;
    for (let k = 0; k < 24; k++) {
      const a0 = (k / 24) * TAU, a1 = ((k + 1) / 24) * TAU;
      b.addQuadY(x, z, x + Math.cos(a0) * 24, z + Math.sin(a0) * 24, x + Math.cos(a1) * 24, z + Math.sin(a1) * 24, x, z, 0, 0x2c2e31);
    }
  }
  if (!b.vertexCount) return null;
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
  liftMesh(mesh, ctx.at, LIFT + 0.02);
  mesh.name = 'extras';
  mesh.receiveShadow = true;
  groundDetail(mesh, 'tarmac');
  return chunkMesh(mesh, 300);
}

// =====================================================================
//  Buildings
// =====================================================================

/**
 * An edge's line as a few longer straight runs, for laying things along: its pieces joined while they turn less than a seventh of
 * a radian and are under 70 m. A street's bends, rounded off, are pieces of 2-5 m, and anything laid piece by piece skipped
 * those under 10 m -- whole streets had a house or two.
 */
function runsOf(e) {
  const out = [];
  let a = null, b = null, dir = null;
  for (const g of e.segs) {
    if (g.len < 1e-3) continue;
    const gd = Math.atan2(g.b.z - g.a.z, g.b.x - g.a.x);
    if (a) {
      const L = Math.hypot(g.b.x - a.x, g.b.z - a.z), turn = Math.abs(Math.atan2(Math.sin(gd - dir), Math.cos(gd - dir)));
      if (turn < 0.14 && L < 70) { b = g.b; continue; }
      out.push({ a, b, len: Math.hypot(b.x - a.x, b.z - a.z) });
    }
    a = g.a; b = g.b; dir = gd;
  }
  if (a) out.push({ a, b, len: Math.hypot(b.x - a.x, b.z - a.z) });
  return out;
}

/** Shopfronts' paint, and the shops on the fascias: made up, none of them real. */
const SHOP_TONES = [0x2f4f3a, 0x5a1f22, 0x1f3550, 0x3b3b3b, 0x6a4a1c, 0x24443f, 0x4b2a4f, 0x7a6b52];
const SHOP_NAMES = [
  ["Mr Buffy's Chicken", '#c8281e', '#ffd23f'], ['Wexbury Fish Bar', '#1d4e89', '#ffffff'], ['Golden Dragon', '#8b0000', '#ffcc33'],
  ['Pizza Palace', '#1e6b30', '#ffffff'], ["Patel's News", '#1b1b1b', '#f5f5f5'], ['The Crusty Loaf', '#7a4a21', '#fff2d6'],
  ['Kut & Kurl', '#e0398a', '#ffffff'], ['Bargain Barn', '#f2c21b', '#1b1b1b'], ['Wexbury Pharmacy', '#0a7d5a', '#ffffff'],
  ['Phone Fix', '#2b2b6e', '#7ee0ff'], ['The Coffee Pot', '#3b2a1e', '#f0d9b5'], ['Spin City Laundrette', '#5ab4e6', '#10324a'],
  ['Hope Charity Shop', '#6a2c8c', '#ffffff'], ['Bet Bros', '#0b6b2a', '#ffe14d'], ['Kebab King', '#d4471b', '#ffffff'],
  ['Market Butchers', '#8c1c1c', '#f7f0e0'],
];

/** The fascias' names, one canvas of them, and a board each in front of its shop, reading left to right from the street. */
function shopSigns(signs) {
  if (!signs.length || typeof document === 'undefined') return null;
  const TW = 512, TH = 96, COLS = 2, ROWS = Math.ceil(SHOP_NAMES.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = TW * COLS; cv.height = TH * ROWS;
  const g = cv.getContext('2d');
  SHOP_NAMES.forEach(([name, bg, fg], k) => {
    const x = (k % COLS) * TW, y = Math.floor(k / COLS) * TH;
    g.fillStyle = bg; g.fillRect(x, y, TW, TH);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 4; g.strokeRect(x + 6, y + 6, TW - 12, TH - 12);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 58;
    do { g.font = `bold ${size}px Georgia, serif`; size -= 2; } while (g.measureText(name).width > TW - 40 && size > 20);
    g.fillText(name, x + TW / 2, y + TH / 2 + 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const pos = [], uv = [];
  for (const sg of signs) {
    const rx = sg.fz, rz = -sg.fx, hw = sg.w * 0.5, y0 = sg.lo + 2.88, y1 = sg.lo + 3.52;
    const k = sg.tile, u0 = (k % COLS) / COLS, u1 = u0 + 1 / COLS, v1 = 1 - Math.floor(k / COLS) / ROWS, v0 = v1 - 1 / ROWS;
    const L = [sg.x - rx * hw, sg.z - rz * hw], R = [sg.x + rx * hw, sg.z + rz * hw];
    pos.push(L[0], y0, L[1], R[0], y0, R[1], R[0], y1, R[1], L[0], y0, L[1], R[0], y1, R[1], L[0], y1, L[1]);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide }));
  mesh.name = 'town';
  return mesh;
}

class Placed {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); }
  free(x, z, r) {
    const c = Math.ceil(r / this.cell) + 1, ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell);
    for (let i = ix - c; i <= ix + c; i++) for (let j = iz - c; j <= iz + c; j++) {
      const list = this.map.get(`${i},${j}`);
      if (!list) continue;
      for (const p of list) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) return false;
    }
    return true;
  }
  add(x, z, r) {
    const k = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
    (this.map.get(k) || this.map.set(k, []).get(k)).push({ x, z, r });
  }
}

/** Lift the vertices of each piece of a builder by the ground at the piece's own spot (before it is built). */
function liftBuilder(b, pieces, at) {
  const p = b.pos;
  for (const [s, e, x, z, y] of pieces) {
    const h = y !== undefined ? y : at(x, z);
    for (let k = s; k < e; k++) p[k * 3 + 1] += h;
  }
}

/** The lowest ground under a footprint, so nothing floats on a slope; and how much it falls across it. */
function footing(at, x, z, w, d, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  let lo = Infinity, hi = -Infinity;
  for (const [ox, oz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
    const lx = ox * w, lz = oz * d, h = at(x + lx * c + lz * s, z - lx * s + lz * c);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { lo, fall: hi - lo };
}

/** Clear of the railway and canal, and the water. */
function clearSpot(ctx, x, z, r) {
  if (nearLines(ctx, x, z, r + 6)) return false;
  return ctx.water.levelAt(x, z) === null;
}

/**
 * The church on the square, its spire the tallest thing in town; the market cross; and the market's stalls, on market
 * days: "a market square that has stalls on some days". Wednesdays and Saturdays.
 */
function buildLandmarks(ctx) {
  const { sim, rng } = ctx, at = ctx.at, W = sim.world;
  const b = new MeshBuilder(), pieces = [];
  const stone = 0x8c8577, dark = 0x3b3833;
  // The market cross: a stepped base and a column.
  {
    const s = b.vertexCount, y = at(0, 0) + KERB_H;
    b.addBox(5, 0.5, 5, 0, 0.25, 0, stone);
    b.addBox(3.4, 0.5, 3.4, 0, 0.75, 0, stone);
    b.addBox(0.9, 6, 0.9, 0, 4, 0, 0x9a9384);
    b.addBox(1.6, 0.6, 1.6, 0, 7.2, 0, stone);
    pieces.push([s, b.vertexCount, 0, 0, y]);
    addStaticBox(W, 0, y + 1, 0, 2.5, 1, 2.5, GROUP.BUILDING);
    addStaticBox(W, 0, y + 4, 0, 0.6, 4, 0.6, GROUP.BUILDING);
    ctx.placed.add(0, 0, 4);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26, bx = Math.cos(a) * 9, bz = Math.sin(a) * 9;
      ctx.props.push({ kind: 'bench', x: bx, z: bz, rot: Math.atan2(-bx, -bz) });
    }
    // And round the square, benches facing in with a bin beside every other one: "the square in the centre needs like loads of
    // benches and bins around, because otherwise it just looks empty and barren." Between the market's rows (22 and 40 m).
    for (const [r, n] of [[31, 14], [47, 22]]) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + r * 0.013, bx = Math.cos(a) * r, bz = Math.sin(a) * r;
        ctx.props.push({ kind: 'bench', x: bx, z: bz, rot: Math.atan2(-bx, -bz) });
        if (k % 2 === 0) {
          const b2 = a + 1.6 / r;
          ctx.props.push({ kind: 'bin', x: Math.cos(b2) * r, z: Math.sin(b2) * r, rot: Math.atan2(-bx, -bz) });
        }
      }
    }
    // Lamps round the edge, and round the cross.
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + 0.13;
      ctx.props.push({ kind: 'lamp', x: Math.cos(a) * 44, z: Math.sin(a) * 44, rot: a + Math.PI / 2 });
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      ctx.props.push({ kind: 'lamp', x: Math.cos(a) * 15, z: Math.sin(a) * 15, rot: a + Math.PI / 2 });
    }
  }
  // The church: on the first open ground off the square, facing it.
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU + 0.3, r = 128;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, rot = Math.atan2(-x, -z);
    if (ctx.graph.overlapsRoad(x, z, 18, 32, rot, 4) || !clearSpot(ctx, x, z, 20)) continue;
    const { lo } = footing(at, x, z, 18, 32, rot);
    const s = b.vertexCount;
    b.addBox(16, 11, 26, x, 5.5 - 2, z, 0x9b9283, rot);
    b.addTaperedBox(16.6, 6, 26.6, x, 11 + 3 - 2, z, 0x4a4640, 0.12, 1, rot);
    // The tower, at the west end, and its spire.
    const fx = Math.sin(rot), fz = Math.cos(rot), tx = x - fx * 15, tz = z - fz * 15;
    b.addBox(7, 22, 7, tx, 11 - 2, tz, 0x958c7c, rot);
    b.addTaperedBox(6.6, 20, 6.6, tx, 22 + 10 - 2, tz, 0x5a554c, 0.04, 0.04, rot);
    pieces.push([s, b.vertexCount, x, z, lo]);
    addStaticBox(W, x, lo + 5, z, 8, 7, 13, GROUP.BUILDING, rot);
    addStaticBox(W, tx, lo + 10, tz, 3.5, 12, 3.5, GROUP.BUILDING, rot);
    ctx.placed.add(x, z, 18);
    ctx.placed.add(tx, tz, 6);
    break;
  }
  // Market days: rows of stalls round the cross, with room between them to drive.
  const day = new Date().getDay();
  ctx.marketDay = day === 3 || day === 6;
  if (ctx.marketDay) {
    const stripes = [0xc23b31, 0x2c6db5, 0x2f8a4c, 0xd9a21b];
    for (const [rr, count] of [[22, 10], [40, 16]]) {
      for (let k = 0; k < count; k++) {
        if (k % 4 === 3) continue;          // the aisles
        const a = (k / count) * TAU + rr * 0.01, x = Math.cos(a) * rr, z = Math.sin(a) * rr, rot = Math.atan2(x, z);
        const y = at(x, z) + KERB_H, s = b.vertexCount, col = stripes[k % stripes.length];
        b.addBox(3.2, 0.9, 2.0, x, 0.45, z, 0x6b5136, rot);
        for (const [ox, oz] of [[-1.5, -0.9], [1.5, -0.9], [-1.5, 0.9], [1.5, 0.9]]) {
          const c = Math.cos(rot), sn = Math.sin(rot);
          b.addBox(0.08, 2.4, 0.08, x + ox * c + oz * sn, 1.2, z - ox * sn + oz * c, 0xdddddd, rot);
        }
        b.addTaperedBox(3.6, 0.5, 2.6, x, 2.55, z, col, 0.2, 1, rot);
        b.addTaperedBox(3.62, 0.12, 2.62, x, 2.36, z, 0xf2efe6, 1, 1, rot);
        pieces.push([s, b.vertexCount, x, z, y]);
        addStaticBox(W, x, y + 0.45, z, 1.6, 0.45, 1.0, GROUP.BUILDING, rot);
        ctx.placed.add(x, z, 2.5);
      }
    }
  }
  liftBuilder(b, pieces, at);
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  buildingDetail(mesh, 'brick');
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'town';
  return [mesh];
}

/** Every road lined with buildings: shops at the middle, terraces, then houses behind gardens, then farms. */
function buildFrontages(ctx) {
  const { graph, rng, sim } = ctx, at = ctx.at;
  const builders = [new MeshBuilder(), new MeshBuilder(), new MeshBuilder(), new MeshBuilder()];
  const pieces = [[], [], [], []];
  const lit = new MeshBuilder(), litPieces = [];
  const drives = [], placed = ctx.placed, gardens = [], signs = [];
  ctx.gardens = gardens;
  ctx.whyNot = {};
  const out0 = [];
  const paveOf = (e) => e.pave || 0;
  let count = 0;
  for (const e of graph.edges) {
    if (e.dead || e.kind === 'dual' || e.kind === 'alley' || e.width === 11 || e.hill) continue;
    for (const s of runsOf(e)) {
      const len = s.len;
      if (len < 10) continue;
      const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len, nx = -dz, nz = dx;
      for (const side of [1, -1]) {
        let along = rand(rng, 2, 10);
        while (along < len - 5) {
          const px = s.a.x + dx * along, pz = s.a.z + dz * along, r = Math.hypot(px, pz);
          let w, d, h, setback, gap, colour, roofDark, kind;
          if (r < 220) {
            w = rand(rng, 7, 11); d = rand(rng, 10, 15); h = rand(rng, 8, 13);
            setback = e.width * 0.5 + rand(rng, 5.5, 7.5); gap = rand(rng, 0.2, 1.2); kind = 'shop';
            colour = new THREE.Color().setHSL(rand(rng, 0.05, 0.11), rand(rng, 0.16, 0.34), rand(rng, 0.30, 0.46));
            roofDark = 0x2c2622;
          } else if (r < 470) {
            // Terraces, shoulder to shoulder.
            w = rand(rng, 5.5, 7); d = rand(rng, 9, 12); h = rand(rng, 7, 8.5);
            setback = e.width * 0.5 + rand(rng, 6.5, 8); gap = rand(rng, 0, 0.3); kind = 'house';
            colour = new THREE.Color().setHSL(rand(rng, 0.03, 0.07), rand(rng, 0.24, 0.42), rand(rng, 0.25, 0.36));
            roofDark = 0x30292a;
          } else if (r < 1250) {
            if (e.kind === 'country' && rng() < 0.75) { along += rand(rng, 40, 90); continue; }
            w = rand(rng, 9, 14); d = rand(rng, 9, 13); h = rand(rng, 5.5, 7.5);
            setback = e.width * 0.5 + rand(rng, 9, 15); gap = rand(rng, 5, 13); kind = 'house';
            colour = new THREE.Color().setHSL(rand(rng, 0.06, 0.12), rand(rng, 0.10, 0.24), rand(rng, 0.38, 0.56));
            roofDark = 0x3a3330;
          } else {
            if (rng() < 0.75) { along += rand(rng, 40, 80); continue; }
            w = rand(rng, 12, 22); d = rand(rng, 10, 18); h = rand(rng, 5, 9);
            setback = e.width * 0.5 + rand(rng, 14, 26); gap = rand(rng, 40, 90); kind = 'barn';
            colour = new THREE.Color().setHSL(rand(rng, 0.07, 0.11), rand(rng, 0.10, 0.20), rand(rng, 0.32, 0.44));
            roofDark = 0x33302b;
          }
          const bx = px + nx * side * (setback + d * 0.5), bz = pz + nz * side * (setback + d * 0.5), radius = Math.hypot(w, d) * 0.5;
          const why = Math.hypot(bx, bz) < SQUARE_R + radius + 4 || Math.abs(bx) > WORLD_HALF - 30 || Math.abs(bz) > WORLD_HALF - 30 ? 'edge'
            : !placed.free(bx, bz, Math.min(w, d) * 0.46) ? 'placed' : graph.overlapsRoad(bx, bz, w, d, Math.atan2(dx, dz), 3.5) ? 'road' : !clearSpot(ctx, bx, bz, radius) ? 'lines' : null;
          if (why) {
            if (r < 470) ctx.whyNot[why] = (ctx.whyNot[why] || 0) + 1;
            along += w + gap;
            continue;
          }
          const rot = Math.atan2(nx * side, nz * side), fx = -nx * side, fz = -nz * side;
          const { lo, fall } = footing(at, bx, bz, w, d, rot);
          if (fall > 4) { if (r < 470) ctx.whyNot.fall = (ctx.whyNot.fall || 0) + 1; along += w + gap; continue; }
          if (r < 470) ctx.whyNot.built = (ctx.whyNot.built || 0) + 1;
          const q = (bx >= 0 ? 1 : 0) + (bz >= 0 ? 2 : 0), b = builders[q], st = b.vertexCount, ls = lit.vertexCount;
          b.addTaperedBox(w, h, d, bx, h * 0.5, bz, colour, 1, 1, rot);
          b.addTaperedBox(w * 1.04, h * 0.28, d * 1.04, bx, h + h * 0.12, bz, roofDark, 0.55, 0.75, rot);
          // A plinth down into the slope, so the downhill side does not stand on air.
          b.addBox(w * 1.02, fall + 1.2, d * 1.02, bx, 0.35 - (fall + 1.2) * 0.5 + 0.35, bz, 0x2b2724, rot);
          const face = d * 0.5 + 0.06;
          addWindows(b, lit, bx, bz, w, h, d, rot, fx, fz, kind === 'shop' ? 'shop' : 'house');
          if (kind === 'house') planDrive(drives, bx, bz, w, d, rot, fx, fz);
          if (kind === 'shop') {
            // A shopfront: "it's just like a black strip ... put like the actual ... Mr. Buffy's chicken or something". Glass in a
            // painted frame, a door at one end, a stall riser under it, and the fascia with the shop's name (shopSigns).
            const tone = SHOP_TONES[Math.floor(hash(bx, bz, 7) * SHOP_TONES.length)];
            const ox = Math.cos(rot), oz = -Math.sin(rot), fw = w * 0.9, door = Math.min(1.2, w * 0.16), dside = hash(bx, bz, 8) < 0.5 ? -1 : 1;
            const at2 = (along, out) => [bx + fx * (face + out) + ox * along, bz + fz * (face + out) + oz * along];
            let [qx, qz] = at2(0, 0.02);
            b.addBox(fw, 3.0, 0.1, qx, 1.5, qz, tone, rot);
            [qx, qz] = at2(-dside * door * 0.55, 0.08);
            b.addBox(fw - door - 0.5, 1.9, 0.06, qx, 1.55, qz, 0x6f8c99, rot);
            [qx, qz] = at2(-dside * door * 0.55, 0.07);
            b.addBox(fw - door - 0.4, 0.45, 0.1, qx, 0.3, qz, tone, rot);
            [qx, qz] = at2(dside * (fw * 0.5 - door * 0.6), 0.08);
            b.addBox(door, 2.3, 0.06, qx, 1.15, qz, 0x3a4248, rot);
            [qx, qz] = at2(0, 0.1);
            b.addBox(fw + 0.2, 0.75, 0.22, qx, 3.2, qz, 0x1f1f22, rot);
            signs.push({ x: bx + fx * (face + 0.22), z: bz + fz * (face + 0.22), fx, fz, w: fw, lo, tile: Math.floor(hash(bx, bz, 9) * SHOP_NAMES.length) });
          } else {
            const doorW = Math.min(1.15, w * 0.18), doorH = Math.min(2.15, h * 0.34);
            b.addBox(doorW, doorH, 0.12, bx + fx * face, doorH * 0.5, bz + fz * face, kind === 'barn' ? 0x3a2a1a : 0x2e2018, rot);
            const ox = Math.cos(rot), oz = -Math.sin(rot), winOff = w * 0.28;
            for (const sgn of [-1, 1]) b.addBox(w * 0.22, h * 0.18, 0.10, bx + fx * face + ox * sgn * winOff, h * 0.55, bz + fz * face + oz * sgn * winOff, 0x16202a, rot);
          }
          pieces[q].push([st, b.vertexCount, bx, bz, lo]);
          litPieces.push([ls, lit.vertexCount, bx, bz, lo]);
          addStaticBox(sim.world, bx, lo + h * 0.5, bz, w * 0.5, h * 0.5, d * 0.5, GROUP.BUILDING, rot);
          placed.add(bx, bz, Math.min(w, d) * 0.46);  // By its width: by its diagonal, the next house in a terrace, 6 m on, was always inside it and every other one was refused.
          count++;
          // A back garden behind it, fenced, a shed in some: "a lot of just sparse open areas with nothing in between lots of
          // houses". The middles of the blocks were bare grass.
          if (kind === 'house' && r < 1250) {
            const gd = r < 470 ? rand(rng, 12, 22) : rand(rng, 14, 26), gw = w + gap * 0.9;
            const ox = -fx, oz = -fz, gx = bx + ox * (d * 0.5 + gd * 0.5), gz = bz + oz * (d * 0.5 + gd * 0.5), gr = Math.hypot(gw, gd) * 0.5;
            if (placed.free(gx, gz, gr * 0.6) && !graph.overlapsRoad(gx, gz, gw, gd, Math.atan2(dx, dz), 2) && clearSpot(ctx, gx, gz, gr)) {
              gardens.push({ x: gx, z: gz, w: gw, d: gd, rot, ox, oz });
              placed.add(gx, gz, gr * 0.6);
            }
          }
          along += w + gap;
        }
      }
    }
  }
  ctx.buildingCount = count;
  // The gardens are not drawn: no fences ("the backyard fences ... I think just get rid of them"), and the lawns, a shade off the
  // ground's, were strips of colour across every block. What is in them (sheds, trees) is.
  const laid = layDrives(sim, graph, drives, paveOf, at);
  ctx.parked = laid.parked;
  ctx.driveStrips = laid.strips;
  const out = out0;
  if (laid.mesh) out.push(laid.mesh);
  liftBuilder(lit, litPieces, at);
  ctx.signs = signs;
  const signMesh = shopSigns(signs);
  if (signMesh) out.push(signMesh);
  const litMesh = litWindows(lit);
  if (litMesh) out.push(litMesh);
  for (let q = 0; q < 4; q++) {
    if (!builders[q].vertexCount) continue;
    liftBuilder(builders[q], pieces[q], at);
    const mesh = new THREE.Mesh(builders[q].build(), vertexColorMaterial());
    mesh.name = 'town';
    buildingDetail(mesh, 'brick');
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(chunkMesh(mesh, 250));
  }
  return out;
}

// =====================================================================
//  Street furniture and the canal's stonework
// =====================================================================

/**
 * The bumps drawn; width restrictions ("width restrictions" -- a pair of planters each side, a lane's gap between); the
 * bridges' parapets over the canal; the locks' gates; the bench and the toposcope on the Beacon.
 */
function buildFurniture(ctx, canal) {
  const { graph, sim } = ctx, at = ctx.at, W = sim.world, rng = ctx.lrng;
  const b = new MeshBuilder(), pieces = [];
  for (const bp of ctx.bumps) {
    const rot = Math.atan2(bp.tx, bp.tz), s = b.vertexCount;
    b.addTaperedBox(bp.hw * 2, BUMP_H, BUMP_HALF * 2, bp.x, BUMP_H * 0.5, bp.z, 0x3a3532, 1, 0.45, rot);
    for (const o of [-bp.hw * 0.5, 0, bp.hw * 0.5]) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      b.addBox(0.5, 0.012, 0.9, bp.x + o * c, BUMP_H + 0.006, bp.z - o * sn, 0xe8e4da, rot);
    }
    pieces.push([s, b.vertexCount, bp.x, bp.z, at(bp.x, bp.z) + LIFT]);
  }
  // Width restrictions: on a few long straight streets in the estates, away from the bumps.
  let pinches = 0;
  for (const e of graph.edges) {
    if (pinches >= 10) break;
    if (e.dead || e.kind !== 'street' || e.width === 11 || e.length < 140 || rng() < 0.6) continue;
    const s = e.length * 0.5, sg = e.segs.find((g) => s >= g.start && s <= g.start + g.len);
    if (!sg) continue;
    const t = (s - sg.start) / (sg.len || 1), x = lerp(sg.a.x, sg.b.x, t), z = lerp(sg.a.z, sg.b.z, t), r = Math.hypot(x, z);
    if (r < 200 || r > 1200 || nearLines(ctx, x, z, 40) || ctx.bumps.some((bp) => Math.hypot(bp.x - x, bp.z - z) < 30)) continue;
    const tx = (sg.b.x - sg.a.x) / (sg.len || 1), tz = (sg.b.z - sg.a.z) / (sg.len || 1), rot = Math.atan2(tx, tz);
    const gapHalf = 3.7, outer = e.width * 0.5, wIs = outer - gapHalf, y = at(x, z) + LIFT;
    for (const side of [1, -1]) {
      const off = (gapHalf + wIs * 0.5) * side, cx = x - tz * off, cz = z + tx * off, st = b.vertexCount;
      b.addBox(wIs, 0.55, 2.2, cx, 0.275, cz, 0x7b7a76, rot + Math.PI / 2);
      b.addBox(wIs - 0.3, 0.25, 1.9, cx, 0.66, cz, 0x3f6a32, rot + Math.PI / 2);
      // Bollards along the gap's edge, to knock over (game/streetprops.js): "there's some bollards ... You can move through
      // them". They were drawn with nothing to hit.
      for (const along of [-1.6, -0.55, 0.55, 1.6]) {
        const bx = x - tz * (gapHalf + 0.15) * side + tx * along, bz = z + tx * (gapHalf + 0.15) * side + tz * along;
        ctx.props.push({ kind: 'bollard', x: bx, z: bz, rot });
      }
      pieces.push([st, b.vertexCount, x, z, y]);
      addStaticBox(W, cx, y + 0.45, cz, 1.1, 0.45, wIs * 0.5, GROUP.BUILDING, rot);
    }
    pinches++;
  }
  ctx.pinches = pinches;
  if (ctx.summit) {
    const { x, z } = ctx.summit, y = at(x, z) + LIFT, st = b.vertexCount;
    // The toposcope on its plinth, and a row of benches at the car park's edge looking back at the town: "make them actually look
    // like benches ... make sure you can like push them around" (game/streetprops.js).
    b.addBox(1.4, 1.1, 1.4, x + 10, 0.55, z, 0x9a9384);
    b.addTaperedBox(1.6, 0.15, 1.6, x + 10, 1.17, z, 0x6b5a3a, 0.8, 1);
    const toward = Math.atan2(-x, -z);
    for (const o of [-6, -2, 2, 6]) {
      const bx = x + Math.sin(toward) * 21 + Math.cos(toward) * o, bz = z + Math.cos(toward) * 21 - Math.sin(toward) * o;
      ctx.props.push({ kind: 'bench', x: bx, z: bz, rot: toward });
    }
    pieces.push([st, b.vertexCount, x, z, y]);
    addStaticBox(W, x + 10, y + 0.6, z, 0.7, 0.6, 0.7, GROUP.BUILDING);
  }
  if (!b.vertexCount) return [];
  liftBuilder(b, pieces, at);
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  mesh.name = 'furniture';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return [chunkMesh(mesh, 300)];
}

/** The canal's water and the ford's, as Ashfield's river: one ribbon down each, at its level. */
function buildWater(ctx, canal) {
  const pos = [], uv = [], idx = [];
  const strip = (rows) => {
    const base = pos.length / 3;
    let s = 0, prev = null;
    for (const r of rows) {
      if (prev) s += Math.hypot(r.x - prev.x, r.z - prev.z);
      pos.push(r.x - r.ax * r.w, r.y, r.z - r.az * r.w, r.x + r.ax * r.w, r.y, r.z + r.az * r.w);
      uv.push(0, s / 30, (2 * r.w) / 30, s / 30);
      prev = r;
    }
    for (let k = 0; k < rows.length - 1; k++) {
      const a = base + k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  if (canal) {
    // A strip per pound, so the water steps at the locks.
    for (const p of canal.pounds) {
      // On under the bridges, which are drawn over it (buildCanalBanks); out a little past where it meets the banks.
      let rows2 = [];
      for (let s = p.wa; s <= p.wb; s += 4) {
        const q = canal.line.at(s);
        rows2.push({ x: q.x, z: q.z, ax: -q.dz, az: q.dx, w: CANAL_HALF + 2, y: canal.waterAtS(s) });
      }
      if (rows2.length > 1) strip(rows2);
    }
  }
  const lk = ctx.lake;
  if (lk) {
    const base = pos.length / 3, N = 72;
    pos.push(lk.x, lk.level, lk.z); uv.push(lk.x / 30, lk.z / 30);
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * TAU, x = lk.x + Math.cos(a) * (lk.Rat(a) - 2), z = lk.z + Math.sin(a) * (lk.Rat(a) - 2);
      pos.push(x, lk.level, z); uv.push(x / 30, z / 30);
    }
    for (let k = 0; k < N; k++) idx.push(base, base + 1 + k, base + 2 + k);
  }
  const f = ctx.ford;
  if (f) {
    const rows = f.stream.filter((_, k) => k % 2 === 0).map((p) => ({ x: p.x, z: p.z, ax: f.tx, az: f.tz, w: 4.5, y: f.level }));
    strip(rows);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const normalMap = rippleNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b4a3c, roughness: 0.08, metalness: 0.12, transparent: true, opacity: 0.88,
    normalMap, normalScale: new THREE.Vector2(0.3, 0.3), envMapIntensity: 1.1,
    // Both sides: the strips are laid each their own way round, and one way faced down and was never drawn.
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'river';
  mesh.receiveShadow = true;
  mesh.userData.update = (dt) => { normalMap.offset.y -= dt * 0.012; };
  return mesh;
}

// =====================================================================
//  Trees
// =====================================================================

function addTreeT(ctx, b, pieces, x, z, scale = 1) {
  const { rng, graph } = ctx;
  if (graph.overlapsRoad(x, z, 2.4, 2.4, 0, 2.5)) return false;
  const h = rand(rng, 7, 14) * scale;
  if (nearBuilding(ctx.sim.world, x, z, h * 0.4)) return false;
  const crown = new THREE.Color().setHSL(rand(rng, 0.22, 0.31), rand(rng, 0.30, 0.48), rand(rng, 0.12, 0.21));
  const turn = rand(rng, 0, TAU);
  if (ctx.clearAt(x, z) || ctx.water.levelAt(x, z) !== null) return false;
  if (Math.abs(x) > WORLD_HALF - 40 || Math.abs(z) > WORLD_HALF - 40) return false;
  if (ctx.summit && Math.hypot(x - ctx.summit.x, z - ctx.summit.z) < 40) return false;
  const s = b.vertexCount;
  drawTree(b, x, z, h, crown, turn, 0.3);
  pieces.push([s, b.vertexCount, x, z]);
  const g = ctx.at(x, z);
  addStaticBox(ctx.sim.world, x, g + 2.6, z, 0.65, 2.6, 0.65, GROUP.PROP);
  const r = h * 0.8 * 0.35;
  let top = g;
  for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) top = Math.max(top, ctx.at(x + ox, z + oz));
  addCanopy(ctx.sim.world, x, z, top, h * 0.66, h * 0.72, h * 0.8);
  return true;
}

/** Woods on the hills and between the fields, trees along the lanes and the canal, a few in the town's streets. */
function buildTrees(ctx) {
  const { rng, graph } = ctx;
  const b = new MeshBuilder(), pieces = [];
  const H = WORLD_HALF;
  for (let c = 0; c < 150; c++) {
    const a = rng() * TAU, r = rand(rng, TOWN_EDGE + 40, H - 80), cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const n = randInt(rng, 5, 15), spread = rand(rng, 14, 44);
    for (let i = 0; i < n; i++) addTreeT(ctx, b, pieces, cx + rand(rng, -spread, spread), cz + rand(rng, -spread, spread), rand(rng, 0.8, 1.2));
  }
  // Thicker on the hills' flanks.
  for (const hl of ctx.hills) {
    for (let i = 0; i < 70; i++) {
      const a = rng() * TAU, r = hl.r * Math.sqrt(rng()) * 0.9;
      addTreeT(ctx, b, pieces, hl.x + Math.cos(a) * r, hl.z + Math.sin(a) * r, rand(rng, 0.85, 1.2));
    }
  }
  for (const e of graph.edges) {
    if (e.dead || !(e.kind === 'country' || e.kind === 'lane' || e.kind === 'dual' || e.kind === 'avenue')) continue;
    for (const s of runsOf(e)) {
      const steps = Math.floor(s.len / 22);
      for (let k = 0; k < steps; k++) {
        if (rng() < 0.6) continue;
        const t = (k + 0.5) / steps, px = lerp(s.a.x, s.b.x, t), pz = lerp(s.a.z, s.b.z, t);
        if (Math.hypot(px, pz) < 300) continue;
        const dx = (s.b.x - s.a.x) / s.len, dz = (s.b.z - s.a.z) / s.len, side = rng() < 0.5 ? 1 : -1, off = e.width * 0.5 + rand(rng, 7, 22);
        addTreeT(ctx, b, pieces, px - dz * off * side, pz + dx * off * side, rand(rng, 0.85, 1.15));
      }
    }
  }
  // Trees round the market square, between its rings of benches.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU + 0.2, r = k % 2 ? 37 : 26;
    addTreeT(ctx, b, pieces, Math.cos(a) * r, Math.sin(a) * r, 0.75);
  }
  // A tree at the end of some of the gardens.
  for (const g of ctx.gardens || []) {
    if (rng() > 0.3) continue;
    const c = Math.cos(g.rot), sn = Math.sin(g.rot), lx = rand(rng, -g.w * 0.3, g.w * 0.3), lz = g.d * 0.5 - 2.5;
    addTreeT(ctx, b, pieces, g.x + lx * c + lz * sn, g.z - lx * sn + lz * c, rand(rng, 0.55, 0.8));
  }
  // Along the canal, on the far side from the towpath.
  if (ctx.canal) {
    const L = ctx.canal;
    for (let s = 0; s < L.length; s += 26) {
      if (rng() < 0.4) continue;
      const p = L.at(s), off = CANAL_W + 5 + rand(rng, 0, 6);
      addTreeT(ctx, b, pieces, p.x + p.dz * off * DRIVE_SIDE, p.z - p.dx * off * DRIVE_SIDE, rand(rng, 0.8, 1.1));
    }
  }
  if (!b.vertexCount) return [];
  liftBuilder(b, pieces, ctx.at);
  if (b.low) liftBuilder(b.low, b.lowPieces, ctx.at);
  const tm = treeDetail(new THREE.Mesh(b.build(), vertexColorMaterial()));
  tm.name = 'trees';
  tm.castShadow = true;
  return [chunkTrees(tm, lowTrees(b))];
}
