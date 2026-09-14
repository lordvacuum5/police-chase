// Procedural authoring of the map.
//
// "Hand-authored" here means the *layout rules* are authored rather than the
// individual polygons: the downtown grid, the park superblock, the suburban
// thinning, the industrial strip, the roundabout and the ring motorway are all
// deliberate, and every road that results is registered in the road graph so
// the police AI can reason about it. The seed is fixed, so the same city is
// rebuilt identically every run.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { RoadGraph, ROAD_KIND } from './roadgraph.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, closestOnSegment, TAU } from '../util/math.js';
import {
  WORLD_HALF, CELL, GRID_N, KERB_H, SURF_GRASS, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, paintRect, makeSurfaceAt, makeHeightAt, buildGround, buildRoadMeshes, DRAW_ORDER,
} from './common.js';


const RING = 780;          // motorway distance from the centre
const RING_CORNER = 200;   // corner radius of the ring road

// Downtown is tight; the outer rings open up. Uneven spacing on purpose --
// a perfectly regular grid makes every chase look the same.
const GRID = [-620, -500, -400, -320, -240, -160, -80, 0, 80, 160, 240, 320, 400, 500, 620];
const AVENUES = new Set([0, -400, 400]);
const DOWNTOWN = 320;



export function buildCity(sim, scene, seed = 20260822) {
  const rng = makeRng(seed);
  const graph = new RoadGraph(48);
  const surface = new Uint8Array(GRID_N * GRID_N);   // defaults to grass

  const ctx = { sim, scene, rng, graph, surface, colliders: [], junctions: [] };

  const gridNodes = buildStreetGrid(ctx);
  const parkCells = carvePark(ctx, gridNodes);
  const ringNodes = buildRingMotorway(ctx);
  connectRamps(ctx, gridNodes, ringNodes);
  buildCountryRoads(ctx, ringNodes);
  const roundabout = buildRoundabout(ctx, gridNodes);

  // Round off every dead end before the network is frozen.
  graph.addTurningHeads(15, 10, WORLD_HALF);
  graph.finalise();
  nameRoads(graph);

  // --- visuals -------------------------------------------------------
  rasteriseSurfaces(ctx, parkCells);
  const meshes = [];
  meshes.push(buildGround(ctx));
  meshes.push(...buildRoadMeshes(ctx));
  meshes.push(...buildBlocks(ctx, gridNodes, parkCells, roundabout));
  // Motorway crash barriers removed: the carriageway is open at the verges.
  meshes.push(...buildCountryside(ctx));

  for (const m of meshes) if (m) scene.add(m);

  const surfaceAt = makeSurfaceAt(surface);
  const heightAt = makeHeightAt(surface);

  return { graph, surfaceAt, heightAt, meshes, roundabout, bounds: WORLD_HALF };
}

// =====================================================================
//  Road network
// =====================================================================

function buildStreetGrid(ctx) {
  const { graph, rng } = ctx;
  const N = GRID.length;
  const nodes = [];

  for (let i = 0; i < N; i++) {
    nodes[i] = [];
    for (let j = 0; j < N; j++) {
      nodes[i][j] = graph.addNode(GRID[i], GRID[j], 'cross');
    }
  }

  const kindFor = (x0, z0, x1, z1) => {
    const onAvenue = (x0 === x1 && AVENUES.has(x0)) || (z0 === z1 && AVENUES.has(z0));
    return onAvenue ? 'avenue' : 'street';
  };

  const isOuter = (i, j) => Math.abs(GRID[i]) > DOWNTOWN || Math.abs(GRID[j]) > DOWNTOWN;

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      // east neighbour
      if (i < N - 1) {
        const outer = isOuter(i, j) && isOuter(i + 1, j);
        // Thin the suburbs so they are not a perfect lattice; downtown stays dense.
        if (!(outer && rng() < 0.17)) {
          graph.addEdge(nodes[i][j], nodes[i + 1][j],
            kindFor(GRID[i], GRID[j], GRID[i + 1], GRID[j]));
        }
      }
      // north neighbour
      if (j < N - 1) {
        const outer = isOuter(i, j) && isOuter(i, j + 1);
        if (!(outer && rng() < 0.17)) {
          graph.addEdge(nodes[i][j], nodes[i][j + 1],
            kindFor(GRID[i], GRID[j], GRID[i], GRID[j + 1]));
        }
      }
    }
  }

  // Any node the thinning stranded gets reconnected, so the AI never routes
  // itself into a dead pocket it cannot leave.
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const n = nodes[i][j];
      if (n.edges.length > 0) continue;
      if (i < N - 1) graph.addEdge(n, nodes[i + 1][j], 'street');
      else graph.addEdge(n, nodes[i - 1][j], 'street');
    }
  }

  return { nodes, N };
}

