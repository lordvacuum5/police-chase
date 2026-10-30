// Haldon Vale -- open country.
//
// "I want you to make the map. The new map ... with hedges, like a kind of
// countryside. And with hills, and just make it as good as you can ... quite
// big ... Make a variety. Make it cool." And earlier, the wish list it grew
// from: hills with jumps, farm buildings you can drive through, woods.
//
// Two kilometres square, like the others, and nothing like them:
//
//   * two A-roads crossing the vale, joined at a crossroads in the middle and
//     meeting a ring lane -- the Ridgeway -- that loops the whole map, so there
//     is always a way round and never only one;
//   * B-roads to three villages, each a knot of lanes round a green, with a
//     church, a pub and cottages that crowd the street;
//   * single-track lanes between hedges, sunk between them like corridors,
//     and farm tracks to nine farms, each a concrete yard with a house, a
//     closed barn open at both ends and a Dutch barn that is nothing but a
//     roof on posts -- both of them a way through, not an obstacle;
//   * fields in a patchwork of crops, hedged with gateways to drive through;
//   * five woods, dense enough to lose someone in;
//   * hills under all of it -- see world/terrain.js -- with a few humpback
//     crests on the lanes, short and sharp enough to leave the ground over;
//   * wind turbines on the tops, so the hills read from anywhere.

import * as THREE from 'three';
import { RoadGraph, ROAD_KIND } from './roadgraph.js';
import { approachesAt, addNodeWedges } from './junctions.js';
import { GROUP, groups, addStaticBox, addCanopy, nearBuilding, EDGE_FACE, RAPIER } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, TAU } from '../util/math.js';
import {
  WORLD_HALF, CELL, GRID_N, KERB_H, SURF_GRASS, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, makeHeightAt, DRAW_ORDER,
  buildGround, buildRoadMeshes, MeshBuilder, vertexColorMaterial,
} from './common.js';
import { baseRelief, buildHeightGrid, addHeightfield, buildTerrainMesh, liftMesh, liftPieces, HILL_SINK, H_STEP } from './terrain.js';
import {
  makeClearMask, planQuarry, quarryGround, quarryHole, planQuarryEdge, buildQuarry, quarryColour, addQuarryRoads, quarryTopAt,
  planShortcuts, buildShortcuts, buildGates, planRailway, railGround, buildRailTrack, Railway,
} from './countryextras.js';
import { buildLife } from './countrylife.js';

const RIDGEWAY_R = 800;
/**
 * Whether a hedge is a wall to the AI's driving sweeps (and the local
 * planner), or only to its eyes. `window.__hedgeWall` sets it for rigs; read
 * when the map is built.
 */
const HEDGE_WALL = false;
const hedgeWall = () => {
  let rig = null;
  try { rig = sessionStorage.getItem('pc.hedgeWall'); } catch (e) { /* none */ }
  if (rig !== null) return rig === '1';
  return window.__hedgeWall === undefined ? HEDGE_WALL : window.__hedgeWall;
};
/** How tall a hedge is to the physics and the AI's sweeps -- see buildHedges. */
const HEDGE_SOLID = 6;
/** How far each 8 m piece of hedge runs on into the next, m, so a run reads as one hedge. */
const HEDGE_LAP = 1.4;
/** How many single-track lanes to try to fit -- see buildLanes. */
const LANE_COUNT = 34;
/** How far a village centre keeps from a road laid before it: the green, its loop and a margin. */
const VILLAGE_CLEAR = 80;
/** A round bale: radius, height, kilos. See buildBales. */
const BALE_R = 0.8;
const BALE_H = 1.5;
const BALE_MASS = 90;
/** How many stubble fields get bales, and how many to a row (two rows each). */
const BALE_FIELDS = 24;
const BALE_ROW = 6;

