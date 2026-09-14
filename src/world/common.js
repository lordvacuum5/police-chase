// Terrain, surfaces and scenery shared by every map.
//
// A map generator's job is to lay out a road graph and decide where buildings
// go. Everything downstream of that -- the ground plane, the road ribbons, the
// grip surface grid, trees and fields -- is identical whichever map you are
// playing, and lives here.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { ROAD_KIND } from './roadgraph.js';
import {
  planJunctions, buildJunctionCorners, buildStopLines, sliceLine, approachesAt, addNodeWedges,
} from './junctions.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { rand, randInt, lerp, TAU } from '../util/math.js';

export const WORLD_HALF = 1000;

/** Surface classification, matching SURFACE_TYRES in physics/vehicle.js. */
export const SURF_GRASS = 0, SURF_ROAD = 1, SURF_PAVED = 2;

/**
 * Metres per surface cell.
 *
 * This used to be 4, which was ample when the grid only decided how much grip
 * a tyre had -- being a couple of metres out about where grass becomes tarmac
 * is not something you can feel. It now also carries the *height* of the
 * footway, and a kerb two metres from where it is drawn is very much something
 * you can feel, so the grid is metre-resolution. It costs about 300 ms of map
 * build and 4 MB, both of which are worth an edge that lines up with the one
 * you can see.
 */
export const CELL = 1;
export const GRID_N = Math.ceil((WORLD_HALF * 2) / CELL);

/**
 * How far the footway stands above the carriageway.
 *
 * A real kerb is 125-150 mm. It matters that this is a real number rather than
 * a token step: it is what makes clipping one at speed unsettle the car
 * instead of being a change of colour under the wheels.
 */
export const KERB_H = 0.14;

export const PALETTE = {
  grass: 0x3f4a35,
  field: 0x51573a,
  // Pavement has to read as clearly lighter than the carriageway, or from any
  // distance the whole town is one flat grey and you cannot see the road.
  pavement: 0x53565c,
  kerb: 0x7b8087,
  // The vertical face of the kerb, in shadow under the footway edge.
  kerbFace: 0x3c4046,
  marking: 0xc6c9cd,
  markingWarm: 0xc8b45a,
};

// ---------------------------------------------------------------- surfaces

export function paintDisc(surface, x, z, radius, value) {
  const cx = (x + WORLD_HALF) / CELL;
  const cz = (z + WORLD_HALF) / CELL;
  const cr = radius / CELL;
  const x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(GRID_N - 1, Math.ceil(cx + cr));
  const z0 = Math.max(0, Math.floor(cz - cr)), z1 = Math.min(GRID_N - 1, Math.ceil(cz + cr));
  const r2 = cr * cr;
  for (let j = z0; j <= z1; j++) {
    for (let i = x0; i <= x1; i++) {
      const dx = i + 0.5 - cx, dz = j + 0.5 - cz;
      if (dx * dx + dz * dz <= r2) surface[j * GRID_N + i] = value;
    }
  }
}

export function paintRect(surface, x0, z0, x1, z1, value) {
  const i0 = Math.max(0, Math.floor((Math.min(x0, x1) + WORLD_HALF) / CELL));
  const i1 = Math.min(GRID_N - 1, Math.ceil((Math.max(x0, x1) + WORLD_HALF) / CELL));
  const j0 = Math.max(0, Math.floor((Math.min(z0, z1) + WORLD_HALF) / CELL));
  const j1 = Math.min(GRID_N - 1, Math.ceil((Math.max(z0, z1) + WORLD_HALF) / CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) surface[j * GRID_N + i] = value;
  }
}

/** Burn every carriageway into the grip grid. Call after the paved areas. */
export function rasteriseRoads(graph, surface) {
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
  // Junction corners are filled in past the ribbons, so the grip grid has to
  // be too -- otherwise cutting a corner drops you onto grass for a moment.
  for (const j of graph.junctionPlan || []) {
    let r = 0;
    for (const a of j.app) r = Math.max(r, a.half);
    paintDisc(surface, j.node.x, j.node.z, r * 1.45, SURF_ROAD);
  }
}