/**
 * A park superblock: pull out a 2x2 patch of streets in the north-west of
 * downtown and wrap it with a curving perimeter road. Chases through here play
 * completely differently -- open sightlines, one way in at each corner.
 */
function carvePark(ctx, grid) {
  const { graph } = ctx;
  const { nodes } = grid;
  // Grid indices 3..5 map to -320..-160.
  const i0 = 3, i1 = 5, j0 = 8, j1 = 10;

  const doomed = new Set();
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const n = nodes[i][j];
      if (i > i0 && i < i1 && j > j0 && j < j1) doomed.add(n.id);
    }
  }

  // Drop every edge that touches an interior node.
  for (const e of graph.edges) {
    if (doomed.has(e.a) || doomed.has(e.b)) e.removed = true;
  }
  graph.edges = graph.edges.filter((e) => !e.removed);
  graph.edges.forEach((e, i) => { e.id = i; });
  for (const n of graph.nodes) n.edges = [];
  graph.edges.forEach((e) => {
    graph.nodes[e.a].edges.push(e.id);
    graph.nodes[e.b].edges.push(e.id);
  });

  return {
    minX: GRID[i0], maxX: GRID[i1],
    minZ: GRID[j0], maxZ: GRID[j1],
  };
}

/**
 * The ring motorway: a rounded rectangle sampled into graph nodes. Three lanes
 * each way, open at the verges, and no road across it except at a junction --
 * which is exactly what makes it a tactical space rather than just fast road.
 */
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
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push({ x: lerp(x0, x1, t), z: lerp(z0, z1, t) });
    }
  };

  // East side (x = +RING), heading north; then NE corner; and so on round.
  //
  // The corners are sampled finely. A 200 m radius bend cut into five chords
  // has an 18 degree kink at every node, and the AI speed planner reads those
  // kinks as a hairpin -- it would brake to 40 km/h for a curve you can take
  // flat out.
  along(RING, -straight, RING, straight, 9);
  arc(straight, straight, 0, Math.PI / 2, 16);
  along(straight, RING, -straight, RING, 9);
  arc(-straight, straight, Math.PI / 2, Math.PI, 16);
  along(-RING, straight, -RING, -straight, 9);
  arc(-straight, -straight, Math.PI, Math.PI * 1.5, 16);
  along(-straight, -RING, straight, -RING, 9);
  arc(straight, -straight, Math.PI * 1.5, TAU, 16);

  const ring = pts.map((p) => graph.addNode(p.x, p.z, 'motorway'));
  for (let i = 0; i < ring.length; i++) {
    graph.addEdge(ring[i], ring[(i + 1) % ring.length], 'motorway');
  }
  return ring;
}

/** Slip roads linking the ring to the city. Six of them, deliberately uneven. */
/**
 * Walk the ring polyline outward from a node, emitting points every `step`
 * metres offset to one side. Used to describe a junction's merge corridor.
 *
 * It has to follow the polyline rather than the straight tangent: 165 m along
 * a 200 m radius bend departs from the tangent by more than 60 m, which would
 * put the markers out in a field.
 */
