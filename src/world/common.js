// Terrain, surfaces and scenery shared by every map.
//
// A map generator's job is to lay out a road graph and decide where buildings
// go. Everything downstream of that -- the ground plane, the road ribbons, the
// grip surface grid, trees and fields -- is identical whichever map you are
// playing, and lives here.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { ROAD_KIND } from './roadgraph.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { rand, randInt, lerp, TAU } from '../util/math.js';

export const WORLD_HALF = 1000;

/** Surface classification, matching SURFACE_TYRES in physics/vehicle.js. */
export const SURF_GRASS = 0, SURF_ROAD = 1, SURF_PAVED = 2;
export const CELL = 4;                                  // metres per surface cell
export const GRID_N = Math.ceil((WORLD_HALF * 2) / CELL);

export const PALETTE = {
  grass: 0x3f4a35,
  field: 0x51573a,
  // Pavement has to read as clearly lighter than the carriageway, or from any
  // distance the whole town is one flat grey and you cannot see the road.
  pavement: 0x53565c,
  kerb: 0x6d7178,
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
      const steps = Math.max(1, Math.ceil(s.len / (CELL * 0.75)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(s.a.x, s.b.x, t), lerp(s.a.z, s.b.z, t), half, SURF_ROAD);
      }
    }
  }
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

  for (const e of graph.edges) {
    const def = ROAD_KIND[e.kind];
    road.addRibbon(e.points, e.width, 0.03, def.colour);
    // Kerb lines pick out the edge of the carriageway without needing a step
    // in the collision geometry, which would make the whole town bumpy.
    if (!e.turningHead) {
      road.addRibbon(e.points, 0.5, 0.035, PALETTE.kerb, e.width * 0.5 - 0.25);
      road.addRibbon(e.points, 0.5, 0.035, PALETTE.kerb, -(e.width * 0.5 - 0.25));
    }

    if (e.kind === 'motorway') {
      paint.addRibbon(e.points, 0.9, 0.04, PALETTE.markingWarm);
      for (const off of [e.width / 6, -e.width / 6]) {
        paint.addDashedRibbon(e.points, 0.28, 0.04, PALETTE.marking, 6, 9, off);
      }
    } else if (e.kind === 'avenue') {
      paint.addDashedRibbon(e.points, 0.30, 0.04, PALETTE.marking, 4, 6, 0);
    } else if (e.kind === 'street' && e.length > 40) {
      paint.addDashedRibbon(e.points, 0.22, 0.04, PALETTE.marking, 2.5, 5.5, 0);
    } else if (e.kind === 'country') {
      paint.addDashedRibbon(e.points, 0.24, 0.04, PALETTE.marking, 3, 7, 0);
    }
  }

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
