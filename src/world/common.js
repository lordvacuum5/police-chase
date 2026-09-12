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
  planJunctions, buildJunctionCorners, buildStopLines, sliceLine, addNodeApron,
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

/**
 * A ribbon that only appears where the ground is actually paved.
 *
 * Drawing a footway as a plain ribbon beside its own road is wrong in a way
 * that is hard to see and easy to get wrong repeatedly. The band reaches six
 * or seven metres past its kerb, so it lies across any other carriageway that
 * passes within that distance -- and since the footway now stands *above* the
 * road, it hides it. Trimming at junction nodes only fixes the cases where the
 * two roads actually meet; it does nothing for a bend, or for two estate roads
 * that run close by each other without ever crossing.
 *
 * The surface grid already knows exactly where pavement is, because the
 * carriageways were burned into it afterwards. So rather than reasoning about
 * which roads might be near which, the ribbon is walked in short pieces and
 * each piece is fitted to the grid: the widest run across the band that the
 * grid calls footway. A piece next to a crossing road narrows rather than
 * disappearing, which reads as a footway pinching in past a side turning
 * instead of the row of teeth that dropping whole pieces leaves. The kerb
 * stays a smooth curve along its length, and what is drawn raised is what the
 * height field calls raised -- the two cannot disagree, because they are
 * reading the same array.
 */
export function addPavedRibbon(builder, points, width, y, colour, offset, paved, step = 2.2) {
  if (points.length < 2) return builder;
  const LAT = 4;                       // lateral samples across the band
  const slab = width / LAT;
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 1e-6) continue;
    const dx = (b.x - a.x) / segLen, dz = (b.z - a.z) / segLen;
    const nx = -dz, nz = dx;
    let t = 0;
    while (t < segLen) {
      const piece = Math.min(step - carry, segLen - t);
      const t0 = t, t1 = t + piece;
      t = t1;
      carry += piece;
      if (carry >= step - 1e-6) carry = 0;
      if (piece <= 0.12) continue;

      const mid = (t0 + t1) * 0.5;
      const bx = a.x + dx * mid, bz = a.z + dz * mid;

      // The longest unbroken run of footway across the band. Sampling the
      // middle alone would throw the whole piece away for a road that only
      // clips the inner edge of it.
      let bestFrom = -1, bestTo = -1, from = -1;
      for (let k = 0; k <= LAT; k++) {
        const u = offset - width * 0.5 + slab * k;
        const ok = paved(bx + nx * u, bz + nz * u);
        if (ok && from < 0) from = k;
        if (!ok || k === LAT) {
          const to = ok ? k : k - 1;
          if (from >= 0 && to - from > bestTo - bestFrom) { bestFrom = from; bestTo = to; }
          if (!ok) from = -1;
        }
      }
      if (bestFrom < 0) continue;

      // Half a slab of slack each end, so neighbouring pieces still meet.
      const lo = Math.max(offset - width * 0.5,
        offset - width * 0.5 + slab * (bestFrom - 0.5));
      const hi = Math.min(offset + width * 0.5,
        offset - width * 0.5 + slab * (bestTo + 0.5));
      if (hi - lo < 0.35) continue;
      builder.addRibbon(
        [{ x: a.x + dx * t0, z: a.z + dz * t0 }, { x: a.x + dx * t1, z: a.z + dz * t1 }],
        hi - lo, y, colour, (lo + hi) * 0.5,
      );
    }
  }
  return builder;
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

  // One big static box under everything gives the wheels something to hit.
  addStaticBox(ctx.sim.world, 0, -2, 0, WORLD_HALF * 1.2, 2, WORLD_HALF * 1.2, GROUP.TERRAIN);
  return mesh;
}

// ------------------------------------------------------------------- roads

export function buildRoadMeshes(ctx) {
  const { graph } = ctx;
  const road = new MeshBuilder();
  const paint = new MeshBuilder();

  // Worked out in graph.finalise(): how far back from each node the markings
  // have to stop, and which junctions are worth signalising.
  const junctions = graph.junctionPlan || planJunctions(graph);

  for (const e of graph.edges) {
    const def = ROAD_KIND[e.kind];
    // The carriageway itself still runs the full length: overlapping tarmac at
    // a junction is invisible, and stopping it short would leave holes.
    road.addRibbon(e.points, e.width, 0.03, def.colour);

    // Everything drawn on top of the tarmac stops at the junction mouth.
    const inner = sliceLine(e.points, e.trimA || 0, e.length - (e.trimB || 0));
    if (!inner) continue;

    // The kerb: a face standing up out of the carriageway, with the flat top
    // of the stone along it. The footway behind is drawn at KERB_H to match,
    // and the height field the suspension reads has its step in the same
    // place, so what you can see and what you can feel are the same edge.
    if (!e.turningHead) {
      for (const side of [1, -1]) {
        const off = (e.width * 0.5 - 0.10) * side;
        road.addWall(inner, 0.03, KERB_H, PALETTE.kerbFace, off);
        road.addRibbon(inner, 0.45, KERB_H + 0.002, PALETTE.kerb, off + 0.22 * side);
      }
    }

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
  // Just under the ribbons, so it only ever shows where they do not reach.
  for (const n of graph.nodes) {
    const live = n.edges.map((id) => graph.edges[id]).filter((e) => e && !e.dead);
    if (live.length < 2) continue;
    let r = 0, widest = live[0];
    for (const e of live) {
      r = Math.max(r, e.width * 0.5);
      if (e.width > widest.width) widest = e;
    }
    addNodeApron(road, n.x, n.z, r, 0.029, ROAD_KIND[widest.kind].colour);
  }

  buildJunctionCorners(junctions, road, 0.03, PALETTE.kerb);
  buildStopLines(junctions, paint, 0.042, PALETTE.marking);

  const m1 = new THREE.Mesh(road.build(), vertexColorMaterial());
  m1.name = 'roads';
  m1.receiveShadow = true;
  const m2 = new THREE.Mesh(paint.build(), vertexColorMaterial());
  m2.name = 'markings';
  return [m1, m2];
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