export function buildCountry(sim, scene, seed = 4417) {
  const rng = makeRng(seed);
  const graph = new RoadGraph(48);
  const surface = new Uint8Array(GRID_N * GRID_N);
  const ctx = { sim, scene, rng, graph, surface, places: [] };

  // ---------------------------------------------------------------- layout
  const villages = [
    { name: 'Haldon St Mary', ...polar(rng, 0.2, 260, 330), r: 105 },
    { name: 'Little Combe', ...polar(rng, 2.4, 380, 470), r: 90 },
    { name: 'Ashwell', ...polar(rng, 4.3, 360, 470), r: 95 },
  ];
  ctx.villages = villages;

  // Roads
  const ridge = buildRidgeway(ctx);
  const aWest = buildARoad(ctx, ridge, Math.PI, 0, 'A396');      // west to east
  const aNorth = buildARoad(ctx, ridge, -Math.PI / 2, Math.PI / 2, 'A3072', aWest);
  for (const v of villages) buildVillage(ctx, v, [aWest, aNorth]);
  buildBRoads(ctx);
  buildLanes(ctx);
  // Before the farm tracks, so a track is laid round a lane's turning loop
  // rather than through it. The yards need none: they are paved all round.
  graph.addTurningHeads(14, 10, WORLD_HALF);
  const farms = buildFarmTracks(ctx);
  ctx.farms = farms;

  graph.finalise();
  nameCountryRoads(ctx);

  // ---------------------------------------------------------------- hills
  const hills = [
    { name: 'Haldon Beacon', ...polar(rng, 5.6, 420, 560), r: 190, h: 34 },
    { name: 'Coombe Hill', ...polar(rng, 1.3, 520, 640), r: 160, h: 26 },
    { name: 'Windy Knoll', ...polar(rng, 3.3, 180, 280), r: 140, h: 22 },
    { name: 'Long Down', ...polar(rng, 4.6, 650, 720), r: 220, h: 20 },
  ];
  const base = baseRelief(rng, { half: WORLD_HALF, hills });
  const flatten = [];
  for (const v of villages) flatten.push({ x: v.x, z: v.z, r: v.r, fade: 60 });
  for (const f of farms) flatten.push({ x: f.x, z: f.z, r: 36, fade: 30 });
  // The set pieces the ground has to be shaped for (world/countryextras.js):
  // the quarry's floor and cliff, and the railway's long section.
  // With a random stream of their own: drawing on the map's put every field,
  // wood, hedge gap and crest after them somewhere else, and the vale is
  // liked the way it is.
  ctx.xrng = makeRng(seed + 7919);
  ctx.lrng = makeRng(seed + 15485);
  makeClearMask(ctx);
  const quarry = planQuarry(ctx, base, hills);
  ctx.quarry = quarry;
  const rail = planRailway(ctx, base, quarry);
  ctx.rail = rail;
  const pins = [];
  if (quarry) {
    const qg = quarryGround(quarry, base);
    flatten.push(...qg.flatten);
    pins.push(qg.pin);
  }
  const crests = pickCrests(ctx);
  const grid = buildHeightGrid(base, { half: WORLD_HALF, graph, flatten, crests, pins, lines: rail ? [railGround(rail)] : [] });
  ctx.grid = grid;
  ctx.at = grid.at;
  ctx.crests = crests;
  addHeightfield(sim.world, grid);

  // ---------------------------------------------------------------- surfaces
  for (const v of villages) paintVillagePaving(ctx, v);
  for (const f of farms) paintDisc(surface, f.x, f.z, 22, SURF_PAVED);
  rasteriseRoads(graph, surface);
  ctx.surfAt = makeSurfaceAt(surface);
  const kerbAt = makeHeightAt(surface);
  const heightAt = (x, z) => grid.at(x, z) + kerbAt(x, z);

  // ---------------------------------------------------------------- visuals
  // The plate and the world edge, but not the flat ground mesh: the hills
  // have their own.
  // With a hole in it under the quarry, which is dug below zero.
  if (quarry) ctx.plateHole = quarryHole(quarry);
  buildGround(ctx);
  const fields = planFields(ctx, farms);
  ctx.shortcuts = planShortcuts(ctx, fields, quarry);
  const meshes = [];
  const nearRoad = (x, z) => {
    // Under the railway's ballast too, which stands on the bed like a road.
    if (ctx.clearAt(x, z, 1)) return 0.45;
    for (const [ox, oz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
      if (ctx.surfAt(x + ox, z + oz) === SURF_ROAD) return 0.45;
    }
    return 0;
  };
  // The ground as drawn: for things laid on it, like the shortcuts' ruts.
  // At the height grid's own 4 m, so it is the ground the wheels feel. At 8 m
  // it was up to 0.15 m off it over 1.2% of the vale (2 cm on average), and a
  // car or a bale on a slope, seen from below, stood off the drawn ground:
  // "it almost looks like it's not fully on the ground ... you can see
  // there's a tiny gap in between them and the ground". At 4 m, 2 mm.
  const DS = H_STEP;
  const drawnV = (i, j) => { const px = i * DS - WORLD_HALF, pz = j * DS - WORLD_HALF; return grid.at(px, pz) - 0.04 - nearRoad(px, pz); };
  ctx.drawnAt = (x, z) => {
    const fi = (x + WORLD_HALF) / DS, fj = (z + WORLD_HALF) / DS;
    const i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, tz = fj - j;
    if (tx + tz <= 1) return drawnV(i, j) + (drawnV(i + 1, j) - drawnV(i, j)) * tx + (drawnV(i, j + 1) - drawnV(i, j)) * tz;
    const e = drawnV(i + 1, j + 1);
    return e + (drawnV(i, j + 1) - e) * (1 - tx) + (drawnV(i + 1, j) - e) * (1 - tz);
  };
  const colour = (x, z, y, c) => groundColour(ctx, fields, x, z, y, c);
  const terrain = buildTerrainMesh(grid, colour, DS, nearRoad);
  // Before the pavements, which write no depth: see buildVillagePavements.
  terrain.renderOrder = DRAW_ORDER.ground;
  meshes.push(terrain);
  // And the fields on out to the edge of the plate, which is 200 m wider than
  // the hills on every side. Without it that strip was drivable and not
  // drawn: sky under the wheels, and the field hedges running on across it.
  const plate = { half: EDGE_FACE + 4, at: () => 0 };
  const ring = buildTerrainMesh(plate, (x, z, y, c) => groundColour(ctx, fields, x, z, y, c), 8, null, WORLD_HALF);
  ring.name = 'terrain-edge';
  ring.renderOrder = DRAW_ORDER.ground;
  meshes.push(ring);
  // Without the kerbs: a country lane has a verge, not a kerb, and the grip
  // grid has none here outside the villages to match one.
  const [tarmac, markings, kerbs] = buildRoadMeshes(ctx);
  kerbs.geometry.dispose();
  meshes.push(...liftRoads(ctx, [tarmac, markings]));
  meshes.push(buildVillagePavements(ctx));
  meshes.push(...buildVillageBuildings(ctx));
  meshes.push(...buildFarms(ctx, farms));
  if (quarry) ctx.extraBales = planQuarryEdge(ctx, quarry);
  meshes.push(buildHedges(ctx, fields));
  meshes.push(buildWoods(ctx, fields));
  meshes.push(buildBalesAndTurbines(ctx, fields, hills));
  meshes.push(ctx.bales.mesh);
  // After the trees: a tree keeps clear of anything solid already standing
  // (nearBuilding), and the rock face put up first moved the trees round it,
  // and every one after them.
  if (quarry) meshes.push(...buildQuarry(ctx, quarry));
  const shortcuts = buildShortcuts(ctx, ctx.shortcuts);
  meshes.push(...shortcuts.meshes);
  const gates = buildGates(ctx, ctx.gateSpots.concat(shortcuts.gateSpots));
  meshes.push(...gates.meshes);
  if (rail) meshes.push(buildRailTrack(ctx, rail));
  for (const m of meshes) if (m) scene.add(m);
  const railway = rail ? new Railway(ctx, rail, scene) : null;
  // Work going on, birds, lights at night (world/countrylife.js).
  const life = buildLife(ctx, scene, { fields, quarry, rail, combineField: ctx.combineField, baleField: ctx.baleField });
  // And the quarry's track and haul road, to the police's planner (after the
  // tractors have chosen their lanes, so none is sent down it).
  addQuarryRoads(graph, quarry);

  return {
    graph,
    surface,
    surfaceAt: makeSurfaceAt(surface),
    heightAt,
    terrainAt: grid.at,
    // From the highest ground down to the lowest, the quarry floor under zero
    // included: how far a wheel's ray must reach (see Vehicle).
    relief: grid.max - Math.min(0, grid.min - 4) + 2,
    meshes,
    bounds: WORLD_HALF,
    villages,
    farms,
    hills,
    quarry,
    rail,
    shortcuts: ctx.shortcuts,
    railway,
    // Called every frame by the game: the bales and gates follow their
    // bodies, the train, the crossings, the tractors and the birds are drawn.
    update: (game) => { ctx.bales.update(); gates.update(); if (railway) railway.update(game); life.update(game); },
    gates,
    // The tractors, trucks and combine, to the AI's queueing (Driver.carInWay).
    movers: life.movers,
    life,
    // The quarry's rock, for what lands by asking the height (FlyHeli.groundY).
    solidTopAt: quarry ? (x, z) => quarryTopAt(sim.world, quarry, x, z) : null,
    // Called every physics substep: the train and the work vehicles move.
    step: (dt) => { if (railway) railway.step(dt); life.step(dt); },
    // Day or night, once the weather is known: windows and the train's lights.
    setNight: (on) => { life.setNight(on); if (railway) railway.setNight(on); },
    // The crossings, to everything the AI drives (TrafficLights.stopDistanceAt).
    stopDistanceAt: railway ? (x, z, dx, dz, v) => railway.stopDistanceAt(x, z, dx, dz, v) : null,
  };
}

function polar(rng, a, r0, r1) {
  const ang = a + rand(rng, -0.25, 0.25);
  const r = rand(rng, r0, r1);
  return { x: Math.cos(ang) * r, z: Math.sin(ang) * r };
}

// =====================================================================
//  Roads
// =====================================================================

/** Catmull-Rom through the control points, every `step` metres. */
export function spline(ctrl, step = 5) {
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push({ x: ctrl[ctrl.length - 1].x, z: ctrl[ctrl.length - 1].z });
  return out;
}

/** Do two segments cross (properly, not at a shared end)? */
export function segX(a, b, c, d) {
  const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Would a road along `pts` cross an existing edge, or run within `clear` m of
 * one, anywhere but near its own two end nodes?
 */
function blocked(graph, pts, aId, bId, clear = 14, crossOk = false) {
  const a = graph.nodes[aId], b = graph.nodes[bId];
  for (const e of graph.edges) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const nearEnd = Math.hypot(p.x - a.x, p.z - a.z) < 30 || Math.hypot(q.x - b.x, q.z - b.z) < 30;
      for (let k = 0; k < e.points.length - 1; k++) {
        const c = e.points[k], d = e.points[k + 1];
        if (segX(p, q, c, d)) {
          // A lane may cross another road -- RoadGraph.stitchCrossings makes
          // the crossing a crossroads -- if it does so squarely enough to read
          // as one, away from the road's own junctions, and not near its ends.
          if (!crossOk || nearEnd || e.turningHead || e.village || e.farm) return true;
          const ux = q.x - p.x, uz = q.z - p.z, vx = d.x - c.x, vz = d.z - c.z;
          const cos = Math.abs(ux * vx + uz * vz) / ((Math.hypot(ux, uz) * Math.hypot(vx, vz)) || 1);
          if (cos > Math.cos(0.75)) return true;
          const na = graph.nodes[e.a], nb = graph.nodes[e.b];
          if (Math.hypot(p.x - na.x, p.z - na.z) < 45 || Math.hypot(p.x - nb.x, p.z - nb.z) < 45) return true;
          continue;
        }
        if (!nearEnd && Math.hypot(p.x - c.x, p.z - c.z) < clear) {
          // Close to a road it is about to cross is not running alongside it.
          if (crossOk && crossesSoon(pts, i, c, d)) continue;
          return true;
        }
      }
    }
  }
  for (const p of pts) if (Math.abs(p.x) > WORLD_HALF - 40 || Math.abs(p.z) > WORLD_HALF - 40) return true;
  return false;
}

/** Does the polyline cross segment c-d within a few points of index i? */
function crossesSoon(pts, i, c, d) {
  for (let j = Math.max(0, i - 4); j < Math.min(pts.length - 1, i + 5); j++) {
    if (segX(pts[j], pts[j + 1], c, d)) return true;
  }
  return false;
}

