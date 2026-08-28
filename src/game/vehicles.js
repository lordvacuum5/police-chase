// Vehicle definitions and the procedural bodywork that goes with them.
//
// The numbers here are ordinary engineering values -- kilograms, newtons per
// metre, newton-metres -- because the simulation in physics/vehicle.js treats
// them as such. Tuning the handling means changing real quantities: soften the
// rear anti-roll bar and the car stops snapping into oversteer; shorten first
// gear and it stops feeling like it is stuck in one ratio forever.

import * as THREE from 'three';
import { MeshBuilder, buildGrouped } from '../util/meshbuild.js';
import { policeTexture, DECAL } from './livery.js';

// ---------------------------------------------------------------- base spec

const baseSuspension = {
  mountY: 0.10,        // suspension top, relative to the centre of mass
  rest: 0.32,          // free length
  travel: 0.20,        // usable compression before the bump stop
  stiffness: 42000,    // N/m -- about 90 mm of static sag on a 1500 kg car
  dampCompress: 4200,  // N per m/s
  dampRebound: 5800,   // rebound is always the stiffer direction
  bumpStop: 26000,
  maxForce: 34000,
  // Softened at the front. A front bar twice the rear moves lateral load onto
  // the front axle, and a load-sensitive tyre gives back less than
  // proportionally -- which is understeer, felt as a heavy car that will not
  // turn. Still front-biased, so the limit stays push rather than snap.
  arbFront: 14200,
  arbRear: 9000,
};

const baseEngine = {
  idleRpm: 850,
  redline: 7000,
  brakeTorque: 58,     // engine braking on a closed throttle
  inertia: 0.28,       // kg m^2, reflected through the gearbox
  torqueCurve: [
    [800, 250], [1500, 355], [2500, 440], [3500, 482],
    [4500, 470], [5500, 428], [6500, 356], [7200, 292],
  ],
};

// Six reasonably close ratios. The previous set ran first gear all the way to
// 71 km/h and then skipped through the rest in a couple of seconds; these put
// the changes at roughly 54 / 82 / 110 / 140 / 171 km/h.
const baseGears = [0, 4.20, 2.75, 2.05, 1.62, 1.32, 1.08];

function makeSpec(o) {
  return Object.assign({
    dims: { w: 1.90, h: 1.20, l: 4.62 },
    colliderY: 0.32,
    mass: 1500,
    frontWeight: 0.53,
    wheelbase: 2.85,
    trackFront: 1.62,
    trackRear: 1.62,
    wheelRadius: 0.34,
    wheelWidth: 0.26,
    wheelMass: 22,
    drive: 'rwd',
    inertiaScale: { yaw: 1.15, roll: 1.25, pitch: 1.0 },
    suspension: Object.assign({}, baseSuspension),
    engine: Object.assign({}, baseEngine),
    gears: baseGears.slice(),
    reverseGear: 3.60,
    finalDrive: 3.70,
    shiftUpRpm: 6400,
    shiftDownRpm: 3050,
    shiftTime: 0.13,
    brakes: { maxTorque: 2400, frontBias: 0.62, handbrakeTorque: 3100 },
    steering: {
      maxAngle: 0.55,     // absolute lock at the road wheel
      minAngle: 0.055,    // never limited below this
      latLimit: 14.6,     // m/s^2 the limiter sizes the lock for
      overshoot: 1.20,    // how far past that the driver may still demand
      slipAllowance: 0.065, // extra lock for front tyre slip, radians
      rate: 2.45,         // rad/s winding lock on
      returnRate: 3.9,    // quicker coming back to centre, as with real castor
    },
    aero: { dragArea: 0.70, downforce: 0.42 },
    // Backs the engine off when the driven wheels spin. 0 disables it.
    tractionControl: 0.85,
    tcSlipThreshold: 0.16,
    gripScale: 1.0,
    // Per-axle grip trim. Rear above 1 buys traction and stability without
    // making the whole car feel like it is on rails.
    gripBias: { front: 1.0, rear: 1.0 },
    // Divides incoming collision damage. Higher is tougher.
    durability: 1.0,
    topSpeedHint: 78,     // m/s, used by the AI speed planner
  }, o);
}

