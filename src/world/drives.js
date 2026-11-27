// Drives beside houses, with a car on each.
//
// "On some houses, can you put driveways where the cars are?" -- Wexbury first; then "the driveways and the
// cars parked on the hilly map" (Haldon Vale's villages), "but not on the American one". A share of houses,
// picked by a hash of where they stand (no draws from the map's random numbers, so nothing else moves), get
// a car parked beside them, its nose to the street, and a strip of concrete from behind it out to the pavement.
// Each car is made solid, as a building is, so trees, spawns and the police keep off it; the cars are drawn
// once the models are in (game/parked.js).

import * as THREE from 'three';
import { GROUP, addStaticBox, nearBuilding } from '../physics/world.js';
import { MeshBuilder, vertexColorMaterial } from './common.js';
import { groundDetail } from './groundtex.js';

/** The share of houses with a drive, and a drive's width, m. */
export const PARK_SHARE = 0.33;
export const DRIVE_W = 3;
/** Half the height of a parked car's collider, m. */
export const PARK_HY = 0.75;

export function driveHash(x, z) {
  let h = Math.imul(Math.round(x * 3) ^ 0x7feb352d, 0x846ca68b) ^ Math.imul(Math.round(z * 3) + 0x3c6ef372, 0x9e3779b1);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * A drive for the house at (bx, bz), frontage `w`, depth `d`, turned `rot`, its front facing (fx, fz) -- or
 * null if this house is not one of them. Pushed to `drives`.
 */
export function planDrive(drives, bx, bz, w, d, rot, fx, fz) {
  if (w >= 12 || driveHash(bx, bz) >= PARK_SHARE) return;
  const s = driveHash(bz, bx) < 0.5 ? 1 : -1;
  const ox = Math.cos(rot), oz = -Math.sin(rot);
  const along = d * 0.5 - 2.6;
  drives.push({ x: bx + ox * s * (w * 0.5 + 1.7) + fx * along, z: bz + oz * s * (w * 0.5 + 1.7) + fz * along, rot, fx, fz });
}

/**
 * Keep the drives clear of the road and the pavement, of every building but at their own house's side, and
 * of each other; make the cars solid. `paveOf(edge)`: how far the pavement runs out from that road's edge.
 * `at(x, z)`: the ground's height (Haldon's hills), or none. Returns { parked, mesh } -- `parked` the cars
 * for game/parked.js, `mesh` the concrete (or null), and `strips` each drive's rectangle, for the verges.
 */
export function layDrives(sim, graph, drives, paveOf, at = null) {
  const parked = [], strips = [];
  const b = new MeshBuilder();
  for (const c of drives) {
    if (graph.overlapsRoad(c.x, c.z, 2.0, 4.8, c.rot, 1.2)) continue;
    let clear = true;
    for (const k of [-1.9, 0, 1.9]) if (nearBuilding(sim.world, c.x + c.fx * k, c.z + c.fz * k, 1.05)) clear = false;
    if (!clear || parked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 5.5)) continue;
    const y = at ? at(c.x, c.z) : 0;
    // Solid while the map is built, so the trees and the spawns keep off it; game/parked.js swaps this for a
    // car that can be shoved once the models are in.
    const body = addStaticBox(sim.world, c.x, y + PARK_HY, c.z, 0.95, PARK_HY, 2.3, GROUP.BUILDING, c.rot);
    parked.push({ x: c.x, z: c.z, y, heading: Math.atan2(-c.fx, -c.fz), i: parked.length, body });
    // From the house end of the car out toward the street until it meets the pavement.
    const x0 = c.x - c.fx * 2.8, z0 = c.z - c.fz * 2.8;
    let reach = 2.8;
    for (; reach < 30; reach += 0.5) {
      const px = c.x + c.fx * reach, pz = c.z + c.fz * reach;
      const near = graph.nearestEdge(px, pz, 40);
      if (near && near.dist <= near.edge.width * 0.5 + paveOf(near.edge) - 0.3) break;
    }
    const x1 = c.x + c.fx * (reach + 0.3), z1 = c.z + c.fz * (reach + 0.3);
    const hw = DRIVE_W * 0.5, sx = -c.fz * hw, sz = c.fx * hw;
    b.addQuadY(x0 + sx, z0 + sz, x1 + sx, z1 + sz, x1 - sx, z1 - sz, x0 - sx, z0 - sz, 0.035, 0x66645f);
    strips.push({ x: (x0 + x1) * 0.5, z: (z0 + z1) * 0.5, fx: c.fx, fz: c.fz, half: (reach + 3.1) * 0.5, hw });
  }
  let mesh = null;
  if (b.vertexCount) {
    mesh = new THREE.Mesh(b.build(), vertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    mesh.name = 'driveways';
    mesh.receiveShadow = true;
    if (at) {
      const p = mesh.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) + at(p.getX(k), p.getZ(k)) + 0.03);
      mesh.geometry.computeBoundingSphere();
    }
    groundDetail(mesh, 'tarmac');
  }
  return { parked, mesh, strips };
}

/** Is (x, z) on one of `strips` (with `pad` m to spare)? */
export function onDrive(strips, x, z, pad = 0) {
  if (!strips) return false;
  for (const s of strips) {
    const dx = x - s.x, dz = z - s.z;
    const a = dx * s.fx + dz * s.fz, c = -dx * s.fz + dz * s.fx;
    if (Math.abs(a) < s.half + pad && Math.abs(c) < s.hw + pad) return true;
  }
  return false;
}

const DRIVE_CELL = 32;
/**
 * `onDrive` for one `pad`, asked many times: each strip filed under the 32 m cells its padded corners reach, so
 * a point is tested against the few strips in its own cell. Asked of all 383 of Ashfield's drives one after
 * another, it was 4.8 s of the verges' 8 s on that map's load (game/verges.js). Same answers.
 */
export function driveLookup(strips, pad = 0) {
  if (!strips || !strips.length) return () => false;
  const cells = new Map();
  for (const s of strips) {
    const r = Math.hypot(s.half + pad, s.hw + pad) / Math.max(1e-6, Math.hypot(s.fx, s.fz)) + 0.01;
    const i0 = Math.floor((s.x - r) / DRIVE_CELL), i1 = Math.floor((s.x + r) / DRIVE_CELL);
    const j0 = Math.floor((s.z - r) / DRIVE_CELL), j1 = Math.floor((s.z + r) / DRIVE_CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i * 65536 + j;
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(s);
    }
  }
  return (x, z) => {
    const list = cells.get(Math.floor(x / DRIVE_CELL) * 65536 + Math.floor(z / DRIVE_CELL));
    if (!list) return false;
    for (const s of list) {
      const dx = x - s.x, dz = z - s.z;
      const a = dx * s.fx + dz * s.fz, c = -dx * s.fz + dz * s.fx;
      if (Math.abs(a) < s.half + pad && Math.abs(c) < s.hw + pad) return true;
    }
    return false;
  };
}
