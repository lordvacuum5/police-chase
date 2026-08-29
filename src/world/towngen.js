// Wexbury -- a market town that grew rather than being planned.
//
// The city map is a grid, which makes every chase geometrically similar: right
// angles, equal blocks, predictable escape routes. This one is deliberately the
// opposite. It is built the way an English town actually accreted:
//
//   * a medieval core of short crooked lanes around a market square,
//   * concentric ring lanes at whatever radius the town happened to stop at,
//     joined by only some of the possible radial links,
//   * long A-roads striking out to other towns, curving as they go,
//   * post-war estates of crescents and cul-de-sacs hung off those A-roads,
//   * a dual carriageway bypass round one side, joined by roundabouts rather
//     than slip roads, because that is how a bypass joins a town here,
//   * and B-roads wandering off between hedgerows to a village.
//
// Nothing meets at right angles unless it happens to. Buildings are placed
// along road frontages rather than inside blocks, which is what gives terraced
// streets and makes the lanes feel enclosed.

import * as THREE from 'three';
import { RoadGraph, ROAD_KIND } from './roadgraph.js';
import { addNodeApron } from './junctions.js';
import { GROUP, addStaticBox } from '../physics/world.js';
import { makeRng, rand, randInt, clamp, lerp, dist2, TAU } from '../util/math.js';
import {
  WORLD_HALF, CELL, GRID_N, SURF_GRASS, SURF_ROAD, SURF_PAVED, PALETTE,
  paintDisc, rasteriseRoads, makeSurfaceAt, buildGround, buildRoadMeshes,
  scatterTrees, treesAlongRoads, buildFieldPatches, addTree,
  MeshBuilder, vertexColorMaterial,
} from './common.js';

const CORE = 70;            // market square ring
const RINGS = [70, 152, 248, 352];
const RING_NODES = [8, 12, 16, 20];
const BYPASS_R = 610;
const TOWN_EDGE = 430;      // beyond this it is estates, then countryside