// ------------------------------------------------------------------- roster

export const SPECS = {
  /** The escapee. Quick, but now stable enough to lean on. */
  runner: makeSpec({
    name: 'Runner',
    mass: 1425,
    frontWeight: 0.520,
    suspension: Object.assign({}, baseSuspension, { arbFront: 12400, arbRear: 9800 }),
    brakes: { maxTorque: 2400, frontBias: 0.62, handbrakeTorque: 4400 },
    gripScale: 1.0,
    // A little extra at the front is the direct anti-understeer lever.
    gripBias: { front: 1.09, rear: 1.05 },
    // Bare grass is 0.62 -- less than half the road figure -- which makes the
    // verge feel like ice the moment you clip it. This takes it to about 0.96,
    // enough to gather the car up rather than simply passenger it. Still well
    // short of the fleet's 1.80, so they keep the advantage off the tarmac.
    offRoadGrip: 1.55,
    durability: 1.25,
    topSpeedHint: 80,
  }),

  /** Bread-and-butter patrol car. Heavy, soft, tough, and slower. */
  patrol: makeSpec({
    name: 'Patrol',
    mass: 1780,
    frontWeight: 0.56,
    dims: { w: 1.94, h: 1.26, l: 4.92 },
    wheelbase: 2.95,
    suspension: Object.assign({}, baseSuspension, {
      stiffness: 40000, arbFront: 13000, arbRear: 9200, dampRebound: 6200,
    }),
    engine: Object.assign({}, baseEngine, {
      torqueCurve: [
        [800, 322], [1500, 455], [2500, 558], [3500, 590],
        [4500, 569], [5500, 514], [6500, 416], [7200, 333],
      ],
    }),
    // Fleet brakes: bigger discs, and an anti-lock system the runner has not
    // got. See README, "Better brakes than yours".
    brakes: { maxTorque: 3500, frontBias: 0.64, handbrakeTorque: 2800, abs: 1, gripBonus: 1.52 },
    aero: { dragArea: 0.76, downforce: 0.25 },
    gripScale: 0.97,
    gripBias: { front: 1.08, rear: 1.06 },
    // Fleet tyres bite on the loose. Grass mu goes 0.62 -> about 1.1, so a
    // line straight across country is a real option rather than a bog.
    offRoadGrip: 1.80,
    durability: 2.6,
    topSpeedHint: 88,
  }),

  /** Highway interceptor. Turns up at heat 3 and can actually stay with you. */
  interceptor: makeSpec({
    name: 'Interceptor',
    mass: 1700,
    frontWeight: 0.545,
    dims: { w: 1.96, h: 1.22, l: 4.90 },
    wheelbase: 2.92,
    suspension: Object.assign({}, baseSuspension, { arbFront: 13200, arbRear: 9400 }),
    // Genuinely more engine than the runner, and slipperier -- an interceptor
    // that cannot out-accelerate the car it is chasing is just scenery.
    engine: Object.assign({}, baseEngine, {
      torqueCurve: [
        [800, 324], [1500, 464], [2500, 570], [3500, 616],
        [4500, 605], [5500, 553], [6500, 458], [7200, 372],
      ],
    }),
    brakes: { maxTorque: 3800, frontBias: 0.63, handbrakeTorque: 3000, abs: 1, gripBonus: 1.58 },
    aero: { dragArea: 0.70, downforce: 0.40 },
    gripScale: 0.99,
    gripBias: { front: 1.09, rear: 1.05 },
    offRoadGrip: 1.85,
    durability: 2.8,
    topSpeedHint: 99,
  }),

  /** Unmarked pursuit car. Fastest thing they have, and hardest to spot. */
  unmarked: makeSpec({
    name: 'Unmarked',
    mass: 1620,
    frontWeight: 0.53,
    suspension: Object.assign({}, baseSuspension, { arbRear: 8800 }),
    engine: Object.assign({}, baseEngine, {
      torqueCurve: [
        [800, 340], [1500, 488], [2500, 600], [3500, 648],
        [4500, 637], [5500, 581], [6500, 480], [7200, 389],
      ],
    }),
    brakes: { maxTorque: 4000, frontBias: 0.62, handbrakeTorque: 3200, abs: 1, gripBonus: 1.62 },
    aero: { dragArea: 0.67, downforce: 0.44 },
    gripScale: 1.0,
    gripBias: { front: 1.08, rear: 1.06 },
    offRoadGrip: 1.88,
    durability: 2.4,
    topSpeedHint: 103,
  }),
};