/**
 * Ground height at a point: the carriageway is the datum, the footway stands
 * KERB_H above it.
 *
 * Sampled bilinearly rather than per cell, which turns what would be a
 * vertical cliff into a ramp about a metre long. That is deliberate. A true
 * step means a wheel teleports 140 mm between one substep and the next, and
 * the suspension answers a teleport with a spike big enough to throw the car;
 * a metre of ramp is still sharp enough to jolt at speed -- 33 ms of it at
 * 30 m/s -- without asking the solver to do anything silly.
 *
 * Cheap on purpose: this is called five times per wheel per substep, which is
 * about twelve thousand times a second with a handful of cars on the road.
 */
export function makeHeightAt(surface) {
  const paved = (a, b) => (
    a < 0 || b < 0 || a >= GRID_N || b >= GRID_N
      ? 0
      : (surface[b * GRID_N + a] === SURF_PAVED ? 1 : 0)
  );
  return (x, z) => {
    const fx = (x + WORLD_HALF) / CELL - 0.5;
    const fz = (z + WORLD_HALF) / CELL - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = paved(i, j), b = paved(i + 1, j);
    const c = paved(i, j + 1), d = paved(i + 1, j + 1);
    return KERB_H * (
      (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
    );
  };
}

export function makeSurfaceAt(surface) {
  return (x, z) => {
    const cx = ((x + WORLD_HALF) / CELL) | 0;
    const cz = ((z + WORLD_HALF) / CELL) | 0;
    if (cx < 0 || cz < 0 || cx >= GRID_N || cz >= GRID_N) return SURF_GRASS;
    return surface[cz * GRID_N + cx];
  };
}

// ------------------------------------------------------------------ ground

export function buildGround(ctx) {
  const g = new THREE.PlaneGeometry(WORLD_HALF * 2.4, WORLD_HALF * 2.4, 24, 24);
  g.rotateX(-Math.PI / 2);
  // Gentle colour variation so the fields are not a flat wash.
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color(0x3f4a35);
  const alt = new THREE.Color(0x4b5239);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const n = (Math.sin(pos.getX(i) * 0.013) * Math.cos(pos.getZ(i) * 0.011) + 1) * 0.5;
    c.copy(base).lerp(alt, n);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mesh = new THREE.Mesh(g, vertexColorMaterial());
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  mesh.renderOrder = DRAW_ORDER.ground;

  // One big static box under everything gives the wheels something to hit.
  addStaticBox(ctx.sim.world, 0, -2, 0, WORLD_HALF * 1.2, 2, WORLD_HALF * 1.2, GROUP.TERRAIN);
  return mesh;
}

// ------------------------------------------------------------------- roads

/**
 * Draw order for everything flat on the ground: grass, then pavement, then
 * tarmac, then anything else.
 *
 * The footway stands KERB_H above the carriageway, and every pavement shape in
 * both maps -- a ribbon beside each road, a plate across each city block -- runs
 * under some road it is not beside: the one crossing it at a junction, the lane
 * cutting a block, the estate road that passes close by. Drawn by height alone,
 * the pavement wins and the road vanishes. Cutting the pavement to fit was
 * tried: against the metre surface grid it could only ever be as smooth as the
 * grid, and every pavement edge on the town map came out as a staircase.
 *
 * So the tarmac is drawn after the pavement and ignores its depth, which is
 * what a road painted onto the ground is anyway. The pavement shapes stay the
 * smooth ones they always were, and where road and pavement overlap the road
 * shows. The kerb faces and stones, which are what actually tell you the
 * footway is raised, are drawn afterwards like everything else.
 */
export const DRAW_ORDER = { ground: -3, pavement: -2, tarmac: -1 };

/**
 * Roads joined end to end through plain bends, as single polylines.
 *
 * A kerb drawn edge by edge ends at every node, and at a bend that is wrong on
 * both sides at once: on the inside of the bend the two kerbs carry on past
 * each other and cross in an X over the footway, and on the outside they stop
 * short of each other and leave a notch. Drawn along the whole run, the offset
 * line mitres round the bend like any other ribbon. Only edges of the same
 * width are joined, since the kerb sits at the road's half width.
 *
 * Returns [{ points, edges, trimStart, trimEnd }]: the trims are the junction
 * setbacks at the two real ends of the run.
 */
function roadChains(graph) {
  const live = (e) => e && !e.dead && !e.turningHead;
  // Unit direction an edge leaves a node in.
  const away = (e, nodeId) => {
    const p = e.points, n = p.length;
    const [q0, q1] = e.a === nodeId ? [p[0], p[1]] : [p[n - 1], p[n - 2]];
    const l = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1;
    return { x: (q1.x - q0.x) / l, z: (q1.z - q0.z) / l };
  };
  const onward = (nodeId, from) => {
    const es = graph.nodes[nodeId].edges.map((id) => graph.edges[id]).filter(live);
    if (es.length !== 2) return null;
    const o = es[0] === from ? es[1] : es[0];
    if (o === from || o.width !== from.width) return null;
    // A bend, not a hairpin. Two edges leaving a node in nearly the same
    // direction -- a road doubled back on itself, or the same stub recorded
    // twice -- would mitre into a kerb shot straight across the carriageway.
    const u = away(from, nodeId), v = away(o, nodeId);
    return u.x * v.x + u.z * v.z < 0.2 ? o : null;
  };
  const used = new Set();
  const chains = [];
  for (const e of graph.edges) {
    if (!live(e) || used.has(e)) continue;
    // Back to the start of the run...
    let first = e, start = e.a;
    const back = new Set([e]);
    for (;;) {
      const o = onward(start, first);
      if (!o || back.has(o) || used.has(o)) break;
      back.add(o);
      start = o.a === start ? o.b : o.a;
      first = o;
    }
    // ...then along it to the end.
    const points = [], edges = [], owner = [];
    let edge = first, at = start, trimStart = 0, trimEnd = 0;
    for (;;) {
      used.add(edge);
      edges.push(edge);
      const fwd = edge.a === at;
      const pts = fwd ? edge.points : edge.points.slice().reverse();
      if (edges.length === 1) trimStart = (fwd ? edge.trimA : edge.trimB) || 0;
      trimEnd = (fwd ? edge.trimB : edge.trimA) || 0;
      for (let i = points.length ? 1 : 0; i < pts.length; i++) {
        points.push(pts[i]);
        if (points.length > 1) owner.push(edges.length - 1);
      }
      at = fwd ? edge.b : edge.a;
      const o = onward(at, edge);
      if (!o || used.has(o)) break;
      edge = o;
    }
    chains.push({ points, owner, edges, trimStart, trimEnd });
  }
  return chains;
}

/**
 * Is a point on some road's carriageway other than the ones listed? Returns a
 * function over (x, z, margin, excluded edge set), backed by a bucket grid of
 * every road segment, so the question is answered from the roads' own shapes
 * rather than from the metre surface grid.
 */
function carriagewayTest(graph) {
  const B = 24;
  const buckets = new Map();
  for (const e of graph.edges) {
    if (e.dead) continue;
    const r = e.width * 0.5;
    for (const s of e.segs) {
      const i0 = Math.floor((Math.min(s.a.x, s.b.x) - r) / B), i1 = Math.floor((Math.max(s.a.x, s.b.x) + r) / B);
      const j0 = Math.floor((Math.min(s.a.z, s.b.z) - r) / B), j1 = Math.floor((Math.max(s.a.z, s.b.z) + r) / B);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = `${i},${j}`;
          let list = buckets.get(k);
          if (!list) { list = []; buckets.set(k, list); }
          list.push({ e, s });
        }
      }
    }
  }
  return (x, z, margin, not) => {
    const list = buckets.get(`${Math.floor(x / B)},${Math.floor(z / B)}`);
    if (!list) return false;
    for (const { e, s } of list) {
      if (not.has(e)) continue;
      const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.a.x) * dx + (z - s.a.z) * dz) / l2));
      const px = s.a.x + dx * t - x, pz = s.a.z + dz * t - z;
      const r = e.width * 0.5 - margin;
      if (r > 0 && px * px + pz * pz < r * r) return true;
    }
    return false;
  };
}