export function buildTown(sim, scene, seed = 6180339) {
  const rng = makeRng(seed);
  const graph = new RoadGraph(48);
  const surface = new Uint8Array(GRID_N * GRID_N);

  const ctx = { sim, scene, rng, graph, surface };

  const rings = buildRings(ctx);
  const radials = buildRadials(ctx, rings);
  const bypass = buildBypass(ctx, radials);
  buildEstates(ctx, radials);
  buildLanes(ctx, radials);

  // Round off every dead end before the network is frozen.
  graph.addTurningHeads(15, 10, WORLD_HALF);
  graph.finalise();
  nameTownRoads(graph);

  // --- surfaces ------------------------------------------------------
  // Pavements hug the roads rather than filling blocks: an organic town has
  // no blocks to fill.
  for (const e of graph.edges) {
    if (e.kind === 'country' || e.kind === 'lane' || e.turningHead) continue;
    for (const s of e.segs) {
      const steps = Math.max(1, Math.ceil(s.len / (CELL * 0.9)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        paintDisc(surface, lerp(s.a.x, s.b.x, t), lerp(s.a.z, s.b.z, t),
          e.width * 0.5 + 7, SURF_PAVED);
      }
    }
  }
  paintDisc(surface, 0, 0, CORE * 0.72, SURF_PAVED);      // the market square
  rasteriseRoads(graph, surface);

  // --- visuals -------------------------------------------------------
  const meshes = [];
  meshes.push(buildGround(ctx));
  meshes.push(buildPavements(ctx));
  meshes.push(...buildRoadMeshes(ctx));
  meshes.push(...buildFrontages(ctx));
  meshes.push(...buildTownCountryside(ctx));
  for (const m of meshes) if (m) scene.add(m);

  return {
    graph,
    surfaceAt: makeSurfaceAt(surface),
    meshes,
    bounds: WORLD_HALF,
    bypass,
  };
}

// =====================================================================
//  Street network
// =====================================================================

/**
 * Concentric ring lanes with jittered nodes, joined radially but only in
 * places. The gaps are the point: a full spiderweb is as predictable as a
 * grid, whereas missing links force real detours.
 */
function buildRings(ctx) {
  const { graph, rng } = ctx;
  const rings = [];

  for (let r = 0; r < RINGS.length; r++) {
    const count = RING_NODES[r];
    const nodes = [];
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + rand(rng, -0.10, 0.10);
      const rad = RINGS[r] + rand(rng, -22, 22);
      nodes.push(graph.addNode(Math.cos(a) * rad, Math.sin(a) * rad, 'cross'));
    }
    // Close the ring. The innermost is a narrow lane; the rest are streets.
    const kind = r === 0 ? 'lane' : 'street';
    for (let k = 0; k < count; k++) {
      const a = nodes[k], b = nodes[(k + 1) % count];
      // Bow each link outward so the ring reads as a curve, not a polygon.
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      const ml = Math.hypot(mx, mz) || 1;
      const bulge = RINGS[r] * 0.035;
      graph.addEdge(a, b, kind, [{ x: mx + (mx / ml) * bulge, z: mz + (mz / ml) * bulge }]);
    }
    rings.push(nodes);
  }

  // Radial links between consecutive rings -- about two thirds of them.
  for (let r = 0; r < rings.length - 1; r++) {
    for (const n of rings[r]) {
      if (rng() < 0.34) continue;
      let best = rings[r + 1][0], bd = Infinity;
      for (const m of rings[r + 1]) {
        const d = dist2(n.x, n.z, m.x, m.z);
        if (d < bd) { bd = d; best = m; }
      }
      graph.addEdge(n, best, r === 0 ? 'lane' : 'street');
    }
  }

  // The High Street: straight through the middle, wider than everything else.
  const hs = rng() * TAU;
  const findOn = (ring, ang) => {
    let best = ring[0], bd = Infinity;
    for (const n of ring) {
      const d = Math.abs(Math.atan2(Math.sin(Math.atan2(n.z, n.x) - ang),
        Math.cos(Math.atan2(n.z, n.x) - ang)));
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const a1 = findOn(rings[2], hs), a2 = findOn(rings[2], hs + Math.PI);
  graph.addEdge(a1, a2, 'avenue', [{ x: rand(ctx.rng, -18, 18), z: rand(ctx.rng, -18, 18) }]);

  return rings;
}

/** Long A-roads striking out from the town to the map edge, curving as they go. */
function buildRadials(ctx, rings) {
  const { graph, rng } = ctx;
  const outerRing = rings[rings.length - 1];
  const radials = [];
  const COUNT = 6;

  for (let i = 0; i < COUNT; i++) {
    const ang = (i / COUNT) * TAU + rand(rng, -0.30, 0.30);

    // Start at whichever outer-ring node faces this way.
    let start = outerRing[0], bd = Infinity;
    for (const n of outerRing) {
      const na = Math.atan2(n.z, n.x);
      const d = Math.abs(Math.atan2(Math.sin(na - ang), Math.cos(na - ang)));
      if (d < bd) { bd = d; start = n; }
    }

    // Walk outward, wandering either side of the bearing.
    let prev = start;
    let bearing = ang;
    const chain = [start];
    for (let r = 470; r < 960; r += rand(rng, 120, 170)) {
      bearing += rand(rng, -0.20, 0.20);
      const n = graph.addNode(Math.cos(bearing) * r, Math.sin(bearing) * r, 'cross');
      if (Math.abs(n.x) > WORLD_HALF - 45 || Math.abs(n.z) > WORLD_HALF - 45) break;
      // A control point off the chord gives the road a real bend.
      const mx = (prev.x + n.x) * 0.5, mz = (prev.z + n.z) * 0.5;
      const dx = n.x - prev.x, dz = n.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      const bow = rand(rng, -34, 34);
      graph.addEdge(prev, n, 'avenue',
        [{ x: mx + (-dz / dl) * bow, z: mz + (dx / dl) * bow }]);
      chain.push(n);
      prev = n;
    }
    radials.push({ angle: ang, chain });
  }
  return radials;
}

/**
 * The bypass: a dual carriageway sweeping round one side of the town, meeting
 * each A-road it crosses at a roundabout. No slip roads -- a British bypass
 * joins the local network at a roundabout, and that makes it a very different
 * tactical space from the city's motorway.
 */
function buildBypass(ctx, radials) {
  const { graph, rng } = ctx;

  // Which A-roads does it serve? A contiguous run of them, not all.
  const sorted = radials.slice().sort((a, b) => a.angle - b.angle);
  const first = randInt(rng, 0, sorted.length - 1);
  const served = [];
  for (let k = 0; k < 4; k++) served.push(sorted[(first + k) % sorted.length]);

  // A junction node sits on each served A-road, at bypass radius.
  const junctions = [];
  for (const rad of served) {
    // Split the A-road: find the chain link that straddles BYPASS_R.
    let idx = -1;
    for (let i = 0; i < rad.chain.length - 1; i++) {
      const r0 = Math.hypot(rad.chain[i].x, rad.chain[i].z);
      const r1 = Math.hypot(rad.chain[i + 1].x, rad.chain[i + 1].z);
      if (r0 <= BYPASS_R && r1 >= BYPASS_R) { idx = i; break; }
    }
    if (idx < 0) continue;

    const a = rad.chain[idx], b = rad.chain[idx + 1];
    const r0 = Math.hypot(a.x, a.z), r1 = Math.hypot(b.x, b.z);
    const t = clamp((BYPASS_R - r0) / Math.max(1, r1 - r0), 0.15, 0.85);
    const jx = lerp(a.x, b.x, t), jz = lerp(a.z, b.z, t);

    const j = graph.addNode(jx, jz, 'cross');
    // Rewire the A-road through the junction.
    for (const eid of a.edges.slice()) {
      const e = graph.edges[eid];
      if ((e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)) e.dead = true;
    }
    graph.reindexEdges();
    graph.addEdge(a, j, 'avenue');
    graph.addEdge(j, b, 'avenue');
    junctions.push({ node: j, angle: Math.atan2(jz, jx) });
  }

  if (junctions.length < 2) return null;
  junctions.sort((p, q) => p.angle - q.angle);

  // Link consecutive junctions with a curved dual carriageway.
  for (let i = 0; i < junctions.length - 1; i++) {
    const a = junctions[i].node, b = junctions[i + 1].node;
    const mids = [];
    const steps = 4;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const ang = lerp(junctions[i].angle, junctions[i + 1].angle, t);
      const rr = BYPASS_R + rand(rng, -18, 18);
      mids.push({ x: Math.cos(ang) * rr, z: Math.sin(ang) * rr });
    }
    graph.addEdge(a, b, 'dual', mids);
  }

  // Roundabouts at every bypass junction, which is what makes it feel British.
  const circles = [];
  for (const j of junctions) {
    const c = graph.convertToRoundabout(j.node, 30, 8, 'street');
    if (c) circles.push(c);
  }
  return { junctions: circles };
}

/**
 * Post-war estates: crescents and cul-de-sacs hung off the A-roads. Loops that
 * rejoin, and dead ends that do not -- both of which punish a wrong turn.
 */
function buildEstates(ctx, radials) {
  const { graph, rng } = ctx;

  for (const rad of radials) {
    for (let k = 0; k < 3; k++) {
      const host = rad.chain[randInt(rng, 0, Math.min(2, rad.chain.length - 1))];
      if (!host) continue;
      const hr = Math.hypot(host.x, host.z);
      if (hr < TOWN_EDGE - 90 || hr > 760) continue;

      const side = rng() < 0.5 ? 1 : -1;
      const baseAng = Math.atan2(host.z, host.x) + side * rand(rng, 0.35, 0.75);
      const cx = Math.cos(baseAng) * (hr + rand(rng, -50, 50));
      const cz = Math.sin(baseAng) * (hr + rand(rng, -50, 50));
      if (Math.abs(cx) > WORLD_HALF - 90 || Math.abs(cz) > WORLD_HALF - 90) continue;

      if (rng() < 0.55) {
        // A crescent: an arc that leaves the road and comes back to it.
        const R = rand(rng, 55, 95);
        const a0 = rand(rng, 0, TAU);
        const arcNodes = [];
        for (let s = 0; s <= 5; s++) {
          const a = a0 + (s / 5) * rand(rng, 2.0, 3.0);
          arcNodes.push(graph.addNode(cx + Math.cos(a) * R, cz + Math.sin(a) * R, 'cross'));
        }
        graph.addEdge(host, arcNodes[0], 'street');
        for (let s = 0; s < arcNodes.length - 1; s++) {
          graph.addEdge(arcNodes[s], arcNodes[s + 1], 'street');
        }
        graph.addEdge(arcNodes[arcNodes.length - 1], host, 'street');
      } else {
        // A cul-de-sac: a stub with a turning head and nothing beyond it.
        let prev = host;
        const legs = randInt(rng, 2, 3);
        let ang = baseAng;
        for (let s = 0; s < legs; s++) {
          ang += rand(rng, -0.5, 0.5);
          const len = rand(rng, 45, 80);
          const n = graph.addNode(prev.x + Math.cos(ang) * len, prev.z + Math.sin(ang) * len, 'cross');
          if (Math.abs(n.x) > WORLD_HALF - 70 || Math.abs(n.z) > WORLD_HALF - 70) break;
          graph.addEdge(prev, n, 'lane');
          prev = n;
        }
      }
    }
  }
}

/** B-roads wandering between hedgerows, plus a village out in the fields. */
function buildLanes(ctx, radials) {
  const { graph, rng } = ctx;

  // Link the far ends of neighbouring A-roads, so the countryside is a network
  // and not a set of spokes you have to come back down.
  const ends = radials.map((r) => r.chain[r.chain.length - 1]).filter(Boolean);
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i], b = ends[(i + 1) % ends.length];
    if (!a || !b || a === b) continue;
    const mids = [];
    for (let s = 1; s <= 2; s++) {
      const t = s / 3;
      const mx = lerp(a.x, b.x, t), mz = lerp(a.z, b.z, t);
      const ml = Math.hypot(mx, mz) || 1;
      const pull = rand(rng, -0.22, 0.10);
      mids.push({ x: mx * (1 + pull), z: mz * (1 + pull) });
    }
    graph.addEdge(a, b, 'country', mids);
  }

  // A village: a short knot of lanes off one of the country roads.
  const host = ends[randInt(rng, 0, ends.length - 1)];
  if (host) {
    let prev = host;
    const ring = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + rand(rng, -0.2, 0.2);
      const R = rand(rng, 45, 75);
      const n = graph.addNode(host.x + Math.cos(a) * R, host.z + Math.sin(a) * R, 'lane');
      if (Math.abs(n.x) > WORLD_HALF - 60 || Math.abs(n.z) > WORLD_HALF - 60) continue;
      ring.push(n);
    }
    for (let k = 0; k < ring.length; k++) {
      graph.addEdge(ring[k], ring[(k + 1) % ring.length], 'lane');
    }
    if (ring.length) graph.addEdge(host, ring[0], 'lane');
  }
}