// ---------------------------------------------------------------- liveries

export const LIVERIES = {
  runner:      { body: 0xd94f16, accent: 0x1a1614, glass: 0x0e1319, trim: 0x131619 },
  patrol:      { body: 0xeef2f6, accent: 0x13233f, glass: 0x0e1319, trim: 0x14171b },
  interceptor: { body: 0x0f1626, accent: 0xe8edf4, glass: 0x0d1218, trim: 0x14171b },
  unmarked:    { body: 0x23272e, accent: 0x1a1e24, glass: 0x0c1015, trim: 0x15181c },
};

// ------------------------------------------------------------ body geometry

/**
 * Build a car body as one merged, vertex-coloured mesh.
 *
 * Local space matches the physics body: +Z is forward, +X is the car's left,
 * and the origin sits at the centre of mass (about 0.47 m off the ground).
 *
 * The silhouette is deliberately low and raked -- a wide flat tub, a fastback
 * greenhouse set well back, and a ducktail -- so it reads as a modern coupe
 * rather than a box on wheels.
 */
export function buildCarGeometry(spec, livery, opts = {}) {
  const b = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const L = spec.dims.l;
  const W = spec.dims.w;
  const half = L * 0.5;

  // --- underbody ------------------------------------------------------
  // Narrower than the track and stopping above the wheel centres, so the
  // wheels are actually visible rather than swallowed by the bodywork.
  b.addBox(W * 0.72, 0.20, L * 0.88, 0, -0.20, 0, trim);

  // --- main tub, widest at the sills, gently tapered in at the top -----
  b.addTaperedBox(W, 0.44, L * 0.97, 0, 0.11, 0, body, 0.97, 0.99);
  b.addTaperedBox(W * 0.985, 0.16, L * 0.94, 0, 0.40, -0.04, body, 0.95, 0.97);

  // --- long raked bonnet and a short high tail ------------------------
  b.addTaperedBox(W * 0.93, 0.13, L * 0.34, 0, 0.50, half * 0.60, body, 0.90, 0.80, 0, 0.10);
  b.addTaperedBox(W * 0.94, 0.15, L * 0.24, 0, 0.51, -half * 0.70, body, 0.94, 0.92);
  // Ducktail lip.
  b.addBox(W * 0.86, 0.06, 0.20, 0, 0.60, -half * 0.90, body);

  // --- greenhouse: fastback glass with a slim roof panel ---------------
  b.addTaperedBox(W * 0.90, 0.34, L * 0.44, 0, 0.66, -0.22, glass, 0.80, 0.56, 0, -0.16);
  b.addTaperedBox(W * 0.90 * 0.80, 0.07, L * 0.44 * 0.56, 0, 0.86, -0.38, body, 0.98, 0.98);

  // --- character line along the flanks --------------------------------
  b.addBox(W * 1.005, 0.045, L * 0.66, 0, 0.30, -0.05, trim);

  // --- wheel arches ----------------------------------------------------
  const ax = W * 0.5 - 0.02;
  const af = L * 0.5 * 0.615, ar = -L * 0.5 * 0.655;
  for (const [zz, sgn] of [[af, 1], [af, -1], [ar, 1], [ar, -1]]) {
    b.addTaperedBox(0.15, 0.21, 1.38, sgn * ax, -0.05, zz, body, 1, 0.84);
  }

  // --- bumpers, splitter and diffuser ---------------------------------
  b.addTaperedBox(W * 1.0, 0.20, 0.30, 0, 0.14, half * 0.975, trim, 0.94, 1);
  b.addBox(W * 0.94, 0.05, 0.42, 0, -0.06, half * 0.96, trim);
  b.addTaperedBox(W * 1.0, 0.20, 0.26, 0, 0.16, -half * 0.978, trim, 0.94, 1);
  b.addBox(W * 0.80, 0.10, 0.30, 0, -0.10, -half * 0.94, trim);

  // --- slim LED light signatures ---------------------------------------
  b.addBox(W * 0.34, 0.075, 0.09, +W * 0.30, 0.40, half * 0.985, 0xf3efe0);
  b.addBox(W * 0.34, 0.075, 0.09, -W * 0.30, 0.40, half * 0.985, 0xf3efe0);
  // Full-width rear light bar.
  b.addBox(W * 0.90, 0.075, 0.08, 0, 0.44, -half * 0.985, 0x8e1c16);

  // --- police fit-out ---------------------------------------------------
  const decals = new MeshBuilder();
  if (opts.police) {
    if (!opts.unmarked) {
      // Modern low-profile light bar: a slim aerodynamic spine on two feet,
      // with a row of individual lamp modules along it and clear end caps
      // where the instanced flashers sit.
      b.addTaperedBox(1.30, 0.07, 0.22, 0, 0.945, -0.16, trim, 0.9, 0.8);
      b.addBox(0.10, 0.05, 0.16, +0.42, 0.905, -0.16, trim);
      b.addBox(0.10, 0.05, 0.16, -0.42, 0.905, -0.16, trim);
      b.addBox(1.14, 0.085, 0.16, 0, 1.00, -0.16, 0x11161d);
      for (let i = -2; i <= 2; i++) {
        b.addBox(0.13, 0.05, 0.17, i * 0.21, 1.005, -0.16, i % 2 ? 0x2f7dff : 0xd8dde4);
      }
      b.addBox(0.08, 0.10, 0.18, +0.62, 1.00, -0.16, trim);
      b.addBox(0.08, 0.10, 0.18, -0.62, 1.00, -0.16, trim);

      // Shark-fin aerial and a whip, as on any modern response car.
      b.addTaperedBox(0.07, 0.11, 0.26, 0, 0.945, -0.86, body, 0.3, 0.35, 0, -0.06);
      b.addBox(0.025, 0.30, 0.025, -0.30, 1.03, -0.70, trim);
      // A-pillar spotlight.
      b.addBox(0.11, 0.11, 0.17, +W * 0.40, 0.66, 0.62, 0xb9bec6);

      // ---- decals -------------------------------------------------------
      const sx = W * 0.5 + 0.014;
      const fz0 = -L * 0.30, fz1 = L * 0.26;
      const fy0 = 0.02, fy1 = 0.40;
      // u runs toward the rear on the left flank and toward the nose on the
      // right, which is what makes the wordmark read forwards on both sides.
      decals.addDecalQuad([
        { x: sx, y: fy0, z: fz1 }, { x: sx, y: fy0, z: fz0 },
        { x: sx, y: fy1, z: fz0 }, { x: sx, y: fy1, z: fz1 },
      ], { x: 1, y: 0, z: 0 }, DECAL.flank);
      decals.addDecalQuad([
        { x: -sx, y: fy0, z: fz0 }, { x: -sx, y: fy0, z: fz1 },
        { x: -sx, y: fy1, z: fz1 }, { x: -sx, y: fy1, z: fz0 },
      ], { x: -1, y: 0, z: 0 }, DECAL.flank);

      // Bonnet wordmark, reversed so it reads in a wing mirror. Proportioned
      // to the texture panel -- a near-square decal stretches the letters into
      // something unreadable.
      const by = 0.578;
      decals.addDecalQuad([
        { x: -0.64, y: by, z: half * 0.56 }, { x: 0.64, y: by, z: half * 0.56 },
        { x: 0.64, y: by, z: half * 0.74 }, { x: -0.64, y: by, z: half * 0.74 },
      ], { x: 0, y: 1, z: 0 }, DECAL.bonnet);

      // Roof unit number, ahead of the light bar.
      decals.addDecalQuad([
        { x: -0.46, y: 0.902, z: 0.16 }, { x: 0.46, y: 0.902, z: 0.16 },
        { x: 0.46, y: 0.902, z: 0.42 }, { x: -0.46, y: 0.902, z: 0.42 },
      ], { x: 0, y: 1, z: 0 }, DECAL.roof);

      // Rear chevrons across the tailgate.
      const rz = -half * 0.995;
      decals.addDecalQuad([
        { x: 0.72, y: 0.10, z: rz }, { x: -0.72, y: 0.10, z: rz },
        { x: -0.72, y: 0.46, z: rz }, { x: 0.72, y: 0.46, z: rz },
      ], { x: 0, y: 0, z: -1 }, DECAL.rear);
    } else {
      // Unmarked: no markings at all, just the hardware.
      b.addBox(0.10, 0.05, 0.14, +0.30, 0.90, -0.10, trim);
      b.addBox(0.025, 0.26, 0.025, -0.28, 1.00, -0.70, trim);
    }

    // Push bar with vertical stays.
    b.addBox(W * 0.90, 0.10, 0.09, 0, 0.34, half + 0.15, trim);
    b.addBox(W * 0.90, 0.08, 0.08, 0, 0.13, half + 0.15, trim);
    for (const px of [-0.34, -0.12, 0.12, 0.34]) {
      b.addBox(0.07, 0.36, 0.07, px * W, 0.24, half + 0.15, trim);
    }
    // Grille and rear-screen strobes.
    b.addBox(0.28, 0.07, 0.05, +W * 0.20, 0.26, half * 0.995, 0x2f7dff);
    b.addBox(0.28, 0.07, 0.05, -W * 0.20, 0.26, half * 0.995, 0xff2418);
    b.addBox(0.20, 0.06, 0.05, +0.30, 0.60, -half * 0.86, 0x2f7dff);
    b.addBox(0.20, 0.06, 0.05, -0.30, 0.60, -half * 0.86, 0xff2418);
  }

  return buildGrouped([b, decals]);
}