function walkRing(ring, idx, backDist, aheadDist, step = 12) {
  const N = ring.length;
  const at = (i) => ring[((i % N) + N) % N];
  const pts = [];

  // Behind the node, measuring real distance along the polyline. Indexing by
  // array position instead would compress the taper wherever the ring is
  // finely sampled -- which is exactly on the corner arcs.
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

/** Offset a ring-walk point sideways from the carriageway centreline. */
function offsetOf(p, side, dist) {
  return { x: p.x + -p.fz * side * dist, z: p.z + p.fx * side * dist };
}

/**
 * Attach one slip road to the ring motorway.
 *
 * The ramp runs alongside the carriageway and closes on it at about thirteen
 * degrees rather than meeting it square on, so it merges the way a real slip
 * road does. Each junction claims a stretch of ring to itself, which is what
 * stops a road from joining on one side and continuing straight out the other
 * -- you cannot drive across a motorway.
 */
function addSlipRoad(ctx, ring, anchor, aim) {
  const { graph, junctions } = ctx;
  const half = ROAD_KIND.motorway.width * 0.5;
  const MERGE_BACK = 165;

  /** Shortest distance from a point to the motorway centreline. */
  const distToRing = (px, pz) => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const r = closestOnSegment(px, pz, a.x, a.z, b.x, b.z);
      if (r.dist < best) best = r.dist;
    }
    return best;
  };

  // Try ring nodes nearest the aim first, but only accept one whose resulting
  // geometry is actually legal.
  const candidates = ring
    .map((n, i) => ({ i, d: dist2(n.x, n.z, aim.x, aim.z) }))
    .sort((p, q) => p.d - q.d);

  for (const cand of candidates) {
    const idx = cand.i;
    const N = ring[idx];

    let clash = false;
    for (const j of junctions) {
      if (dist2(N.x, N.z, j.node.x, j.node.z) < 260) { clash = true; break; }
    }
    if (clash) continue;

    const prev = ring[(idx - 1 + ring.length) % ring.length];
    const next = ring[(idx + 1) % ring.length];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;

    // Which side of the carriageway does this road come from?
    const side = ((anchor.x - N.x) * -tz + (anchor.z - N.z) * tx) >= 0 ? 1 : -1;

    // Taper points, following the ring away from the merge so the geometry
    // stays glued to a curved carriageway. Indexed by metres, not by array
    // position -- indexing by position compresses the taper on the corners.
    //
    // The taper runs toward whichever side of the junction the anchor is on.
    // Always tapering one way means that when the approach comes from the
    // other direction the ramp has to double back on itself, which produced a
    // 160 degree hairpin metres before the merge.
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

    // The approach from the anchor is a cubic Bezier that *arrives already
    // pointing along the taper*. Joining the two with a straight line instead
    // leaves a corner at the top of the taper -- and when the anchor sits
    // roughly abeam of the junction that corner is a 160 degree hairpin, a few
    // car lengths before the merge.
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
      approach.push({
        x: w0 * anchor.x + w1 * c1.x + w2 * c2.x + w3 * t0.x,
        z: w0 * anchor.z + w1 * c1.z + w2 * c2.z + w3 * t0.z,
      });
    }

    // Everything before the taper must stay well clear of the carriageway.
    // Without this the approach can cut straight across the motorway to reach
    // a node that happened to be nearest.
    let legal = true;
    for (const q of approach) {
      if (distToRing(q.x, q.z) < half + 4) { legal = false; break; }
    }
    if (!legal) continue;

    // Reject the whole candidate if the resulting road has a sharp corner in
    // it. A node that is simply too close to the anchor leaves no room for the
    // approach to turn, and the Bezier folds back on itself; trying the next
    // node along gives the ramp the distance it needs.
    const full = [anchor, ...approach, taper[0], taper[1], taper[2], N];
    let sharpest = 0;
    for (let i = 1; i < full.length - 1; i++) {
      const ux = full[i - 1].x - full[i].x, uz = full[i - 1].z - full[i].z;
      const vx = full[i + 1].x - full[i].x, vz = full[i + 1].z - full[i].z;
      const ul = Math.hypot(ux, uz) || 1, vl = Math.hypot(vx, vz) || 1;
      const dot = clamp((ux * vx + uz * vz) / (ul * vl), -1, 1);
      sharpest = Math.max(sharpest, Math.PI - Math.acos(dot));
    }
    if (sharpest > 1.25) continue;      // about 72 degrees

    graph.addEdge(anchor, N, 'ramp', [...approach, taper[0], taper[1], taper[2]]);

    // The corridor the barrier must leave open, on this side only.
    junctions.push({
      node: N,
      markers: walkRing(ring, idx, MERGE_BACK + 25, MERGE_BACK + 25, 10)
        .map((p) => offsetOf(p, side, half * 0.55)),
    });
    return N;
  }
  return null;
}