// =====================================================================
//  Naming
// =====================================================================

const CORE_NAMES = ['Market Place', 'Church Lane', 'Bridge Street', 'The Shambles',
  'Priory Row', 'Corn Street', 'Butcher Row', 'Friar Lane'];
const STREET_NAMES = ['Mill Road', 'Station Road', 'Victoria Street', 'Albion Road',
  'Chapel Street', 'Elm Grove', 'Queens Road', 'Sackville Street', 'Beech Avenue',
  'Northgate', 'Southgate', 'Westbourne Road', 'Cranleigh Way', 'Abbots Walk',
  'Kingsmead', 'Fairfield Road', 'Orchard Rise', 'The Chase'];
const ESTATE_NAMES = ['The Crescent', 'Willow Close', 'Hazel Court', 'Meadow Rise',
  'Foxglove Close', 'Larkspur Way', 'Copse End', 'Saxon Close'];
const A_ROADS = ['A417', 'A429', 'A361', 'A44', 'A433', 'A438'];
const B_ROADS = ['Fosse Way', 'Barrow Lane', 'Coldharbour Lane', 'Mill Track',
  'Stannard Lane', 'Long Furlong'];

function nameTownRoads(graph) {
  let core = 0, street = 0, estate = 0, a = 0, b = 0;
  for (const e of graph.edges) {
    const midR = Math.hypot(
      (graph.nodes[e.a].x + graph.nodes[e.b].x) * 0.5,
      (graph.nodes[e.a].z + graph.nodes[e.b].z) * 0.5,
    );
    if (e.kind === 'dual') { e.name = 'the Wexbury bypass'; continue; }
    if (e.kind === 'avenue') {
      e.name = midR < 260 ? 'the High Street' : A_ROADS[(a++) % A_ROADS.length];
      continue;
    }
    if (e.kind === 'country') { e.name = B_ROADS[(b++) % B_ROADS.length]; continue; }
    if (e.kind === 'lane') {
      e.name = midR < CORE + 60
        ? CORE_NAMES[(core++) % CORE_NAMES.length]
        : ESTATE_NAMES[(estate++) % ESTATE_NAMES.length];
      continue;
    }
    e.name = midR < 190
      ? CORE_NAMES[(core++) % CORE_NAMES.length]
      : STREET_NAMES[(street++) % STREET_NAMES.length];
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

/**
 * Pavements, drawn as a wider ribbon beneath each carriageway.
 *
 * An organic town has no blocks to fill, so the paving follows the road. It
 * also has to be drawn, not just written into the grip grid -- otherwise the
 * houses appear to stand in a field.
 */
function buildPavements(ctx) {
  const { graph } = ctx;
  const b = new MeshBuilder();
  // Turning heads are left as plain tarmac. A pavement ribbon per edge round
  // a tight ring throws out a petal at every segment and the head reads as a
  // flower rather than a bulb.
  const paved = (e) => e && !e.dead && e.kind !== 'country' && !e.turningHead;
  const widthOf = (e) => e.width + (e.kind === 'dual' ? 8 : e.kind === 'lane' ? 9 : 13);

  for (const e of graph.edges) {
    if (!paved(e)) continue;
    b.addRibbon(e.points, widthOf(e), 0.02, PALETTE.pavement);
  }
  // The ribbons end square at every node, so a bend leaves a notch of grass
  // cut into the footway. Same fix as the carriageway gets.
  for (const n of graph.nodes) {
    const live = n.edges.map((id) => graph.edges[id]).filter(paved);
    if (live.length < 2) continue;
    let r = 0;
    for (const e of live) r = Math.max(r, widthOf(e) * 0.5);
    addNodeApron(b, n.x, n.z, r, 0.019, PALETTE.pavement);
  }
  const mesh = new THREE.Mesh(b.build(), vertexColorMaterial());
  mesh.name = 'pavements';
  mesh.receiveShadow = true;
  return mesh;
}

// =====================================================================
//  Buildings, placed along road frontages
// =====================================================================

/** Coarse spatial hash of what has already been built, for overlap rejection. */
class Placed {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); }
  key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x, z, r) {
    const c = Math.ceil(r / this.cell) + 1;
    const ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell);
    for (let i = ix - c; i <= ix + c; i++) {
      for (let j = iz - c; j <= iz + c; j++) {
        const list = this.map.get(`${i},${j}`);
        if (!list) continue;
        for (const p of list) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) return false;
        }
      }
    }
    return true;
  }
  add(x, z, r) {
    const k = this.key(x, z);
    let list = this.map.get(k);
    if (!list) { list = []; this.map.set(k, list); }
    list.push({ x, z, r });
  }
}