/** A road between two nodes through wobbled control points. */
function road(ctx, a, b, kind, wobble, check = true, opts = {}) {
  const { rng, graph } = ctx;
  const ctrl = [{ x: a.x, z: a.z }];
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
  const k = Math.max(1, Math.round(L / 110));
  for (let i = 1; i <= k; i++) {
    const t = i / (k + 1);
    const w = rand(rng, -wobble, wobble);
    ctrl.push({ x: lerp(a.x, b.x, t) + nx * w, z: lerp(a.z, b.z, t) + nz * w });
  }
  ctrl.push({ x: b.x, z: b.z });
  const pts = spline(ctrl, 5);
  if (check && blocked(graph, pts, a.id, b.id, 14, !!opts.crossOk)) return null;
  // Never a second road between the same two junctions, nor one leaving a
  // junction along a road that is already there: both are drawn on top of
  // each other for the first stretch, which is the "roads that look weird"
  // the other maps have had. Checked for every road, A-roads included.
  if (!opts.force && (joined(graph, a, b) || crowds(graph, a, pts) || crowds(graph, b, pts.slice().reverse()))) return null;
  return graph.addEdge(a, b, kind, pts.slice(1, -1), opts);
}

function joined(graph, a, b) {
  return a.edges.some((id) => { const e = graph.edges[id]; return e.a === b.id || e.b === b.id; });
}

/** Does a road leaving `n` along `pts` set off within 25 degrees of one already there? */
function crowds(graph, n, pts) {
  const away = (list) => list.find((p) => Math.hypot(p.x - n.x, p.z - n.z) > 14) || list[list.length - 1];
  const q = away(pts);
  const a = Math.atan2(q.x - n.x, q.z - n.z);
  for (const id of n.edges) {
    const e = graph.edges[id];
    const list = e.a === n.id ? e.points : e.points.slice().reverse();
    const r = away(list);
    let d = Math.abs(a - Math.atan2(r.x - n.x, r.z - n.z)) % TAU;
    if (d > Math.PI) d = TAU - d;
    if (d < 0.44) return true;
  }
  return false;
}

/** The Ridgeway: a lane right round the map, at a wandering radius. */
function buildRidgeway(ctx) {
  const { rng, graph } = ctx;
  const N = 18;
  const nodes = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU + rand(rng, -0.05, 0.05);
    const r = RIDGEWAY_R + rand(rng, -70, 60);
    nodes.push(graph.addNode(Math.cos(a) * r, Math.sin(a) * r, 'cross'));
  }
  for (let k = 0; k < N; k++) {
    const a = nodes[k], b = nodes[(k + 1) % N];
    // Bowed outward so it reads as a ring.
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, mr = Math.hypot(mx, mz) || 1;
    const bow = rand(rng, 10, 34);
    const ctrl = [{ x: a.x, z: a.z }, { x: mx + mx / mr * bow, z: mz + mz / mr * bow }, { x: b.x, z: b.z }];
    graph.addEdge(a, b, 'country', spline(ctrl, 5).slice(1, -1), { width: 8, speed: 24 });
  }
  return nodes;
}

/**
 * An A-road from one side of the Ridgeway to the other, wandering as it goes,
 * through whichever village lies near its line. Crosses `other` at a single
 * shared node near the middle, so the two meet at a crossroads.
 */
function buildARoad(ctx, ridge, angFrom, angTo, name, other = null) {
  const { rng, graph } = ctx;
  const nearestRidge = (a) => {
    let best = ridge[0], bd = Infinity;
    for (const n of ridge) {
      const d = Math.abs(Math.atan2(Math.sin(Math.atan2(n.z, n.x) - a), Math.cos(Math.atan2(n.z, n.x) - a)));
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const start = nearestRidge(angFrom), end = nearestRidge(angTo);
  const chain = [start];
  const crossAt = other ? other.chain.reduce((m, n) => (Math.hypot(n.x, n.z) < Math.hypot(m.x, m.z) ? n : m)) : null;
  const steps = 7;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    let x = lerp(start.x, end.x, t), z = lerp(start.z, end.z, t);
    // Wander off the straight line, a long slow S.
    const L = Math.hypot(end.x - start.x, end.z - start.z);
    const nx = -(end.z - start.z) / L, nz = (end.x - start.x) / L;
    const w = Math.sin(t * Math.PI * 2 + rng()) * 90 + rand(rng, -30, 30);
    x += nx * w; z += nz * w;
    if (crossAt && i === Math.round(steps / 2)) { chain.push(crossAt); continue; }
    // Bend towards a village that is near the line.
    for (const v of ctx.villages) {
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < 160) { x = lerp(x, v.x, 0.85); z = lerp(z, v.z, 0.85); v.onA = true; }
    }
    chain.push(graph.addNode(x, z, 'cross'));
  }
  chain.push(end);
  const edges = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const e = road(ctx, chain[i], chain[i + 1], 'country', 25, false, { width: 10, speed: 28, force: true });
    if (e) { e.aroad = name; edges.push(e); }
  }
  return { chain, name, edges };
}

/**
 * A village: a loop of lanes round a green, hung off the nearest road node,
 * with a lane or two out the far side.
 */
function buildVillage(ctx, v, aroads) {
  const { rng, graph } = ctx;
  // Off to one side of the roads already there. Placed blind, two of the
  // three greens had an A-road straight across the middle, with the church
  // standing on it.
  for (let k = 0; k < 12; k++) {
    let best = null, bd = Infinity;
    for (const e of graph.edges) {
      for (const s of e.segs) {
        const sx = s.b.x - s.a.x, sz = s.b.z - s.a.z;
        const t = clamp(((v.x - s.a.x) * sx + (v.z - s.a.z) * sz) / ((sx * sx + sz * sz) || 1), 0, 1);
        const px = s.a.x + sx * t, pz = s.a.z + sz * t;
        const d = Math.hypot(v.x - px, v.z - pz);
        if (d < bd) { bd = d; best = { x: px, z: pz }; }
      }
    }
    if (!best || bd >= VILLAGE_CLEAR) break;
    const ux = (v.x - best.x) / (bd || 1), uz = (v.z - best.z) / (bd || 1);
    v.x += ux * (VILLAGE_CLEAR + 2 - bd); v.z += uz * (VILLAGE_CLEAR + 2 - bd);
  }
  // The road node to hang it off: the nearest one on any A-road or the Ridgeway.
  let host = null, hd = Infinity;
  for (const n of graph.nodes) {
    const d = Math.hypot(n.x - v.x, n.z - v.z);
    if (d < hd) { hd = d; host = n; }
  }
  // The green: a loop of five lane nodes round the village centre.
  const loop = [];
  const R = rand(rng, 42, 55);
  const a0 = Math.atan2(host.z - v.z, host.x - v.x);
  for (let k = 0; k < 5; k++) {
    const a = a0 + (k / 5) * TAU + rand(rng, -0.12, 0.12);
    loop.push(graph.addNode(v.x + Math.cos(a) * R * rand(rng, 0.9, 1.15), v.z + Math.sin(a) * R * rand(rng, 0.9, 1.15), 'lane'));
  }
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k], b = loop[(k + 1) % loop.length];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const dx = mx - v.x, dz = mz - v.z, dl = Math.hypot(dx, dz) || 1;
    const ctrl = [{ x: a.x, z: a.z }, { x: mx + dx / dl * 8, z: mz + dz / dl * 8 }, { x: b.x, z: b.z }];
    const e = graph.addEdge(a, b, 'lane', spline(ctrl, 4).slice(1, -1), { width: 8 });
    e.village = v;
  }
  // Joined to the host road by whichever point of the loop can be reached
  // without crowding a road already at the host.
  const order = loop.slice().sort((p, q) => Math.hypot(p.x - host.x, p.z - host.z) - Math.hypot(q.x - host.x, q.z - host.z));
  let e0 = null;
  for (const ln of order) {
    e0 = road(ctx, host, ln, 'lane', 4, false, { width: 8 });
    if (e0) break;
  }
  if (e0) e0.village = v;
  v.loop = loop;
  v.host = host;
  // One street out the far side, a little way, lined with cottages too.
  const far = loop[randInt(rng, 2, 3)];
  const out = Math.atan2(far.z - v.z, far.x - v.x);
  const tip = graph.addNode(far.x + Math.cos(out) * rand(rng, 70, 100), far.z + Math.sin(out) * rand(rng, 70, 100), 'lane');
  const st = road(ctx, far, tip, 'lane', 8, true, { width: 8 });
  if (st) { st.village = v; v.tip = tip; } else { graph.nodes.pop(); }
}