function connectRamps(ctx, grid, ring) {
  const { nodes } = grid;

  // Anchors must sit on the edge of the grid: a slip road hung off an interior
  // junction would have to cut diagonally through built-up blocks to reach the
  // ring, and would end up running through buildings.
  const anchors = [
    nodes[14][7],   // east, x=620 z=0
    nodes[0][7],    // west
    nodes[7][14],   // north
    nodes[7][0],    // south
    nodes[14][14],  // north-east corner
    nodes[0][0],    // south-west corner
  ];

  for (const a of anchors) {
    addSlipRoad(ctx, ring, a, { x: a.x * 1.35, z: a.z * 1.35 });
  }
}

/** Winding country roads outside the ring, plus a hamlet in one corner. */
function buildCountryRoads(ctx, ring) {
  const { graph, rng } = ctx;
  const outer = [];

  // A loop of waypoints out in the fields, at a varying radius so the roads
  // genuinely wander instead of tracing a circle.
  const COUNT = 16;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * TAU + 0.2;
    const r = RING + 90 + Math.sin(a * 3.0) * 55 + Math.cos(a * 1.7) * 40;
    outer.push(graph.addNode(Math.cos(a) * r, Math.sin(a) * r, 'country'));
  }

  for (let i = 0; i < COUNT; i++) {
    const a = outer[i], b = outer[(i + 1) % COUNT];
    // Bulge the midpoint outward or inward to make a real bend.
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    const nx = -(b.z - a.z), nz = (b.x - a.x);
    const nl = Math.hypot(nx, nz) || 1;
    const bulge = rand(rng, -60, 60);
    graph.addEdge(a, b, 'country', [{
      x: mx + (nx / nl) * bulge,
      z: mz + (nz / nl) * bulge,
    }]);
  }

  // Spurs joining the country loop to the ring road, so escaping into the
  // fields is a real option rather than a dead end. These merge exactly like
  // the city slip roads, and claim their own stretch of ring -- so a country
  // road can never line up with a city ramp to form a crossing.
  for (let i = 0; i < COUNT; i += 3) {
    const a = outer[i];
    addSlipRoad(ctx, ring, a, { x: a.x * 0.86, z: a.z * 0.86 });
  }

  // A hamlet: a short cluster of narrow lanes hanging off the country loop.
  const seedNode = outer[5];
  let prev = seedNode;
  const hamlet = [];
  for (let k = 0; k < 5; k++) {
    const n = graph.addNode(
      seedNode.x + Math.cos(k * 1.25) * (40 + k * 26) + rand(ctx.rng, -18, 18),
      seedNode.z + Math.sin(k * 1.25) * (40 + k * 26) + rand(ctx.rng, -18, 18),
      'lane',
    );
    graph.addEdge(prev, n, 'lane');
    hamlet.push(n);
    prev = n;
  }
  // Close the loop so the hamlet is not a trap.
  graph.addEdge(prev, outer[6], 'lane');

  ctx.hamlet = hamlet;
  ctx.countryLoop = outer;
  return outer;
}

/** One roundabout, replacing a suburban crossroads. */
function buildRoundabout(ctx, grid) {
  const { graph } = ctx;
  const centre = grid.nodes[12][7];   // x = 400, z = 0
  const R = 30;

  // Detach the four approaches from the crossroads node and hang them off a
  // ring of nodes instead.
  const approaches = centre.edges.slice();
  const ringNodes = [];
  const K = 8;
  for (let k = 0; k < K; k++) {
    const a = (k / K) * TAU;
    ringNodes.push(graph.addNode(centre.x + Math.cos(a) * R, centre.z + Math.sin(a) * R, 'roundabout'));
  }
  for (let k = 0; k < K; k++) {
    graph.addEdge(ringNodes[k], ringNodes[(k + 1) % K], 'street', null, { width: 11, speed: 12 });
  }

  for (const eid of approaches) {
    const e = graph.edges[eid];
    const otherId = e.a === centre.id ? e.b : e.a;
    const o = graph.nodes[otherId];
    // Pick the ring node closest to the approach direction.
    let best = ringNodes[0], bd = Infinity;
    for (const rn of ringNodes) {
      const d = (rn.x - o.x) ** 2 + (rn.z - o.z) ** 2;
      if (d < bd) { bd = d; best = rn; }
    }
    graph.addEdge(best, o, e.kind);
    e.dead = true;
  }

  graph.edges = graph.edges.filter((e) => !e.dead);
  graph.edges.forEach((e, i) => { e.id = i; });
  for (const n of graph.nodes) n.edges = [];
  graph.edges.forEach((e) => {
    graph.nodes[e.a].edges.push(e.id);
    graph.nodes[e.b].edges.push(e.id);
  });

  return { x: centre.x, z: centre.z, r: R };
}