/**
 * Walk every road and line it with buildings.
 *
 * This is what makes the town read as a town rather than a grid of blocks:
 * shops crowd the pavement in the centre, terraces run in unbroken rows along
 * the Victorian streets, and detached houses sit back behind gardens further
 * out. Density and setback both fall away with distance from the market square.
 */
function buildFrontages(ctx) {
  const { graph, rng, sim } = ctx;
  const builders = [new MeshBuilder(), new MeshBuilder(), new MeshBuilder(), new MeshBuilder()];
  const placed = new Placed();
  let count = 0;

  for (const e of graph.edges) {
    if (e.kind === 'dual' || e.kind === 'country') continue;

    for (const s of e.segs) {
      const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      if (len < 12) continue;
      const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len;
      const nx = -dz, nz = dx;

      for (const side of [1, -1]) {
        let along = rand(rng, 3, 12);
        while (along < len - 6) {
          const px = s.a.x + dx * along, pz = s.a.z + dz * along;
          const r = Math.hypot(px, pz);

          // District: centre / inner streets / estates / edge of town.
          let w, d, h, setback, gap, colour, roofDark;
          if (r < 150) {
            w = rand(rng, 7, 12); d = rand(rng, 10, 16); h = rand(rng, 8, 13);
            // Enough setback for a pavement. Terraces right on the kerb look
            // authentic and drive like a bobsleigh run.
            setback = e.width * 0.5 + rand(rng, 5.5, 8); gap = rand(rng, 0.4, 1.6);
            colour = new THREE.Color().setHSL(rand(rng, 0.05, 0.10), rand(rng, 0.18, 0.34), rand(rng, 0.30, 0.44));
            roofDark = 0x2c2622;
          } else if (r < 330) {
            w = rand(rng, 6.5, 9.5); d = rand(rng, 9, 13); h = rand(rng, 6.5, 8.5);
            setback = e.width * 0.5 + rand(rng, 7, 11); gap = rand(rng, 0.3, 2.2);
            colour = new THREE.Color().setHSL(rand(rng, 0.03, 0.07), rand(rng, 0.22, 0.40), rand(rng, 0.26, 0.38));
            roofDark = 0x30292a;
          } else if (r < 700) {
            w = rand(rng, 9, 14); d = rand(rng, 9, 13); h = rand(rng, 5.5, 7.5);
            setback = e.width * 0.5 + rand(rng, 9, 15); gap = rand(rng, 5, 13);
            colour = new THREE.Color().setHSL(rand(rng, 0.06, 0.12), rand(rng, 0.10, 0.24), rand(rng, 0.38, 0.55));
            roofDark = 0x3a3330;
          } else {
            // Farms and barns, sparse.
            if (rng() < 0.72) { along += rand(rng, 30, 70); continue; }
            w = rand(rng, 12, 22); d = rand(rng, 10, 18); h = rand(rng, 5, 9);
            setback = e.width * 0.5 + rand(rng, 14, 26); gap = rand(rng, 40, 90);
            colour = new THREE.Color().setHSL(rand(rng, 0.07, 0.11), rand(rng, 0.10, 0.20), rand(rng, 0.32, 0.44));
            roofDark = 0x33302b;
          }

          const bx = px + nx * side * (setback + d * 0.5);
          const bz = pz + nz * side * (setback + d * 0.5);
          const radius = Math.hypot(w, d) * 0.5;

          if (Math.abs(bx) > WORLD_HALF - 30 || Math.abs(bz) > WORLD_HALF - 30) { along += w + gap; continue; }
          if (!placed.free(bx, bz, radius * 0.72)
              || graph.overlapsRoad(bx, bz, w, d, Math.atan2(dx, dz), 3.5)) {
            along += w + gap;
            continue;
          }

          const q = (bx >= 0 ? 1 : 0) + (bz >= 0 ? 2 : 0);
          const b = builders[q];

          // Rotate so the house's local +Z is its *depth*, pointing away from
          // the street, and local +X is its frontage along the street. Using
          // the road tangent instead put +Z along the road, which turned every
          // house through ninety degrees -- so the width that the loop spaces
          // houses by ran across the street, and the front panel's thin axis
          // pointed down it. That is why the doors stuck out sideways and lay
          // flat instead of facing the road.
          const rot = Math.atan2(nx * side, nz * side);
          // Unit vector from the house centre toward the street.
          const fx = -nx * side, fz = -nz * side;

          b.addTaperedBox(w, h, d, bx, h * 0.5, bz, colour, 1, 1, rot);
          // A pitched-looking roof cap and a darker plinth.
          b.addTaperedBox(w * 1.04, h * 0.28, d * 1.04, bx, h + h * 0.12, bz, roofDark, 0.55, 0.75, rot);
          b.addBox(w * 1.02, 0.7, d * 1.02, bx, 0.35, bz, 0x2b2724, rot);

          // Front face detail, sitting just proud of the wall that faces the
          // street. Shops in the centre get a glazed band; everything else gets
          // a door and a pair of windows either side of it.
          const face = d * 0.5 + 0.06;
          if (r < 150) {
            b.addBox(w * 0.86, h * 0.30, 0.12, bx + fx * face, h * 0.28, bz + fz * face, 0x121a20, rot);
          } else {
            const doorW = Math.min(1.15, w * 0.18);
            const doorH = Math.min(2.15, h * 0.34);
            b.addBox(doorW, doorH, 0.12, bx + fx * face, doorH * 0.5, bz + fz * face, 0x2e2018, rot);
            // Windows, offset along the frontage rather than across it.
            const ox = Math.cos(rot), oz = -Math.sin(rot);   // local +X in world
            const winOff = w * 0.28;
            for (const sgn of [-1, 1]) {
              b.addBox(w * 0.22, h * 0.18, 0.10,
                bx + fx * face + ox * sgn * winOff, h * 0.55,
                bz + fz * face + oz * sgn * winOff, 0x16202a, rot);
            }
          }

          addStaticBox(sim.world, bx, h * 0.5, bz, w * 0.5, h * 0.5, d * 0.5, GROUP.BUILDING, rot);
          placed.add(bx, bz, radius * 0.72);
          count++;

          along += w + gap;
        }
      }
    }
  }

  ctx.buildingCount = count;
  const out = [];
  for (let q = 0; q < 4; q++) {
    const mesh = new THREE.Mesh(builders[q].build(), vertexColorMaterial());
    mesh.name = 'town' + q;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

// =====================================================================
//  Countryside
// =====================================================================

function buildTownCountryside(ctx) {
  const fields = new MeshBuilder();
  const trees = new MeshBuilder();

  // Keep woodland out of the built-up area, but let it crowd the bypass and
  // the A-roads so the outskirts are not a bare plain.
  const keepOut = (x, z) => Math.hypot(x, z) < TOWN_EDGE;

  buildFieldPatches(ctx, fields, { count: 110, minR: TOWN_EDGE, maxR: WORLD_HALF - 60, keepOut });
  scatterTrees(ctx, trees, {
    copses: 190, keepOut, minR: TOWN_EDGE + 20, maxR: WORLD_HALF - 70,
  });
  treesAlongRoads(ctx, trees, ['country', 'lane', 'dual', 'avenue'], { spacing: 16, skip: 0.5 });

  // A common on the edge of town: open grass with scattered oaks.
  const { rng } = ctx;
  const ca = rng() * TAU;
  const cx = Math.cos(ca) * 300, cz = Math.sin(ca) * 300;
  for (let i = 0; i < 26; i++) {
    addTree(ctx, trees, cx + rand(rng, -110, 110), cz + rand(rng, -110, 110), rand(rng, 1.0, 1.4));
  }

  const fm = new THREE.Mesh(fields.build(), vertexColorMaterial());
  fm.name = 'fields';
  const tm = new THREE.Mesh(trees.build(), vertexColorMaterial());
  tm.name = 'trees';
  tm.castShadow = true;
  return [fm, tm];
}