/** B-roads: each village to the Ridgeway, and the villages to each other. */
function buildBRoads(ctx) {
  const { rng, graph, villages } = ctx;
  const ridge = graph.nodes.slice(0, 18);
  for (const v of villages) {
    const from = v.tip || v.loop[2];
    // The nearest Ridgeway node out the village's side of the map.
    let best = null, bd = Infinity;
    for (const n of ridge) {
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (best) road(ctx, from, best, 'country', 40, true, { width: 8, speed: 24 });
  }
  for (let i = 0; i < villages.length; i++) {
    const a = villages[i].loop[1], b = villages[(i + 1) % villages.length].loop[4];
    road(ctx, a, b, 'country', 70, true, { width: 8, speed: 24 });
  }
}

/**
 * Single-track lanes: between any two road nodes 220-560 m apart that a lane
 * can join without crossing anything. These are what make the map a maze
 * rather than a set of routes.
 */
function buildLanes(ctx) {
  const { rng, graph } = ctx;
  let made = 0;
  // As many as fit, up to LANE_COUNT. With sixteen the vale was a sparse web:
  // the road route between two junctions ran at a median of 1.95 times the
  // straight line, and 6.5 at worst, so every chase went the long way round.
  // Pairs whose road route is already close to straight are not worth a lane.
  for (let tries = 0; tries < 1500 && made < LANE_COUNT; tries++) {
    const a = graph.nodes[randInt(rng, 0, graph.nodes.length - 1)];
    const b = graph.nodes[randInt(rng, 0, graph.nodes.length - 1)];
    if (a === b || a.edges.length > 3 || b.edges.length > 3) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 180 || d > 620) continue;
    if (roadDistance(graph, a, b, d * 3) < d * 1.5) continue;
    if (a.edges.some((id) => { const e = graph.edges[id]; return e.a === b.id || e.b === b.id; })) continue;
    const e = road(ctx, a, b, 'track', 55, true, { crossOk: true });
    if (e) made++;
  }
}

/**
 * Length of the shortest road route from a to b over what has been built so
 * far, giving up past `cap`. Plain Dijkstra on the unfinished graph.
 */
export function roadDistance(graph, a, b, cap) {
  const dist = new Map([[a.id, 0]]);
  const open = [[0, a.id]];
  while (open.length) {
    open.sort((p, q) => p[0] - q[0]);
    const [dcur, id] = open.shift();
    if (id === b.id) return dcur;
    if (dcur > cap) break;
    if (dcur > (dist.get(id) ?? Infinity)) continue;
    for (const eid of graph.nodes[id].edges) {
      const e = graph.edges[eid];
      const o = e.a === id ? e.b : e.a;
      const nd = dcur + e.length;
      if (nd < (dist.get(o) ?? Infinity)) { dist.set(o, nd); open.push([nd, o]); }
    }
  }
  return Infinity;
}

/** Farms: a yard off a short track from the nearest road. */
function buildFarmTracks(ctx) {
  const { rng, graph } = ctx;
  const farms = [];
  const NAMES = ['Manor Farm', 'Lower Barton', 'Hill Farm', 'Wick Farm', 'Coldharbour Farm',
    'Westcott', 'Home Farm', 'Pound Farm', 'Furzeland'];
  for (let tries = 0; tries < 300 && farms.length < NAMES.length; tries++) {
    const a = rng() * TAU, r = rand(rng, 220, 760);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (ctx.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + 90)) continue;
    if (farms.some((f) => Math.hypot(f.x - x, f.z - z) < 230)) continue;
    // Not on a road.
    let near = Infinity;
    for (const e of graph.edges) for (const p of e.points) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
    if (near < 70 || near > 240) continue;
    // The nearest road node to run a track from.
    let host = null, hd = Infinity;
    for (const n of graph.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < hd) { hd = d; host = n; }
    }
    if (!host || hd > 320) continue;
    const yard = graph.addNode(x, z, 'lane');
    const e = road(ctx, host, yard, 'track', 20, true, { width: 6 });
    if (!e) { graph.nodes.pop(); continue; }
    e.farm = true;
    farms.push({ x, z, name: NAMES[farms.length], node: yard, angle: Math.atan2(host.z - z, host.x - x) });
  }
  return farms;
}

/** A few lanes get a sharp crest -- a humpback in the lane, to jump. */
function pickCrests(ctx) {
  const { rng, graph } = ctx;
  const out = [];
  // On the single-track lanes only, where the speed is lower: a crest on
  // the Ridgeway at 150 km/h sent a car three seconds through the air and
  // onto its roof. A metre, over thirty: enough to get light over it, and to
  // leave the ground if you are really going for it.
  const cands = graph.edges.filter((e) => !e.cut && !e.turningHead && !e.village && !e.farm && e.length > 160
    && e.kind === 'track');
  for (let i = 0; i < 6 && cands.length; i++) {
    const e = cands.splice(randInt(rng, 0, cands.length - 1), 1)[0];
    out.push({ edge: e.id, s: rand(rng, 0.35, 0.65) * e.length, len: rand(rng, 14, 18), h: rand(rng, 0.9, 1.3) });
    e.crest = true;
  }
  return out;
}

// =====================================================================
//  Names
// =====================================================================

const LANES = ['Pig Lane', 'Hollow Way', 'Drovers Lane', 'Sheepwash Lane', 'Combe Lane',
  'Watery Lane', 'Gallows Lane', 'Blackberry Lane', 'Stoney Lane', 'Puddle Lane', 'Badger Lane',
  'Holloway', 'Five Ashes Lane', 'Hangmans Lane', 'Withy Lane', 'Rookery Lane', 'Furze Lane',
  'Cuckoo Lane', 'Muddy Lane', 'Orchard Lane', 'Shepherds Way', 'Pennywell Lane', 'Coombe Bottom',
  'Gibbet Lane', 'Cider Press Lane', 'Lyde Lane', 'Clay Lane', 'Kiln Lane', 'Starveacre Lane',
  'Nettlecombe Lane', 'Hare Lane', 'Tinkers Lane', 'Watergate', 'Bramble Lane', 'Twelve Acre Lane',
  'Pound Lane', 'Mudford Lane'];
const B_ROADS = ['B3212', 'B3193', 'B3344', 'B3381', 'B3362', 'B3215'];
const VILLAGE_STREETS = ['The Green', 'Church Street', 'Fore Street', 'Chapel Lane', 'Back Lane',
  'Mill Street', 'Town End', 'Well Lane', 'Rectory Lane'];

function nameCountryRoads(ctx) {
  const { graph } = ctx;
  let l = 0, b = 0, vs = 0;
  const ridgeIds = new Set(graph.nodes.slice(0, 18).map((n) => n.id));
  for (const e of graph.edges) {
    if (e.aroad) { e.name = `the ${e.aroad}`; continue; }
    if (e.village) { e.name = `${VILLAGE_STREETS[(vs++) % VILLAGE_STREETS.length]}, ${e.village.name}`; continue; }
    if (e.farm) { e.name = 'a farm track'; continue; }
    if (ridgeIds.has(e.a) && ridgeIds.has(e.b) && e.kind === 'country') { e.name = 'the Ridgeway'; continue; }
    if (e.kind === 'country') { e.name = B_ROADS[(b++) % B_ROADS.length]; continue; }
    e.name = LANES[(l++) % LANES.length];
  }
  for (const n of graph.nodes) {
    const names = [];
    for (const id of n.edges) {
      const nm = graph.edges[id].name;
      if (nm && names.indexOf(nm) === -1) names.push(nm);
    }
    n.name = names.length >= 2 ? `${names[0]} / ${names[1]}` : (names[0] || 'the lane');
  }
}

// =====================================================================
//  Fields, colour and surfaces
// =====================================================================