// =====================================================================
//  Road naming -- so dispatch can say where you are
// =====================================================================

const NS_NAMES = [
  'Kingsway', 'Ashcroft Road', 'Verne Street', 'Halloway', 'Bright Lane',
  'Carrick Road', 'Meridian Avenue', 'Osprey Street', 'Faraday Road',
  'Linden Way', 'Marlow Street', 'Quarry Road', 'Sutton Row', 'Weir Street',
  'Bellamy Road',
];
const EW_ORDINALS = [
  'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth',
  'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth',
];
const COUNTRY_NAMES = [
  'Fen Road', 'Barrow Lane', 'Cold Harbour', 'Mill Track', 'Hollow Road',
  'Stannard Lane', 'Long Furlong', 'Thistledown',
];

function nameRoads(graph) {
  const gridIndex = (v) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < GRID.length; i++) {
      const d = Math.abs(GRID[i] - v);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  let countryN = 0;
  for (const e of graph.edges) {
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    if (e.kind === 'motorway') { e.name = 'the M1 ring'; continue; }
    if (e.kind === 'ramp') { e.name = 'the slip road'; continue; }
    if (e.kind === 'country') { e.name = COUNTRY_NAMES[(countryN++) % COUNTRY_NAMES.length]; continue; }
    if (e.kind === 'lane') { e.name = 'the village lanes'; continue; }

    if (Math.abs(a.x - b.x) < 1.0) {
      e.name = NS_NAMES[gridIndex(a.x) % NS_NAMES.length];
    } else if (Math.abs(a.z - b.z) < 1.0) {
      e.name = EW_ORDINALS[gridIndex(a.z) % EW_ORDINALS.length] + ' Street';
    } else {
      e.name = 'the roundabout';
    }
  }

  // Junctions take the names of the two widest roads meeting there.
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
//  Surface rasterisation
// =====================================================================


function rasteriseSurfaces(ctx, park) {
  const { graph, surface } = ctx;

  // City blocks are drawn as pavement, so they must not behave like a field.
  // Without this, clipping a kerb drops grip from 1.42 to 0.62 in one step and
  // the car snaps sideways for reasons the player cannot see.
  for (let i = 0; i < GRID.length - 1; i++) {
    for (let j = 0; j < GRID.length - 1; j++) {
      const cx = (GRID[i] + GRID[i + 1]) * 0.5;
      const cz = (GRID[j] + GRID[j + 1]) * 0.5;
      if (park && cx > park.minX && cx < park.maxX && cz > park.minZ && cz < park.maxZ) continue;
      paintRect(surface, GRID[i], GRID[j], GRID[i + 1], GRID[j + 1], SURF_PAVED);
    }
  }

  // Roads go on top, so junctions and carriageways win over the block fill.
  for (const e of graph.edges) {
    const half = e.width * 0.5;
    for (const s of e.segs) {
      // Step by a quarter of the disc radius, not by the cell size. The two
      // used to be the same thing; at metre cells, stepping every 0.75 m lays
      // down sixteen times the discs for a scallop of six centimetres, which
      // is a second of map build nobody can see.
      const steps = Math.max(1, Math.ceil(s.len / Math.max(CELL * 0.75, half * 0.25)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(s.a.x, s.b.x, t), lerp(s.a.z, s.b.z, t), half, SURF_ROAD);
      }
    }
  }
}

// =====================================================================
//  Visual construction
// =====================================================================


/**
 * Buildings, block by block. Height and footprint style vary by district:
 * towers downtown, warehouses in the industrial quadrant, houses in the
 * suburbs. Each gets a static box collider.
 */
function buildBlocks(ctx, grid, park, roundabout) {
  const { rng, sim } = ctx;
  const N = GRID.length;
  const builders = [new MeshBuilder(), new MeshBuilder(), new MeshBuilder(), new MeshBuilder()];
  const plates = new MeshBuilder();

  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const x0 = GRID[i], x1 = GRID[i + 1];
      const z0 = GRID[j], z1 = GRID[j + 1];
      const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;

      const inPark = cx > park.minX && cx < park.maxX && cz > park.minZ && cz < park.maxZ;

      // Inset from the road corridors so buildings never sit in the road. Must
      // clear the widest thing that can run along a block edge, which is an
      // avenue at 10 m from the centreline.
      const inset = 12;
      const bx0 = x0 + inset, bx1 = x1 - inset;
      const bz0 = z0 + inset, bz1 = z1 - inset;
      const bw = bx1 - bx0, bd = bz1 - bz0;
      if (bw < 12 || bd < 12) continue;

      const q = (cx >= 0 ? 1 : 0) + (cz >= 0 ? 2 : 0);
      const b = builders[q];

      // The footway, a kerb height above the carriageway, as one plate from
      // one road centre line to the next. The roads along its edges -- and any
      // lane, country road or roundabout crossing the block -- are drawn over it
      // whatever its height (see DRAW_ORDER in common.js), so it does not have
      // to be cut to fit them. It used to be: inset to each kerb line with its
      // corners bent round the junction fillets, and wherever a road crossed
      // the block, subdivided against the metre surface grid, which left a
      // stepped edge all the way along every one of those roads.
      const y = inPark ? KERB_H - 0.02 : KERB_H;
      const col = inPark ? 0x47512e : PALETTE.pavement;
      plates.addQuadY(x0, z0, x1, z0, x1, z1, x0, z1, y, col);

      if (inPark) { addParkContents(ctx, b, rng, bx0, bz0, bx1, bz1); continue; }

      const r = Math.max(Math.abs(cx), Math.abs(cz));
      const downtown = r <= DOWNTOWN;
      // The south-east quadrant beyond downtown is the industrial strip.
      const industrial = !downtown && cx > 0 && cz < 0;

      let count, hLo, hHi;
      if (downtown) { count = randInt(rng, 1, 3); hLo = 26; hHi = 92; }
      else if (industrial) { count = 1; hLo = 9; hHi = 16; }
      else { count = randInt(rng, 2, 4); hLo = 7; hHi = 17; }

      for (let k = 0; k < count; k++) {
        // Split the block into sub-plots so buildings sit shoulder to shoulder.
        const fx = count === 1 ? 0.92 : rand(rng, 0.34, 0.62);
        const fz = count === 1 ? 0.92 : rand(rng, 0.34, 0.62);
        const w = bw * fx, d = bd * fz;
        const px = count === 1 ? (bx0 + bx1) * 0.5 : rand(rng, bx0 + w / 2, bx1 - w / 2);
        const pz = count === 1 ? (bz0 + bz1) * 0.5 : rand(rng, bz0 + d / 2, bz1 - d / 2);
        const h = rand(rng, hLo, hHi) * (downtown ? lerp(1.25, 0.7, r / DOWNTOWN) : 1);

        // Keep the roundabout clear: its carriageway sweeps well outside the
        // straight block edges the inset was measured against.
        if (roundabout) {
          const rd = Math.hypot(px - roundabout.x, pz - roundabout.z);
          if (rd < roundabout.r + Math.max(w, d) * 0.5 + 8) continue;
        }

        const rot = downtown ? 0 : rand(rng, -0.06, 0.06);

        // Final guarantee: never place a building on a road. The block inset
        // handles the grid, but country roads and village lanes are laid out
        // afterwards with no knowledge of the city and can wander into a
        // corner block. Testing against the graph catches all of it.
        if (ctx.graph.overlapsRoad(px, pz, w, d, rot, 1.5)) continue;

        const tone = rand(rng, 0.30, 0.62);
        const warm = rand(rng, -0.04, 0.05);
        const col = new THREE.Color(tone + warm, tone, tone - warm * 0.6);
        const glass = new THREE.Color(tone * 0.42, tone * 0.46, tone * 0.55);
        b.addTaperedBox(w, h, d, px, h * 0.5, pz, col, downtown ? 0.92 : 1, downtown ? 0.92 : 1, rot);
        // A glazed band and a darker plinth stop them reading as plain cubes.
        b.addBox(w * 1.01, h * 0.16, d * 0.86, px, h * 0.74, pz, glass, rot);
        b.addBox(w * 1.02, 1.6, d * 1.02, px, 0.8, pz, 0x2a2c30, rot);
        if (downtown && h > 55) {
          b.addBox(w * 0.28, 6, d * 0.28, px, h + 3, pz, 0x35383d, rot);
        }

        addStaticBox(sim.world, px, h * 0.5, pz, w * 0.5, h * 0.5, d * 0.5, GROUP.BUILDING, rot);
      }
    }
  }

  const out = [];
  for (let q = 0; q < 4; q++) {
    const mesh = new THREE.Mesh(builders[q].build(), vertexColorMaterial());
    mesh.name = 'buildings' + q;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  const plate = new THREE.Mesh(plates.build(), vertexColorMaterial());
  plate.name = 'plates';
  plate.renderOrder = DRAW_ORDER.pavement;
  out.push(plate);
  return out;
}

