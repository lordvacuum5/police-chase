// Thin wrapper around Rapier so the rest of the game never touches the raw API.

import RAPIER from 'rapier';

/** Collision group bits. Rapier packs these as (membership << 16) | filter. */
export const GROUP = {
  TERRAIN: 0x0001,   // ground, roads
  BUILDING: 0x0002,  // static blockers
  PROP: 0x0004,      // barriers, lamp posts, trees
  VEHICLE: 0x0008,   // anything that drives
  // Light, knock-aside clutter: traffic cones and the like. Deliberately its
  // own group so the AI's obstacle sweeps ignore it -- a cone is something you
  // drive through, and a police car that brakes for one is worse than useless.
  DEBRIS: 0x0010,
  // Street furniture: lamp posts, bollards, bins, signs, signal poles. Solid
  // enough to shove a car about a bit, but invisible to every ray and sweep --
  // an AI that brakes for a bollard, or a wheel that climbs a lamp post, is
  // worse than furniture you can drive through.
  STREET: 0x0020,
};

export const groups = (membership, filter) => ((membership << 16) | filter) >>> 0;

/** What a suspension ray is allowed to see -- deliberately not other vehicles. */
export const RAY_GROUNDS = groups(0xFFFF, GROUP.TERRAIN | GROUP.BUILDING | GROUP.PROP);

/**
 * What is worth *braking* for, as opposed to steering around.
 *
 * A building is a wall: arrive too fast and the chase is over. A tree or a
 * lamp post is a thing to miss, and a driver does not slow to walking pace for
 * one -- they go past it. Feeding props into the braking distance had units
 * crawling through anywhere with trees, which on the town map is most of it.
 */
export const RAY_SOLID = groups(0xFFFF, GROUP.TERRAIN | GROUP.BUILDING);
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

// Sweep shapes, cached by half-width. Callers pass the size of the car doing
// the looking rather than a shared guess: a fixed probe is either too narrow
// for the widest car (a gap it calls clear is one that car does not fit
// through) or too wide for the rest, which is worse in a different way -- they
// refuse gaps they would sail through. There are only a handful of distinct
// widths, so the cache never grows.
const _sweepShapes = new Map();
const _sweepRot = { x: 0, y: 0, z: 0, w: 1 };
const _sweepPos = { x: 0, y: 0, z: 0 };

function sweepShapeFor(halfWidth) {
  const key = Math.round(halfWidth * 100);
  let s = _sweepShapes.get(key);
  if (!s) {
    s = new RAPIER.Cuboid(halfWidth, 0.5, 0.35);
    _sweepShapes.set(key, s);
  }
  return s;
}

/**
 * Sweep a car-width box along `dir` and return the distance to the first thing
 * it touches, or `maxToi` if the way is clear.
 *
 * A ray is a line with no width. A fan of them can thread either side of a
 * tree or clip past the corner of a building and report open road, which is
 * exactly how a car two metres wide ends up wrapped round a lamp post that
 * nothing ever saw. Sweeping the actual shape asks the question the car cares
 * about: will *this* fit through there.
 */
export function sweepBox(
  world, origin, dir, maxToi, filterGroups = undefined, excludeBody = null, halfWidth = 1.0,
) {
  _sweepPos.x = origin.x; _sweepPos.y = origin.y; _sweepPos.z = origin.z;
  const hit = world.castShape(
    _sweepPos, _sweepRot, dir, sweepShapeFor(halfWidth),
    0, maxToi, true,
    undefined, filterGroups, undefined, excludeBody || undefined,
  );
  if (!hit) return maxToi;
  const toi = hit.time_of_impact !== undefined ? hit.time_of_impact
    : (hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi);
  return toi === undefined ? maxToi : toi;
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

/**
 * A traffic cone: a light, tippable dynamic body.
 *
 * Modelled as a cone rather than a box so it rolls and topples the way one
 * does, and given a real (small) mass so hitting it costs the car almost
 * nothing while the cone itself goes flying. It only collides with vehicles
 * and the ground -- not with other cones, and not with anything the AI probes
 * for, so a scattered cone never becomes an obstacle the police brake for.
 */
export function addCone(world, x, y, z, radius = 0.30, height = 0.75) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + height * 0.5, z)
      .setLinearDamping(0.35)
      .setAngularDamping(0.6)
      .setCcdEnabled(true),
  );
  const col = RAPIER.ColliderDesc.cone(height * 0.5, radius)
    .setDensity(38)               // ~2.5 kg for this size: it flies, you do not
    .setFriction(0.55)
    .setRestitution(0.12)
    .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.TERRAIN | GROUP.VEHICLE));
  world.createCollider(col, body);
  return body;
}

/** Static box helper -- used for buildings, barriers and bridge decks. */
export function addStaticBox(
  world, cx, cy, cz, hx, hy, hz, group = GROUP.BUILDING, rotY = 0,
  filter = group === GROUP.STREET ? (GROUP.TERRAIN | GROUP.VEHICLE) : 0xFFFF,
) {
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz);
  if (rotY !== 0) {
    const h = rotY * 0.5;
    bodyDesc.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
  }
  const body = world.createRigidBody(bodyDesc);
  const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setFriction(0.9)
    .setRestitution(0.05)
    .setCollisionGroups(groups(group, filter));
  world.createCollider(col, body);
  return body;
}

export { RAPIER };