/** Material set for a car body, matching the groups buildCarGeometry emits. */
export function carMaterials(geometry, bodyMaterial) {
  if ((geometry.userData.groupCount || 1) < 2) return bodyMaterial;
  const decal = new THREE.MeshPhongMaterial({
    map: policeTexture(), shininess: 30, specular: 0x222222,
  });
  return [bodyMaterial, decal];
}

/** Where the flashing lamps sit, in body-local space. */
export const LAMP_OFFSETS = [
  new THREE.Vector3(+0.38, 1.00, -0.16),
  new THREE.Vector3(-0.38, 1.00, -0.16),
];

/** One wheel, oriented so its axle runs along X (the car's left/right axis). */
export function buildWheelGeometry(radius = 0.34, width = 0.26, rimColour = 0x50575f) {
  const tyre = new THREE.CylinderGeometry(radius, radius, width, 14, 1);
  tyre.rotateZ(Math.PI / 2);
  const pos = tyre.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const rim = new THREE.Color(rimColour);
  for (let i = 0; i < pos.count; i++) {
    // Rubber is very dark; only the wheel face itself should catch the light,
    // otherwise the tyres read as white discs under a bright sun.
    const onFace = Math.abs(pos.getX(i)) > width * 0.49;
    const r = Math.hypot(pos.getY(i), pos.getZ(i));
    // Keep the bright face small: most of what you see side-on is rubber.
    const isHub = onFace && r < radius * 0.48;
    if (isHub) {
      colors[i * 3] = rim.r; colors[i * 3 + 1] = rim.g; colors[i * 3 + 2] = rim.b;
    } else {
      colors[i * 3] = 0.045; colors[i * 3 + 1] = 0.045; colors[i * 3 + 2] = 0.05;
    }
  }
  tyre.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return tyre;
}

/** Small emissive box used for light bar lamps. */
export function buildLampGeometry() {
  return new THREE.BoxGeometry(0.30, 0.11, 0.20);
}