function addParkContents(ctx, b, rng, x0, z0, x1, z1) {
  const n = randInt(rng, 6, 11);
  for (let i = 0; i < n; i++) {
    const px = rand(rng, x0 + 6, x1 - 6);
    const pz = rand(rng, z0 + 6, z1 - 6);
    if (ctx.graph.overlapsRoad(px, pz, 2.4, 2.4, 0, 2.0)) continue;
    const h = rand(rng, 5, 10);
    b.addBox(0.7, h * 0.45, 0.7, px, h * 0.22, pz, 0x4a3b2c);
    b.addTaperedBox(h * 0.75, h * 0.65, h * 0.75, px, h * 0.62, pz, 0x394d2c, 0.25, 0.25);
    // Park trees are solid too -- every tree in the game stops a car.
    addStaticBox(ctx.sim.world, px, 2.4, pz, 0.6, 2.4, 0.6, GROUP.PROP);
  }
}


/** Fields, hedgerows and copses beyond the ring. */
function buildCountryside(ctx) {
  const { rng, graph, sim } = ctx;
  const fields = new MeshBuilder();
  const trees = new MeshBuilder();

  // Field patches, drawn just above the ground plane.
  for (let i = 0; i < 90; i++) {
    const a = rng() * TAU;
    const r = rand(rng, RING - 40, WORLD_HALF - 40);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) continue;
    const w = rand(rng, 70, 190), d = rand(rng, 70, 190);
    const rot = rand(rng, 0, TAU);
    const c = new THREE.Color().setHSL(rand(rng, 0.16, 0.27), rand(rng, 0.16, 0.3), rand(rng, 0.20, 0.31));
    const ca = Math.cos(rot), sa = Math.sin(rot);
    const corner = (sx, sz) => ({
      x: cx + sx * w * 0.5 * ca - sz * d * 0.5 * sa,
      z: cz + sx * w * 0.5 * sa + sz * d * 0.5 * ca,
    });
    const p0 = corner(-1, -1), p1 = corner(1, -1), p2 = corner(1, 1), p3 = corner(-1, 1);
    fields.addQuadY(p0.x, p0.z, p1.x, p1.z, p2.x, p2.z, p3.x, p3.z, 0.01, c);
  }

  // Tree lines hugging the country roads, with colliders -- clipping one at
  // speed should cost you the chase.
  for (const e of graph.edges) {
    if (e.kind !== 'country' && e.kind !== 'lane') continue;
    for (const s of e.segs) {
      const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      const n = Math.floor(len / 26);
      for (let k = 0; k < n; k++) {
        if (rng() < 0.42) continue;
        const t = (k + 0.5) / n;
        const px = lerp(s.a.x, s.b.x, t), pz = lerp(s.a.z, s.b.z, t);
        const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len;
        const side = rng() < 0.5 ? 1 : -1;
        const off = e.width * 0.5 + rand(rng, 2.4, 5.0);
        const tx = px - dz * off * side, tz = pz + dx * off * side;
        // A tree beside this road may still be sitting in the middle of the
        // next one, so check the network rather than just the parent edge.
        if (graph.overlapsRoad(tx, tz, 1.6, 1.6, 0, 0.8)) continue;
        const h = rand(rng, 6, 12);
        trees.addBox(0.8, h * 0.5, 0.8, tx, h * 0.25, tz, 0x463726);
        trees.addTaperedBox(h * 0.8, h * 0.7, h * 0.8, tx, h * 0.68, tz, 0x33471f, 0.2, 0.2);
        addStaticBox(sim.world, tx, 2.5, tz, 0.6, 2.5, 0.6, GROUP.PROP);
      }
    }
  }

  scatterWoodland(ctx, trees);

  const fm = new THREE.Mesh(fields.build(), vertexColorMaterial());
  fm.name = 'fields';
  const tm = new THREE.Mesh(trees.build(), vertexColorMaterial());
  tm.name = 'trees';
  tm.castShadow = true;
  return [fm, tm];
}

