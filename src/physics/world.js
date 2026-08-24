// Thin wrapper around Rapier so the rest of the game never touches the raw API.

import RAPIER from 'rapier';

/** Collision group bits. Rapier packs these as (membership << 16) | filter. */
export const GROUP = {
  TERRAIN: 0x0001,   // ground, roads
  BUILDING: 0x0002,  // static blockers
  PROP: 0x0004,      // barriers, lamp posts, trees
  VEHICLE: 0x0008,   // anything that drives
};

export const groups = (membership, filter) => ((membership << 16) | filter) >>> 0;

/** What a suspension ray is allowed to see -- deliberately not other vehicles. */
export const RAY_GROUNDS = groups(0xFFFF, GROUP.TERRAIN | GROUP.BUILDING | GROUP.PROP);
/** What a line-of-sight ray is allowed to see -- buildings block, vehicles do not. */
export const RAY_SIGHT = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);

let initialised = false;

export async function initPhysics() {
  if (!initialised) {
    await RAPIER.init();
    initialised = true;
  }
  return RAPIER;
}

export function createWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // Fewer solver iterations than the default keeps a weak CPU happy; the
  // vehicles get their stability from the tyre model, not from the solver.
  world.integrationParameters.numSolverIterations = 4;
  world.integrationParameters.numAdditionalFrictionIterations = 4;
  world.integrationParameters.numInternalPgsIterations = 1;
  return world;
}

const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

/**
 * Cast a ray and return { toi, point, normal, collider } or null.
 * `origin` and `dir` are anything with x/y/z. `dir` should be normalised.
 */
export function raycast(world, origin, dir, maxToi, filterGroups = undefined, excludeBody = null) {
  _ray.origin.x = origin.x; _ray.origin.y = origin.y; _ray.origin.z = origin.z;
  _ray.dir.x = dir.x; _ray.dir.y = dir.y; _ray.dir.z = dir.z;

  const hit = world.castRayAndGetNormal(
    _ray, maxToi, true,
    undefined,          // filterFlags
    filterGroups,       // interaction groups
    undefined,          // exclude collider
    excludeBody || undefined
  );
  if (!hit) return null;

  const toi = hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi;
  return {
    toi,
    point: {
      x: origin.x + dir.x * toi,
      y: origin.y + dir.y * toi,
      z: origin.z + dir.z * toi,
    },
    normal: hit.normal,
    collider: hit.collider,
  };
}

/** True if nothing solid sits between two world points. */
export function hasLineOfSight(world, a, b, pad = 0.0) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const hit = raycast(world, a, dir, len - pad, RAY_SIGHT, null);
  return hit === null;
}

/** Static box helper -- used for buildings, barriers and bridge decks. */
export function addStaticBox(world, cx, cy, cz, hx, hy, hz, group = GROUP.BUILDING, rotY = 0) {
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz);
  if (rotY !== 0) {
    const h = rotY * 0.5;
    bodyDesc.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
  }
  const body = world.createRigidBody(bodyDesc);
  const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setFriction(0.9)
    .setRestitution(0.05)
    .setCollisionGroups(groups(group, 0xFFFF));
  world.createCollider(col, body);
  return body;
}

export { RAPIER };