const CROPS = [
  [0.24, 0.42, 0.30], [0.23, 0.38, 0.27], [0.26, 0.45, 0.33], [0.21, 0.30, 0.28],   // grass, pasture
  [0.15, 0.55, 0.52], [0.14, 0.50, 0.58],                                          // wheat, barley
  [0.17, 0.78, 0.55],                                                              // rapeseed
  [0.07, 0.30, 0.24], [0.06, 0.26, 0.20],                                          // ploughed
  [0.30, 0.35, 0.26],                                                              // kale
];

/**
 * The patchwork: Voronoi cells over the open country, each a crop. Woods are
 * cells too, so a wood has a field edge rather than a circle.
 */
function planFields(ctx, farms) {
  const { rng } = ctx;
  const seeds = [];
  for (let tries = 0; tries < 6000 && seeds.length < 260; tries++) {
    const x = rand(rng, -WORLD_HALF + 30, WORLD_HALF - 30), z = rand(rng, -WORLD_HALF + 30, WORLD_HALF - 30);
    if (seeds.some((s) => Math.hypot(s.x - x, s.z - z) < 95)) continue;
    seeds.push({ x, z, crop: CROPS[randInt(rng, 0, CROPS.length - 1)], wood: false });
  }
  // Woods: a few clusters of neighbouring cells.
  const woodNames = ['Combe Wood', 'Great Copse', 'Hanger Wood', 'Rook Wood', 'Black Spinney'];
  const woods = [];
  for (let w = 0; w < woodNames.length; w++) {
    let c = null;
    for (let t = 0; t < 50 && !c; t++) {
      const s = seeds[randInt(rng, 0, seeds.length - 1)];
      if (s.wood) continue;
      if (ctx.villages.some((v) => Math.hypot(v.x - s.x, v.z - s.z) < v.r + 120)) continue;
      if (farms.some((f) => Math.hypot(f.x - s.x, f.z - s.z) < 120)) continue;
      c = s;
    }
    if (!c) continue;
    const members = seeds.filter((s) => !s.wood && Math.hypot(s.x - c.x, s.z - c.z) < rand(rng, 140, 230));
    for (const s of members) s.wood = woodNames[w];
    woods.push({ name: woodNames[w], x: c.x, z: c.z });
  }
  const grid = new Map();
  const C = 120;
  for (const s of seeds) {
    const k = `${Math.floor(s.x / C)},${Math.floor(s.z / C)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const nearest = (x, z) => {
    const ix = Math.floor(x / C), iz = Math.floor(z / C);
    let best = null, bd = Infinity, second = Infinity;
    for (let i = ix - 2; i <= ix + 2; i++) {
      for (let j = iz - 2; j <= iz + 2; j++) {
        for (const s of grid.get(`${i},${j}`) || []) {
          const d = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d < bd) { second = bd; bd = d; best = s; } else if (d < second) second = d;
        }
      }
    }
    return { s: best, edge: Math.sqrt(second) - Math.sqrt(bd) };
  };
  return { seeds, woods, nearest };
}

export function inVillage(ctx, x, z, pad = 0) {
  return ctx.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + pad);
}

function groundColour(ctx, fields, x, z, y, c) {
  if (quarryColour(ctx.quarry, x, z, y, c)) return;
  const { s, edge } = fields.nearest(x, z);
  // A grass verge either side of every road, whatever the field behind it.
  const sf = ctx.surfAt;
  let verge = false;
  for (const [ox, oz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
    if (sf(x + ox, z + oz) === SURF_ROAD) { verge = true; break; }
  }
  if (inVillage(ctx, x, z, -10)) c.setHSL(0.25, 0.36, 0.30);      // the green
  else if (verge && !(s && s.wood)) c.setHSL(0.25, 0.38, 0.27);
  else if (s && s.wood) c.setHSL(0.27, 0.40, 0.16);
  else if (s) c.setHSL(s.crop[0], s.crop[1], s.crop[2]);
  else c.setHSL(0.24, 0.4, 0.3);
  // Darker along the field edges, under the hedges; a touch lighter high up.
  if (edge < 3) c.offsetHSL(0, 0, -0.06);
  c.offsetHSL(0, -0.02 * Math.min(1, y / 30), 0.05 * Math.min(1, y / 30));
  // A little grain so a field is not one flat colour.
  const n = Math.sin(x * 0.31 + z * 0.17) * Math.cos(z * 0.23 - x * 0.11);
  c.offsetHSL(0, 0, n * 0.015);
}

function paintVillagePaving(ctx, v) {
  const { graph, surface } = ctx;
  for (const e of graph.edges) {
    if (e.village !== v) continue;
    for (const sg of e.segs) {
      const steps = Math.max(1, Math.ceil(sg.len / 1.5));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(sg.a.x, sg.b.x, t), lerp(sg.a.z, sg.b.z, t), e.width * 0.5 + 3, SURF_PAVED);
      }
    }
  }
}

// =====================================================================
//  Roads and pavements, drawn
// =====================================================================

/**
 * The common road meshes, lifted onto the hills. Their tarmac is normally
 * drawn over everything regardless of depth (DRAW_ORDER in common.js), which
 * on a flat map is how it sits cleanly on the ground -- and on this one would
 * show the road through the hill in front of it. So here it is depth-tested
 * like anything else, and pulled toward the camera instead to stay on top of
 * the ground it lies on.
 */
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

function buildVillagePavements(ctx) {
  const { graph } = ctx;
  const b = new MeshBuilder();
  const paved = (e) => e && e.village && !e.turningHead;
  for (const e of graph.edges) if (paved(e)) b.addRibbon(e.points, e.width + 6, KERB_H, PALETTE.pavement);
  for (const n of graph.nodes) {
    const app = approachesAt(graph, n).filter((a) => paved(a.edge));
    if (app.length) addNodeWedges(b, n, app, (e) => (e.width + 6) * 0.5, KERB_H - 0.001, PALETTE.pavement);
  }
  // One sheet the full width of the street, a kerb high, under the tarmac as
  // well as beside it -- and the tarmac is 0.13 m lower. Depth-tested, the
  // road won only at a distance, where the polygon offset outweighed the
  // gap: "the road's black when you're more than a few metres away, and as
  // you go down it, it changes to grey". So the pavement is drawn first and
  // writes no depth: the hills still hide it, and the road always covers it.
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ depthWrite: false }));
  mesh.renderOrder = DRAW_ORDER.pavement;
  liftMesh(mesh, ctx.at, 0.05);
  mesh.name = 'pavements';
  mesh.receiveShadow = true;
  return mesh;
}

// =====================================================================
//  Buildings
// =====================================================================

/** One solid building, drawn and collided, lifted as one piece. */
function addHouse(ctx, b, pieces, x, z, w, h, d, rot, colour, roof) {
  const at = ctx.at(x, z);
  const s = b.vertexCount;
  b.addTaperedBox(w, h, d, x, h * 0.5, z, colour, 1, 1, rot);
  b.addTaperedBox(w * 1.05, h * 0.42, d * 1.05, x, h + h * 0.18, z, roof, 0.15, 1, rot);
  b.addBox(w * 1.02, 0.8, d * 1.02, x, 0.1, z, 0x2b2724, rot);
  pieces.push([s, b.vertexCount, x, z]);
  addStaticBox(ctx.sim.world, x, at + h * 0.5, z, w * 0.5, h * 0.5, d * 0.5, GROUP.BUILDING, rot);
  // Kept, for its windows to light at night (countrylife.js).
  (ctx.houses || (ctx.houses = [])).push({ x, z, w, h, d, rot, at });
}

function buildVillageBuildings(ctx) {
  const { graph, rng } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  const placed = [];
  const free = (x, z, r) => placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r);
  for (const v of ctx.villages) {
    // The church on the green, square to it, with its tower.
    // Somewhere on it clear of every road. Haldon St Mary's green has the
    // A396 running across it, and the church went up on the carriageway.
    const clear = (x, z, r) => {
      const n = graph.nearestEdge(x, z, 60);
      return !n || n.dist > n.edge.width * 0.5 + r;
    };
    let ca = rng() * TAU, cx = 0, cz = 0, ok = false;
    for (let k = 0; k < 24 && !ok; k++) {
      const a = ca + k * 0.9, off = k < 12 ? 8 : 18;
      cx = v.x + Math.cos(a) * off; cz = v.z + Math.sin(a) * off;
      // Nave and tower, by their ends and middles.
      ok = clear(cx, cz, 7) && clear(cx + Math.sin(a) * 12, cz + Math.cos(a) * 12, 6)
        && clear(cx - Math.sin(a) * 10, cz - Math.cos(a) * 10, 6);
      if (ok) ca = a;
    }
    if (ok) {
      const s = b.vertexCount;
      b.addTaperedBox(9, 9, 22, cx, 4.5, cz, 0x8a8576, 1, 1, ca);
      b.addTaperedBox(9.6, 4, 22.6, cx, 10.6, cz, 0x3a3532, 0.12, 1, ca);
      const tx = cx + Math.sin(ca) * 12, tz = cz + Math.cos(ca) * 12;
      b.addBox(6, 20, 6, tx, 10, tz, 0x837e70, ca);
      b.addTaperedBox(6.4, 4, 6.4, tx, 22, tz, 0x3a3532, 0.05, 0.05, ca);
      pieces.push([s, b.vertexCount, cx, cz]);
      const ch = ctx.at(cx, cz);
      addStaticBox(ctx.sim.world, cx, ch + 4.5, cz, 4.5, 4.5, 11, GROUP.BUILDING, ca);
      addStaticBox(ctx.sim.world, tx, ch + 10, tz, 3, 10, 3, GROUP.BUILDING, ca);
      placed.push({ x: cx, z: cz, r: 16 });
    }
    let pub = false;

    for (const e of graph.edges) {
      if (e.village !== v) continue;
      // Walk the edge as a whole, not segment by segment: the segments are a
      // few metres each.
      for (const side of [1, -1]) {
        let along = rand(rng, 4, 10);
        while (along < e.length - 6) {
          const p = pointOn(e, along);
          const w = rand(rng, 6, 9.5), d = rand(rng, 7, 10), h = rand(rng, 5, 7);
          const setback = e.width * 0.5 + 3.5 + d * 0.5;
          const x = p.x + p.nx * side * setback, z = p.z + p.nz * side * setback;
          const r = Math.hypot(w, d) * 0.5;
          if (Math.hypot(x - v.x, z - v.z) < 22 || !free(x, z, r * 0.8)
              || graph.overlapsRoad(x, z, w, d, Math.atan2(p.tx, p.tz), 2.5)) {
            along += w + 1;
            continue;
          }
          const rot = Math.atan2(p.nx * side, p.nz * side);
          const isPub = !pub && rng() < 0.25;
          const colour = isPub ? new THREE.Color(0xd8cfb8)
            : new THREE.Color().setHSL(rand(rng, 0.07, 0.13), rand(rng, 0.10, 0.30), rand(rng, 0.55, 0.78));
          const roof = rng() < 0.45 ? 0x6b5a3a : 0x3b3431;     // thatch or slate
          addHouse(ctx, b, pieces, x, z, isPub ? w * 1.5 : w, h, d, rot, colour, roof);
          if (isPub) pub = true;
          placed.push({ x, z, r: r * 0.8 });
          along += w + rand(rng, 0.6, 4);
        }
      }
    }
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'villages';
  return [mesh];
}

/** Position, tangent and normal a distance along an edge. */
export function pointOn(e, s) {
  for (const sg of e.segs) {
    if (s <= sg.start + sg.len || sg === e.segs[e.segs.length - 1]) {
      const t = clamp((s - sg.start) / Math.max(1e-6, sg.len), 0, 1);
      const tx = (sg.b.x - sg.a.x) / Math.max(1e-6, sg.len), tz = (sg.b.z - sg.a.z) / Math.max(1e-6, sg.len);
      return { x: lerp(sg.a.x, sg.b.x, t), z: lerp(sg.a.z, sg.b.z, t), tx, tz, nx: -tz, nz: tx };
    }
  }
  return null;
}

/**
 * The farms. Each yard has a house, a closed barn with its doors open at both
 * ends -- so it is a tunnel, side walls only -- and a Dutch barn, a roof on
 * posts, open all round. "Farm buildings you can drive through."
 */
function buildFarms(ctx, farms) {
  const { rng } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  const W = ctx.sim.world;
  for (const f of farms) {
    const at = ctx.at(f.x, f.z);
    const a = f.angle;                    // toward the road
    const ux = Math.cos(a), uz = Math.sin(a);         // toward the track
    const vx = -uz, vz = ux;                           // across
    const rot = Math.atan2(ux, uz);
    // The house, by the track.
    const hx = f.x + ux * 14 + vx * 16, hz = f.z + uz * 14 + vz * 16;
    addHouse(ctx, b, pieces, hx, hz, 11, 7, 9, rot, new THREE.Color().setHSL(0.09, 0.18, 0.62), 0x3b3431);

    // The closed barn, through which the yard runs. Long axis along u.
    const bx = f.x - ux * 6 - vx * 14, bz = f.z - uz * 6 - vz * 14;
    const L = 26, Wd = 12, H = 7;
    const s = b.vertexCount;
    for (const sgn of [-1, 1]) {
      const wx = bx + vx * sgn * Wd * 0.5, wz = bz + vz * sgn * Wd * 0.5;
      b.addBox(0.5, H, L, wx, H * 0.5, wz, 0x5a3a2c, rot);
      addStaticBox(W, wx, at + H * 0.5, wz, 0.25, H * 0.5, L * 0.5, GROUP.BUILDING, rot);
    }
    b.addTaperedBox(Wd + 1.4, 3, L + 1, bx, H + 1.5, bz, 0x40332c, 0.1, 1, rot);
    pieces.push([s, b.vertexCount, bx, bz]);

    // The Dutch barn: a curved-looking roof on six posts, open all round.
    const dx = f.x - ux * 8 + vx * 14, dz = f.z - uz * 8 + vz * 14;
    const s2 = b.vertexCount;
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 1]) {
        const px = dx + ux * i * 9 + vx * j * 6.5, pz = dz + uz * i * 9 + vz * j * 6.5;
        b.addBox(0.4, 6.2, 0.4, px, 3.1, pz, 0x6b6e70, rot);
        addStaticBox(W, px, at + 3.1, pz, 0.2, 3.1, 0.2, GROUP.PROP, rot);
      }
    }
    b.addTaperedBox(14.5, 1.6, 20, dx, 6.9, dz, 0x7b2f24, 0.55, 1, rot);
    // Straw stacked in one bay of it.
    b.addBox(5.5, 2.4, 7, dx - ux * 6 + vx * 2.5, 1.2, dz - uz * 6 + vz * 2.5, 0xc2a45a, rot);
    addStaticBox(W, dx - ux * 6 + vx * 2.5, at + 1.2, dz - uz * 6 + vz * 2.5, 2.75, 1.2, 3.5, GROUP.BUILDING, rot);
    pieces.push([s2, b.vertexCount, dx, dz]);

    // A silo.
    const sx = f.x + ux * 4 - vx * 30, sz = f.z + uz * 4 - vz * 30;
    const s3 = b.vertexCount;
    b.addTaperedBox(5, 14, 5, sx, 7, sz, 0x8f9496, 0.92, 0.92, rng() * TAU);
    pieces.push([s3, b.vertexCount, sx, sz]);
    addStaticBox(W, sx, at + 7, sz, 2.5, 7, 2.5, GROUP.BUILDING);
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'farms';

  // The yards: concrete, the size the grip grid has them.
  const y = new MeshBuilder();
  const m4 = new THREE.Matrix4();
  for (const f of farms) {
    const g = new THREE.CircleGeometry(22, 28);
    g.rotateX(-Math.PI / 2);
    m4.makeTranslation(f.x, 0.04, f.z);
    y.addGeometry(g, m4, 0x6f6c64);
    g.dispose();
  }
  const yards = new THREE.Mesh(y.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  liftMesh(yards, ctx.at);
  yards.receiveShadow = true;
  yards.name = 'yards';
  return [mesh, yards];
}

// =====================================================================
//  Hedges
// =====================================================================

/**
 * Hedgerows: both sides of every lane and B-road out of the villages, and the
 * boundaries between fields. Solid -- a hedge is a wall a car does not go
 * through -- but with gateways: every field has gaps onto its neighbours and
 * onto the lane, so the fields are a second, slower map under the roads.
 */
function buildHedges(ctx, fields) {
  const { graph, rng } = ctx;
  const b = new MeshBuilder();
  const W = ctx.sim.world;
  ctx.sim.hedges = new Set();
  // One hedge, one look: every piece of a run between two gaps takes the
  // height and colour of its first. Each 8 m piece used to draw its own, and
  // a hedge read as a row of separate bushes of different heights -- "make it
  // so the hedges are one big sort of line instead of lots of multiple
  // different sections". The draws are still taken piece by piece, so
  // everything drawn after the hedges is where it was.
  const hedge = (x0, z0, x1, z1, run) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1.5) return false;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    if (inVillage(ctx, mx, mz, 5) || ctx.farms.some((f) => Math.hypot(f.x - mx, f.z - mz) < 42)) return false;
    if (graph.overlapsRoad(mx, mz, len, 1.4, Math.atan2(x1 - x0, z1 - z0), 1.0)) return false;
    const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
    const rot = Math.atan2(-dz, dx);
    let h = rand(rng, 1.6, 2.3);
    let c = new THREE.Color().setHSL(rand(rng, 0.25, 0.30), rand(rng, 0.35, 0.5), rand(rng, 0.13, 0.19));
    // Not across the railway, a shortcut or the quarry -- left out after the
    // draws, so every hedge after it is the same as before they were there.
    if (ctx.clearAt(mx, mz) || ctx.clearAt(x0, z0) || ctx.clearAt(x1, z1)) return false;
    if (run) {
      if (!run.c) { run.h = h; run.c = c; }
      h = run.h; c = run.c;
    }
    // Down into the ground a little, so the hedges by a lane -- where the
    // drawn ground is dropped under the tarmac -- do not float. Overlapping
    // its neighbours by HEDGE_LAP, so a run is joined up round a bend too.
    b.addTaperedBox(len + HEDGE_LAP, h + 0.8, 1.5, mx, h * 0.5 - 0.4, mz, c, 1, 0.75, rot);
    // Solid well above what is drawn. The AI's tests for "is there a clear
    // line to the target" sweep level from the car, and from a car on a
    // slope that line passed over a two-metre hedge further down: police took
    // it as open ground and drove across the field into the hedge -- on the
    // first chase rig 85% of their time was off the road, at 36 km/h. A hedge
    // as tall as a house to the sweeps (and to sight: you can hide behind
    // one) keeps them to the lanes, which is where the way through is.
    //
    // Not to a car, though: "make it so you can go through hedges, but it
    // reduces the player's speed slightly ... just for a second". It collides
    // with nothing that drives, and Vehicle._hedgeDrag charges for the trip.
    // Not a sensor: rays ignore sensors, and the police would have seen
    // straight through every hedge on the map.
    const body = addStaticBox(W, mx, ctx.at(mx, mz) + HEDGE_SOLID * 0.5, mz, len * 0.5, HEDGE_SOLID * 0.5, 0.7,
      hedgeWall() ? GROUP.BUILDING | GROUP.HEDGE : GROUP.HEDGE, rot, 0xFFFF & ~GROUP.VEHICLE);
    ctx.sim.hedges.add(body.collider(0).handle);
    return true;
  };

  // Along the roads, in runs of up to 8 m, with gaps near junctions and gates.
  // (Almost none of these stand: 1.8 m off the tarmac, overlapsRoad turns
  // down all but nine of some 3,300. The hedges of the vale are the field
  // boundaries below. Left as it is -- the lanes are open, and the chases and
  // the sight lines are tuned to that.)
  for (const e of graph.edges) {
    if (e.cut || e.turningHead || e.village || e.farm) continue;
    const off = e.width * 0.5 + 1.8;
    for (const side of [1, -1]) {
      let s = 16;
      let gate = rand(rng, 40, 140);
      let run = {};
      while (s < e.length - 16) {
        if (s > gate) { s += 7; gate = s + rand(rng, 60, 180); run = {}; continue; }
        const p = pointOn(e, s), q = pointOn(e, Math.min(e.length - 16, s + 8));
        hedge(p.x + p.nx * off * side, p.z + p.nz * off * side, q.x + q.nx * off * side, q.z + q.nz * off * side, run);
        s += 8;
      }
    }
  }

  // Between fields: walk each seed's neighbours' bisectors.
  ctx.gateSpots = [];
  const { seeds, nearest } = fields;
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const A = seeds[i], B = seeds[j];
      const d = Math.hypot(B.x - A.x, B.z - A.z);
      if (d > 260) continue;
      if (A.wood && B.wood) continue;
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
      const m = nearest(mx, mz).s;
      if (m !== A && m !== B) continue;
      // Along the bisector both ways while A and B are still the two nearest.
      const ux = -(B.z - A.z) / d, uz = (B.x - A.x) / d;
      const run = [];
      for (const dir of [1, -1]) {
        for (let t = 0; t < 400; t += 4) {
          const x = mx + ux * t * dir, z = mz + uz * t * dir;
          // Not past the edge of the world: the fields have no edge of their
          // own, and their hedges ran on out over the void.
          if (Math.abs(x) > EDGE_FACE - 2 || Math.abs(z) > EDGE_FACE - 2) break;
          const n = nearest(x, z).s;
          if (n !== A && n !== B) break;
          run.push({ x, z, t: t * dir });
        }
      }
      run.sort((p, q) => p.t - q.t);
      // In 8 m pieces, with a gateway somewhere along it.
      // In 8 m pieces, with a gateway somewhere along it -- and in the
      // gateway a field gate between two posts, fenced across to the hedge
      // either side (buildGates in countryextras.js): "occasionally have
      // gaps, and that's where I want the fence, and ... the gates". Only
      // where there is hedge on both sides of the gap: a gate standing alone
      // in the open is nothing.
      const gate = randInt(rng, 1, Math.max(1, Math.floor(run.length / 2) - 1));
      const look = {};
      const placed = [];
      for (let k = 0; k + 2 < run.length; k += 2) {
        if (Math.abs(k / 2 - gate) < 1) continue;
        placed[k / 2] = hedge(run[k].x, run[k].z, run[k + 2].x, run[k + 2].z, look);
      }
      const g0 = run[gate * 2], g1 = run[gate * 2 + 2];
      if (g0 && g1 && placed[gate - 1] && placed[gate + 1]) {
        ctx.gateSpots.push({ x: (g0.x + g1.x) / 2, z: (g0.z + g1.z) / 2, rot: Math.atan2(B.x - A.x, B.z - A.z) });
      }
    }
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftMesh(mesh, ctx.at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'hedges';
  return mesh;
}

// =====================================================================
//  Trees, bales, turbines
// =====================================================================

function addTreeT(ctx, b, pieces, x, z, scale = 1) {
  const { rng, graph } = ctx;
  if (graph.overlapsRoad(x, z, 2.4, 2.4, 0, 2.5)) return false;
  if (inVillage(ctx, x, z, -20) || ctx.farms.some((f) => Math.hypot(f.x - x, f.z - z) < 40)) return false;
  const h = rand(rng, 8, 15) * scale;
  // Not through a barn roof or a cottage wall, crown and all. See nearBuilding.
  if (nearBuilding(ctx.sim.world, x, z, h * 0.4)) return false;
  const crown = new THREE.Color().setHSL(rand(rng, 0.22, 0.31), rand(rng, 0.30, 0.48), rand(rng, 0.12, 0.21));
  const turn = rand(rng, 0, TAU);
  // Not on the railway, a shortcut or in the quarry: after the draws, as with
  // the hedges, so the woods are the woods they were.
  if (ctx.clearAt(x, z)) return false;
  const trunk = 0.55 + h * 0.035;
  const s = b.vertexCount;
  b.addBox(trunk, h * 0.5, trunk, x, h * 0.25, z, 0x463726);
  b.addTaperedBox(h * 0.8, h * 0.72, h * 0.8, x, h * 0.66, z, crown, 0.22, 0.22, turn);
  pieces.push([s, b.vertexCount, x, z]);
  addStaticBox(ctx.sim.world, x, ctx.at(x, z) + 2.6, z, 0.65, 2.6, 0.65, GROUP.PROP);
  // From the highest ground under the crown, not the foot of the trunk: on a
  // hillside the crown's uphill edge is that much nearer the ground, and a
  // car climbing past met leaves where it could see none.
  const r = h * 0.8 * 0.35;
  let top = ctx.at(x, z);
  for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
    top = Math.max(top, ctx.at(x + ox, z + oz));
  }
  addCanopy(ctx.sim.world, x, z, top, h * 0.66, h * 0.72, h * 0.8);
  return true;
}

function buildWoods(ctx, fields) {
  const { rng, graph } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  let n = 0;
  // Woodland: a jittered lattice over every wood cell.
  for (let x = -WORLD_HALF + 40; x < WORLD_HALF - 40; x += 11) {
    for (let z = -WORLD_HALF + 40; z < WORLD_HALF - 40; z += 11) {
      const px = x + rand(rng, -4, 4), pz = z + rand(rng, -4, 4);
      const { s, edge } = fields.nearest(px, pz);
      if (!s || !s.wood || edge < 2) continue;
      if (rng() < 0.18) continue;                 // clearings
      if (addTreeT(ctx, b, pieces, px, pz, rand(rng, 0.85, 1.3))) n++;
    }
  }
  // Hedgerow oaks along the lanes, and a few standing alone in fields.
  for (const e of graph.edges) {
    if (e.cut || e.turningHead || e.village || e.farm) continue;
    for (let s = 30; s < e.length - 30; s += rand(rng, 35, 90)) {
      const p = pointOn(e, s);
      const side = rng() < 0.5 ? 1 : -1;
      const off = e.width * 0.5 + 3.4;
      if (addTreeT(ctx, b, pieces, p.x + p.nx * off * side, p.z + p.nz * off * side, rand(rng, 1.0, 1.4))) n++;
    }
  }
  for (let i = 0; i < 90; i++) {
    const x = rand(rng, -WORLD_HALF + 60, WORLD_HALF - 60), z = rand(rng, -WORLD_HALF + 60, WORLD_HALF - 60);
    if (fields.nearest(x, z).s.wood) continue;
    if (addTreeT(ctx, b, pieces, x, z, rand(rng, 1.1, 1.6))) n++;
  }
  ctx.treeCount = n;
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  mesh.castShadow = true;
  mesh.name = 'trees';
  return mesh;
}

/**
 * Round bales you can knock about. "The bales, can you make them like cones
 * in the sense that you can like whack them and kind of hit them around?"
 *
 * Each is a dynamic cylinder standing on its end, BALE_MASS kilos -- light
 * enough that a car at speed sends it flying and barely feels it (under the
 * impact threshold at any speed, see Vehicle.takeImpact), heavy enough that a
 * nudge only rolls it. In GROUP.DEBRIS with the cones, so no AI sweep or eye
 * sees one: a police car drives through a row of bales, it does not brake
 * for them. They sleep until something touches them.
 *
 * Drawn as one instanced mesh, moved by `update`, which the game calls every
 * frame. The bodies rest on whatever is highest of the flat plate and the
 * heightfield, and the heightfield is sunk HILL_SINK under the drawn ground,
 * so each is drawn lifted by the difference where it stands.
 */
function buildBales(ctx, spots) {
  const W = ctx.sim.world;
  const geo = new THREE.CylinderGeometry(BALE_R, BALE_R, BALE_H, 14, 1);
  const mat = new THREE.MeshLambertMaterial({ color: 0xb79a52 });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, spots.length));
  mesh.count = spots.length;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'bales';
  const bodies = [];
  for (const { x, z, rot } of spots) {
    const y = ctx.at(x, z) + BALE_H * 0.5 + 0.05;
    const body = W.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(rot / 2), z: 0, w: Math.cos(rot / 2) })
        .setLinearDamping(0.25)
        .setAngularDamping(0.5)
        .setCcdEnabled(true),
    );
    W.createCollider(
      RAPIER.ColliderDesc.cylinder(BALE_H * 0.5, BALE_R)
        .setMass(BALE_MASS)
        .setFriction(0.8)
        .setRestitution(0.1)
        .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.HILL | GROUP.VEHICLE | GROUP.DEBRIS)),
      body,
    );
    // Start asleep, standing: eighty-odd bales do not need solving until hit.
    body.sleep();
    bodies.push(body);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const lift = (x, z) => {
    const h = ctx.at(x, z);
    // (Below zero there is no plate: the quarry's hole. The heightfield it is.)
    return h < 0 ? HILL_SINK : h - Math.max(0, h - HILL_SINK);
  };
  const update = () => {
    for (let i = 0; i < bodies.length; i++) {
      const t = bodies[i].translation(), r = bodies[i].rotation();
      p.set(t.x, t.y + lift(t.x, t.z), t.z);
      q.set(r.x, r.y, r.z, r.w);
      m.compose(p, q, one);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update();
  mesh.computeBoundingSphere();
  // Bales roll; the bounds are the whole map, so the mesh is never culled.
  mesh.frustumCulled = false;
  return { mesh, bodies, update };
}

function buildBalesAndTurbines(ctx, fields, hills) {
  const { rng, graph } = ctx;
  const b = new MeshBuilder();
  const pieces = [];
  const W = ctx.sim.world;
  // Round bales, in rows in a few of the stubble fields. Loose: see buildBales.
  const stubble = fields.seeds.filter((s) => !s.wood && (s.crop === CROPS[4] || s.crop === CROPS[5]));
  // Where the harvest is (countrylife.js): a trailer of bales by the first
  // field of bales, and a combine in the first wheat field without any.
  ctx.baleField = stubble[0] || null;
  ctx.combineField = stubble[BALE_FIELDS] || null;
  const bales = [];
  // More of them, two rows to a field: "can you add a few more bales on the
  // new map? Because I love them." 14 fields of 6 was 78 bales.
  for (const s of stubble.slice(0, BALE_FIELDS)) {
    const rot = rng() * TAU;
    for (let k = 0; k < BALE_ROW * 2; k++) {
      const row = k < BALE_ROW ? -1 : 1, i = (k % BALE_ROW) - (BALE_ROW - 1) / 2;
      const ox = Math.cos(rot) * i * 8 - Math.sin(rot) * row * 6, oz = Math.sin(rot) * i * 8 + Math.cos(rot) * row * 6;
      const x = s.x + ox + rand(rng, -1, 1), z = s.z + oz + rand(rng, -1, 1);
      if (graph.overlapsRoad(x, z, 2, 2, 0, 3) || inVillage(ctx, x, z, 0) || nearBuilding(ctx.sim.world, x, z, 1.2) || ctx.clearAt(x, z)) continue;
      bales.push({ x, z, rot });
    }
  }
  ctx.bales = buildBales(ctx, bales.concat(ctx.extraBales || []));
  // Wind turbines along the tops of the big hills.
  for (const h of hills) {
    for (let k = 0; k < 3; k++) {
      const a = rng() * TAU, r = rand(rng, 0, h.r * 0.35);
      const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
      if (graph.overlapsRoad(x, z, 6, 6, 0, 8)) continue;
      // Off the quarry and the railway, its blades' draws taken all the same.
      if (ctx.clearAt(x, z)) { rng(); rng(); rng(); continue; }
      const p0 = b.vertexCount;
      b.addTaperedBox(2.2, 48, 2.2, x, 24, z, 0xdfe3e6, 0.55, 0.55);
      b.addBox(2.4, 2.4, 5, x, 49, z, 0xdfe3e6, a);
      const fx = Math.sin(a), fz = Math.cos(a);
      for (let blade = 0; blade < 3; blade++) {
        const ba = blade * (TAU / 3) + rng();
        const bx = x + fx * 2.8, bz = z + fz * 2.8;
        // A blade is a long thin box hung off the hub, turned in the rotor's plane.
        const len = 20;
        const g = new THREE.BoxGeometry(0.5, len, 0.9);
        const m = new THREE.Matrix4().makeRotationY(a)
          .multiply(new THREE.Matrix4().makeRotationZ(ba))
          .multiply(new THREE.Matrix4().makeTranslation(0, len / 2, 0));
        m.setPosition(new THREE.Vector3().setFromMatrixPosition(m).add(new THREE.Vector3(bx, 49, bz)));
        b.addGeometry(g, m, 0xeef1f3);
        g.dispose();
      }
      pieces.push([p0, b.vertexCount, x, z]);
      addStaticBox(W, x, ctx.at(x, z) + 24, z, 1.1, 24, 1.1, GROUP.BUILDING);
    }
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  liftPieces(mesh, ctx.at, pieces);
  mesh.castShadow = true;
  mesh.name = 'bales-turbines';
  return mesh;
}