/**
 * Copses and shelter belts across everything outside the city grid, including
 * the band the ring motorway runs through -- which was otherwise a bare green
 * plain with a road on it.
 *
 * Trees near a road get a collider, because clipping one at speed should end
 * your run. Trees far out in a field are visual only: they are scenery, and
 * a couple of thousand more static colliders would cost broad-phase time for
 * something you will never touch.
 */
function scatterWoodland(ctx, trees) {
  const { rng, graph, sim } = ctx;
  const CITY_EDGE = 645;
  let placed = 0, collided = 0;

  const addTree = (tx, tz, scale) => {
    // Never on a road. The margin keeps trunks off the verge as well.
    if (graph.overlapsRoad(tx, tz, 2.4, 2.4, 0, 2.0)) return;
    const h = rand(rng, 6, 13) * scale;
    const trunk = 0.55 + h * 0.035;
    trees.addBox(trunk, h * 0.5, trunk, tx, h * 0.25, tz, 0x463726);
    trees.addTaperedBox(h * 0.78, h * 0.72, h * 0.78, tx, h * 0.66, tz,
      new THREE.Color().setHSL(rand(rng, 0.22, 0.30), rand(rng, 0.28, 0.46), rand(rng, 0.13, 0.22)),
      0.22, 0.22, rand(rng, 0, TAU));
    placed++;
    // Every tree is solid. Making distant ones scenery-only saved broad-phase
    // work but meant you could drive straight through half the woodland.
    addStaticBox(sim.world, tx, 2.6, tz, 0.65, 2.6, 0.65, GROUP.PROP);
    collided++;
  };

  // ---- copses, thicker near the ring than out at the map edge ----
  for (let c = 0; c < 150; c++) {
    const a = rng() * TAU;
    const r = rand(rng, CITY_EDGE + 10, WORLD_HALF - 70);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    if (Math.max(Math.abs(cx), Math.abs(cz)) < CITY_EDGE) continue;
    if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) continue;

    const n = randInt(rng, 5, 16);
    const spread = rand(rng, 14, 46);
    for (let i = 0; i < n; i++) {
      addTree(cx + rand(rng, -spread, spread), cz + rand(rng, -spread, spread), rand(rng, 0.8, 1.2));
    }
  }

  // ---- shelter belts along the motorway verge ----
  for (const e of graph.edges) {
    if (e.kind !== 'motorway') continue;
    for (const s of e.segs) {
      const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      const steps = Math.floor(len / 15);
      for (let k = 0; k < steps; k++) {
        if (rng() < 0.45) continue;
        const t = (k + 0.5) / steps;
        const px = lerp(s.a.x, s.b.x, t), pz = lerp(s.a.z, s.b.z, t);
        const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len;
        const side = rng() < 0.5 ? 1 : -1;
        const off = e.width * 0.5 + rand(rng, 7, 26);
        addTree(px - dz * off * side, pz + dx * off * side, rand(rng, 0.85, 1.15));
      }
    }
  }

  ctx.treeStats = { placed, collided };
}