/**
 * The parts of a kerb line that are beside footway or verge rather than out
 * across another road's carriageway.
 *
 * A kerb runs the length of its own road, trimmed back at the junctions at
 * either end. That trim knows about the roads meeting at those two nodes and
 * nothing else, so where another road crosses mid-edge, merges at a slip road
 * or simply passes close, the kerb line carried straight on over its tarmac.
 * Walked a metre at a time, a piece is dropped if the kerb itself lies on
 * another road, or the ground just behind it does.
 */
function kerbRuns(chain, side, onRoad) {
  const { points, owner, edges } = chain;
  const half = edges[0].width * 0.5;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  const from = chain.trimStart, to = total - chain.trimEnd;
  const runs = [];
  // `pending` is how far the current run has got inside a segment. Only the
  // road's own vertices, and the points where a run starts or stops, go into
  // the line -- not a point every metre. The kerb is drawn five metres or more
  // out from these points, and on the inside of a bend any point nearer the
  // corner than that folds back past it: the kerb crossed itself in an X at
  // every sharp bend.
  let cur = null, pending = null, acc = 0;
  const not = new Set();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const s0 = acc, s1 = acc + len;
    acc = s1;
    if (len < 1e-6 || s1 <= from || s0 >= to) continue;
    // A piece may sit on its own road and on the roads either side of it in
    // the run -- that is what a kerb round a bend does -- but not on a part of
    // the same run further along, which is a road crossing itself.
    const j = owner[i];
    not.clear();
    for (const k of [j - 1, j, j + 1]) if (edges[k]) not.add(edges[k]);
    const u0 = Math.max(0, (from - s0) / len), u1 = Math.min(1, (to - s0) / len);
    const nx = -(b.z - a.z) / len * side, nz = (b.x - a.x) / len * side;
    const at = (t) => ({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
    const n = Math.max(1, Math.ceil(len * (u1 - u0)));
    for (let k = 0; k < n; k++) {
      const t0 = u0 + (u1 - u0) * (k / n), t1 = u0 + (u1 - u0) * ((k + 1) / n);
      const tm = (t0 + t1) * 0.5;
      const mx = lerp(a.x, b.x, tm), mz = lerp(a.z, b.z, tm);
      if (onRoad(mx + nx * half, mz + nz * half, 0.25, not)
        || onRoad(mx + nx * (half + 0.8), mz + nz * (half + 0.8), 0, not)) {
        if (cur && pending) cur.push(pending);
        cur = null; pending = null;
        continue;
      }
      if (!cur) { cur = [at(t0)]; runs.push(cur); }
      if (k === n - 1) { cur.push(at(t1)); pending = null; } else pending = at(t1);
    }
  }
  if (cur && pending) cur.push(pending);
  return runs.filter((r) => r.length >= 2);
}

export function buildRoadMeshes(ctx) {
  const { graph } = ctx;
  const road = new MeshBuilder();
  const kerbs = new MeshBuilder();
  const paint = new MeshBuilder();
  const onRoad = carriagewayTest(graph);

  // Worked out in graph.finalise(): how far back from each node the markings
  // have to stop, and which junctions are worth signalising.
  const junctions = graph.junctionPlan || planJunctions(graph);

  // The kerb: a face standing up out of the carriageway, with the flat top of
  // the stone along it. The footway behind is drawn at KERB_H to match, and the
  // height field the suspension reads has its step in the same place, so what
  // you can see and what you can feel are the same edge.
  for (const chain of roadChains(graph)) {
    const half = chain.edges[0].width * 0.5;
    for (const side of [1, -1]) {
      const off = (half - 0.10) * side;
      for (const run of kerbRuns(chain, side, onRoad)) {
        kerbs.addWall(run, 0.03, KERB_H, PALETTE.kerbFace, off);
        kerbs.addRibbon(run, 0.45, KERB_H + 0.002, PALETTE.kerb, off + 0.22 * side);
      }
    }
  }

  for (const e of graph.edges) {
    const def = ROAD_KIND[e.kind];
    // The carriageway itself still runs the full length: overlapping tarmac at
    // a junction is invisible, and stopping it short would leave holes.
    road.addRibbon(e.points, e.width, 0.03, def.colour);

    // Everything drawn on top of the tarmac stops at the junction mouth.
    const inner = sliceLine(e.points, e.trimA || 0, e.length - (e.trimB || 0));
    if (!inner) continue;

    if (e.kind === 'motorway') {
      paint.addRibbon(inner, 0.9, 0.04, PALETTE.markingWarm);
      for (const off of [e.width / 6, -e.width / 6]) {
        paint.addDashedRibbon(inner, 0.28, 0.04, PALETTE.marking, 6, 9, off);
      }
    } else if (e.kind === 'avenue') {
      paint.addDashedRibbon(inner, 0.30, 0.04, PALETTE.marking, 4, 6, 0);
    } else if (e.kind === 'street' && e.length > 40) {
      paint.addDashedRibbon(inner, 0.22, 0.04, PALETTE.marking, 2.5, 5.5, 0);
    } else if (e.kind === 'country') {
      paint.addDashedRibbon(inner, 0.24, 0.04, PALETTE.marking, 3, 7, 0);
    }
  }

  // Close the wedge two square ribbon ends leave at every bend and junction.
  for (const n of graph.nodes) {
    addNodeWedges(road, n, approachesAt(graph, n), (e) => e.width * 0.5, 0.029,
      (a, b) => ROAD_KIND[(a.width >= b.width ? a : b).kind].colour);
  }

  buildJunctionCorners(junctions, road, 0.03, {
    builder: kerbs, colour: PALETTE.kerb, face: PALETTE.kerbFace, height: KERB_H, onRoad,
  });
  buildStopLines(junctions, paint, 0.042, PALETTE.marking);

  // See DRAW_ORDER: over the pavement whatever its height.
  const m1 = new THREE.Mesh(road.build(), vertexColorMaterial({ depthFunc: THREE.AlwaysDepth }));
  m1.name = 'roads';
  m1.receiveShadow = true;
  m1.renderOrder = DRAW_ORDER.tarmac;
  // Markings sit a centimetre above the tarmac and the kerb stone two
  // millimetres above the footway: far too close for the depth buffer a few
  // hundred metres out, where they flickered through each other as hatching.
  // Pulled toward the camera in depth instead of lifted any higher.
  const nearer = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
  const m2 = new THREE.Mesh(paint.build(), vertexColorMaterial(nearer));
  m2.name = 'markings';
  const m3 = new THREE.Mesh(kerbs.build(), vertexColorMaterial(nearer));
  m3.name = 'kerbs';
  m3.receiveShadow = true;
  return [m1, m2, m3];
}

// ----------------------------------------------------------------- scenery

/**
 * One tree: drawn into `builder` and given a collider. Refuses to stand on a
 * road. Every tree in the game is solid -- woodland you can drive through is
 * scenery, and scenery is not what a chase needs at the side of the road.
 */
export function addTree(ctx, builder, tx, tz, scale = 1) {
  const { rng, graph, sim } = ctx;
  if (graph.overlapsRoad(tx, tz, 2.4, 2.4, 0, 2.0)) return false;

  const h = rand(rng, 6, 13) * scale;
  const trunk = 0.55 + h * 0.035;
  builder.addBox(trunk, h * 0.5, trunk, tx, h * 0.25, tz, 0x463726);
  builder.addTaperedBox(h * 0.78, h * 0.72, h * 0.78, tx, h * 0.66, tz,
    new THREE.Color().setHSL(rand(rng, 0.22, 0.30), rand(rng, 0.28, 0.46), rand(rng, 0.13, 0.22)),
    0.22, 0.22, rand(rng, 0, TAU));
  addStaticBox(sim.world, tx, 2.6, tz, 0.65, 2.6, 0.65, GROUP.PROP);
  return true;
}

/**
 * Copses scattered across open ground. `keepOut(x, z)` returns true for places
 * the map wants left clear -- typically the built-up area.
 */
export function scatterTrees(ctx, builder, opts = {}) {
  const { rng } = ctx;
  const {
    copses = 150, keepOut = () => false,
    minR = 0, maxR = WORLD_HALF - 70,
    spreadMin = 14, spreadMax = 46,
    perCopseMin = 5, perCopseMax = 16,
  } = opts;

  let placed = 0;
  for (let c = 0; c < copses; c++) {
    const a = rng() * TAU;
    const r = rand(rng, minR, maxR);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) continue;
    if (keepOut(cx, cz)) continue;

    const n = randInt(rng, perCopseMin, perCopseMax);
    const spread = rand(rng, spreadMin, spreadMax);
    for (let i = 0; i < n; i++) {
      if (addTree(ctx, builder,
        cx + rand(rng, -spread, spread), cz + rand(rng, -spread, spread),
        rand(rng, 0.8, 1.2))) placed++;
    }
  }
  return placed;
}

/** Shelter belts and hedgerow trees along roads of the given kinds. */
export function treesAlongRoads(ctx, builder, kinds, opts = {}) {
  const { rng, graph } = ctx;
  const { spacing = 15, skip = 0.45, offMin = 7, offMax = 26 } = opts;
  let placed = 0;

  for (const e of graph.edges) {
    if (!kinds.includes(e.kind)) continue;
    for (const s of e.segs) {
      const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      const steps = Math.floor(len / spacing);
      for (let k = 0; k < steps; k++) {
        if (rng() < skip) continue;
        const t = (k + 0.5) / steps;
        const px = lerp(s.a.x, s.b.x, t), pz = lerp(s.a.z, s.b.z, t);
        const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len;
        const side = rng() < 0.5 ? 1 : -1;
        const off = e.width * 0.5 + rand(rng, offMin, offMax);
        if (addTree(ctx, builder, px - dz * off * side, pz + dx * off * side,
          rand(rng, 0.85, 1.15))) placed++;
      }
    }
  }
  return placed;
}

/** Flat field patches, drawn just above the ground plane. */
export function buildFieldPatches(ctx, builder, opts = {}) {
  const { rng } = ctx;
  const { count = 90, minR = 0, maxR = WORLD_HALF - 40, keepOut = () => false } = opts;

  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const r = rand(rng, minR, maxR);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    if (Math.abs(cx) > WORLD_HALF - 60 || Math.abs(cz) > WORLD_HALF - 60) continue;
    if (keepOut(cx, cz)) continue;

    const w = rand(rng, 70, 190), d = rand(rng, 70, 190);
    const rot = rand(rng, 0, TAU);
    const c = new THREE.Color().setHSL(
      rand(rng, 0.16, 0.27), rand(rng, 0.16, 0.3), rand(rng, 0.20, 0.31),
    );
    const ca = Math.cos(rot), sa = Math.sin(rot);
    const corner = (sx, sz) => ({
      x: cx + sx * w * 0.5 * ca - sz * d * 0.5 * sa,
      z: cz + sx * w * 0.5 * sa + sz * d * 0.5 * ca,
    });
    const p0 = corner(-1, -1), p1 = corner(1, -1), p2 = corner(1, 1), p3 = corner(-1, 1);
    // Stagger the height slightly per patch. Field patches overlap, and
    // coplanar overlapping quads z-fight into stripes at any distance.
    const y = 0.008 + (i % 24) * 0.0007;
    builder.addQuadY(p0.x, p0.z, p1.x, p1.z, p2.x, p2.z, p3.x, p3.z, y, c);
  }
}

export { MeshBuilder, vertexColorMaterial, addStaticBox, GROUP };
