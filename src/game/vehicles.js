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
    // Raised hard. Contact is the whole texture of a pursuit and the runner was
    // collecting damage from every scrape; the trade is that what does get
    // through hurts far more (see the torque falloff in vehicle.js).
    durability: 3.2,
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
 * and the origin sits at the centre of mass -- which is *not* the middle of
 * the wheelbase, so the axle positions here come from the same numbers the
 * suspension uses rather than being guessed as a fraction of the length.
 *
 * The silhouette is a modern rear-drive saloon: a low nose with slim lamp
 * units, a long bonnet, a cabin set well back under a tapering roof, and --
 * the thing that most separates a current car from an eighties one -- proper
 * wheel arch cut-outs, so the wheels stand clear of the bodywork instead of
 * being swallowed by a slab-sided tub.
 */
export function buildCarGeometry(spec, livery, opts = {}) {
  const b = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const L = spec.dims.l;
  const W = spec.dims.w;
  const half = L * 0.5;
  const hw = W * 0.5;

  // Axles, in body space. frontWeight biases the centre of mass forwards, so
  // the front axle is the closer of the two to the origin.
  const zf = spec.wheelbase * (1 - spec.frontWeight);
  const zr = -spec.wheelbase * spec.frontWeight;
  const r = spec.wheelRadius;

  // Wheel centre height at rest: the chassis settles about 0.10 m into its
  // springs, so this is where the hubs sit relative to the body origin.
  const hub = -0.10;
  const tyreTop = hub + r;        // nothing solid may hang below this over a wheel
  const floor = hub - r + 0.11;   // underbody, i.e. ride height
  const archHalf = r * 1.30;      // half the length of an arch opening

  const belt = 0.58;              // shoulder line: top of the flanks, base of the glass
  const roof = 0.90;
  const roofTop = roof + 0.035;

  // Where the doors begin and end, and so where the arches are cut.
  const fArch = zf - archHalf, rArch = zr + archHalf;

  // --- underbody -------------------------------------------------------
  b.addBox(W * 0.78, 0.10, L * 0.88, 0, floor - 0.03, 0, 0x0a0c0f);

  // --- lower body ------------------------------------------------------
  // Only the overhangs reach down to bumper height. Between the axles there
  // is just a rocker, inset from the flanks, and that is what leaves the
  // wheels standing in open arches instead of buried in bodywork.
  const noseD = half - (zf + archHalf);
  b.addTaperedBox(W * 0.98, tyreTop - floor, noseD,
    0, (tyreTop + floor) * 0.5, half - noseD * 0.5, body, 0.99, 1.10, 0, -0.02);
  const tailD = (zr - archHalf) + half;
  b.addTaperedBox(W * 0.98, tyreTop - floor, tailD,
    0, (tyreTop + floor) * 0.5, -half + tailD * 0.5, body, 0.99, 1.06);

  const rockD = fArch - rArch, rockZ = (fArch + rArch) * 0.5;
  b.addBox(W * 0.93, (tyreTop + 0.02) - (floor + 0.06), rockD,
    0, ((tyreTop + 0.02) + (floor + 0.06)) * 0.5, rockZ, body);
  // Side skirt, tucked under the doors.
  b.addTaperedBox(W * 0.96, 0.07, rockD * 0.96, 0, floor + 0.09, rockZ, trim, 0.97, 1);

  // --- flanks ----------------------------------------------------------
  // The cowl is where the windscreen meets the bonnet, and it is the point at
  // which the bodywork stops being full shoulder height. Ahead of it the
  // wings step down twice, which is what stops the nose reading as a brick.
  const cowl = zf - 0.34;
  const bonnetD = half - cowl;
  const wingTop = belt - 0.075;
  const noseTop = wingTop - 0.075;
  const flankY0 = tyreTop - 0.02;

  // Cabin and rear quarters: full height, from the tail up to the cowl.
  b.addTaperedBox(W, belt - flankY0, cowl + half,
    0, (belt + flankY0) * 0.5, (cowl - half) * 0.5, body, 0.985, 0.995);
  // Front wings, then the nose itself, each a step lower than the last.
  b.addTaperedBox(W * 0.995, wingTop - flankY0, bonnetD * 0.60,
    0, (wingTop + flankY0) * 0.5, cowl + bonnetD * 0.30, body, 0.99, 0.995);
  b.addTaperedBox(W * 0.985, noseTop - flankY0, bonnetD * 0.46,
    0, (noseTop + flankY0) * 0.5, half - bonnetD * 0.23, body, 0.97, 0.93);

  // Blistered arch lips, standing proud of the flank.
  for (const [zz, sgn] of [[zf, 1], [zf, -1], [zr, 1], [zr, -1]]) {
    b.addTaperedBox(0.12, 0.22, archHalf * 2.05, sgn * (hw - 0.02), 0.29, zz, body, 1, 0.86);
  }
  // A haunch over the rear axle: the flank swells slightly toward the back.
  b.addTaperedBox(W * 1.012, 0.15, archHalf * 2.6, 0, 0.44, zr + 0.10, body, 0.99, 0.90);

  // Door shut lines. Two doors a side, so three seams.
  for (const dz of [fArch - 0.05, rockZ - 0.06, rArch + 0.04]) {
    b.addBox(W * 1.006, belt - tyreTop - 0.02, 0.022, 0, (belt + tyreTop) * 0.5, dz, trim);
  }

  // --- bonnet and boot lid ---------------------------------------------
  // The bonnet caps each wing step, so it follows the same fall toward the
  // nose. A power bulge down the middle keeps the panel from reading flat.
  b.addTaperedBox(W * 0.90, 0.055, bonnetD * 0.58,
    0, wingTop + 0.025, cowl + bonnetD * 0.29, body, 0.98, 0.99);
  b.addTaperedBox(W * 0.87, 0.055, bonnetD * 0.44,
    0, noseTop + 0.025, half - bonnetD * 0.22, body, 0.95, 0.92);
  b.addTaperedBox(W * 0.44, 0.035, bonnetD * 0.86,
    0, wingTop + 0.05, cowl + bonnetD * 0.46, body, 0.80, 0.98);

  const deck = zr + 0.35;
  b.addTaperedBox(W * 0.93, 0.06, deck + half,
    0, belt + 0.02, (deck - half) * 0.5, body, 0.97, 0.99);
  // Ducktail lip on the trailing edge of the boot.
  b.addBox(W * 0.88, 0.05, 0.16, 0, belt + 0.065, -half + 0.12, body);

  // --- greenhouse -------------------------------------------------------
  // Three glazed sections: a steeply raked screen, the cabin, and a fastback
  // rear window. Tapering the top face and shifting it back or forward is
  // what gives each of them its rake.
  const gh = roof - (belt + 0.06), gy = belt + 0.06 + gh * 0.5;
  const scrD = 0.62;
  b.addTaperedBox(W * 0.86, gh, scrD, 0, gy, cowl - scrD * 0.5, glass, 0.86, 0.30, 0, -0.20);
  const cabD = (cowl - scrD) - (deck + 0.58);
  b.addTaperedBox(W * 0.86, gh, cabD, 0, gy, (cowl - scrD + deck + 0.58) * 0.5, glass, 0.86, 1);
  b.addTaperedBox(W * 0.86, gh, 0.60, 0, gy, deck + 0.28, glass, 0.86, 0.42, 0, 0.17);

  // Roof panel, spanning the tops of the screen and the rear window.
  const rf0 = deck + 0.28 - 0.126 + 0.17, rf1 = cowl - scrD * 0.5 + 0.093 - 0.20;
  b.addTaperedBox(W * 0.74, 0.07, rf1 - rf0, 0, roofTop - 0.035, (rf0 + rf1) * 0.5, body, 0.99, 0.97);

  // Window graphics. Without these the glass is one undifferentiated black
  // slab, which is most of what made the old body look like a box on wheels:
  // a body-coloured B-pillar splits it into two windows, and a bright surround
  // draws the line between glass and bodywork.
  b.addBox(0.075, gh, 0.09, +W * 0.432, gy, rockZ + 0.05, body);
  b.addBox(0.075, gh, 0.09, -W * 0.432, gy, rockZ + 0.05, body);
  const winD = (cowl - scrD * 0.4) - (deck + 0.30);
  const winZ = ((cowl - scrD * 0.4) + deck + 0.30) * 0.5;
  b.addBox(W * 0.875, 0.035, winD, 0, belt + 0.075, winZ, 0xb9c1cb);
  // Roof drip rails.
  b.addBox(0.05, 0.05, winD * 0.86, +W * 0.375, roof - 0.015, winZ - 0.06, body);
  b.addBox(0.05, 0.05, winD * 0.86, -W * 0.375, roof - 0.015, winZ - 0.06, body);

  // Door mirrors on short stalks, capped in the livery accent.
  for (const sgn of [1, -1]) {
    b.addBox(0.09, 0.05, 0.05, sgn * (hw + 0.03), belt + 0.02, cowl - scrD * 0.75, body);
    b.addTaperedBox(0.21, 0.085, 0.11, sgn * (hw + 0.13), belt + 0.055,
      cowl - scrD * 0.80, accent, 0.85, 0.9);
  }

  // --- front end --------------------------------------------------------
  // Slim lamp units in the corners, a dark upper grille between them, and a
  // separate lower intake with a splitter under it.
  // The lamps sit just under the leading edge of the bonnet, so they follow
  // the nose down rather than floating halfway up a flat wall.
  const lampY = noseTop - 0.13;
  for (const sgn of [1, -1]) {
    b.addTaperedBox(0.56, 0.16, 0.26, sgn * (hw - 0.30), lampY, half - 0.10, 0x11151b, 0.94, 0.55);
    b.addBox(0.50, 0.075, 0.09, sgn * (hw - 0.30), lampY + 0.025, half - 0.015, 0xf4f7fc);
    b.addBox(0.50, 0.030, 0.075, sgn * (hw - 0.30), lampY - 0.055, half - 0.02, 0x8ec8ff);
  }
  b.addBox(W * 0.50, 0.145, 0.09, 0, lampY, half - 0.02, 0x090c10);
  b.addBox(W * 0.78, 0.20, 0.10, 0, lampY - 0.30, half - 0.04, 0x090c10);
  b.addTaperedBox(W * 0.92, 0.06, 0.32, 0, floor + 0.03, half - 0.18, trim, 0.96, 1);

  // --- rear end ---------------------------------------------------------
  b.addBox(W * 0.94, 0.085, 0.07, 0, belt - 0.10, -half + 0.02, 0x7d1712);
  for (const sgn of [1, -1]) {
    b.addBox(0.32, 0.14, 0.08, sgn * (hw - 0.22), belt - 0.10, -half + 0.015, 0xbf2a1f);
  }
  b.addBox(W * 0.74, 0.13, 0.28, 0, floor + 0.05, -half + 0.15, 0x0c0f14);

  // --- police fit-out ---------------------------------------------------
  const decals = new MeshBuilder();
  if (opts.police) {
    if (!opts.unmarked) {
      // Modern low-profile light bar: a slim aerodynamic spine on two feet,
      // with a row of individual lamp modules along it and clear end caps
      // where the instanced flashers sit.
      const barZ = -0.14;
      b.addBox(0.11, 0.035, 0.17, +0.44, roofTop + 0.018, barZ, trim);
      b.addBox(0.11, 0.035, 0.17, -0.44, roofTop + 0.018, barZ, trim);
      b.addTaperedBox(1.30, 0.05, 0.23, 0, roofTop + 0.055, barZ, trim, 0.92, 0.84);
      b.addBox(1.16, 0.08, 0.17, 0, roofTop + 0.105, barZ, 0x11161d);
      for (let i = -2; i <= 2; i++) {
        b.addBox(0.13, 0.05, 0.18, i * 0.21, roofTop + 0.112, barZ, i % 2 ? 0x2f7dff : 0xd8dde4);
      }
      b.addBox(0.08, 0.095, 0.19, +0.62, roofTop + 0.105, barZ, trim);
      b.addBox(0.08, 0.095, 0.19, -0.62, roofTop + 0.105, barZ, trim);

      // Shark-fin aerial and a whip, as on any modern response car.
      b.addTaperedBox(0.07, 0.11, 0.26, 0, roofTop + 0.05, rf0 + 0.18, body, 0.3, 0.35, 0, -0.06);
      b.addBox(0.025, 0.30, 0.025, -0.30, roofTop + 0.14, rf0 + 0.34, trim);
      // A-pillar spotlight.
      b.addBox(0.11, 0.11, 0.17, +(hw - 0.06), belt + 0.055, cowl - 0.02, 0xb9bec6);

      // ---- decals -------------------------------------------------------
      const sx = hw + 0.016;
      const fz1 = fArch - 0.02, fz0 = fz1 - 2.15;
      const fy0 = tyreTop - 0.02, fy1 = fy0 + 0.33;
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
      const by = belt + 0.082;
      const bz0 = cowl + bonnetD * 0.10, bz1 = bz0 + 0.30;
      decals.addDecalQuad([
        { x: -0.66, y: by, z: bz0 }, { x: 0.66, y: by, z: bz0 },
        { x: 0.66, y: by, z: bz1 }, { x: -0.66, y: by, z: bz1 },
      ], { x: 0, y: 1, z: 0 }, DECAL.bonnet);

      // Roof unit number, ahead of the light bar.
      decals.addDecalQuad([
        { x: -0.46, y: roofTop + 0.002, z: barZ + 0.28 },
        { x: 0.46, y: roofTop + 0.002, z: barZ + 0.28 },
        { x: 0.46, y: roofTop + 0.002, z: barZ + 0.54 },
        { x: -0.46, y: roofTop + 0.002, z: barZ + 0.54 },
      ], { x: 0, y: 1, z: 0 }, DECAL.roof);

      // Rear chevrons across the tailgate, below the light bar.
      const rz = -half * 0.998;
      decals.addDecalQuad([
        { x: 0.72, y: 0.04, z: rz }, { x: -0.72, y: 0.04, z: rz },
        { x: -0.72, y: 0.40, z: rz }, { x: 0.72, y: 0.40, z: rz },
      ], { x: 0, y: 0, z: -1 }, DECAL.rear);
    } else {
      // Unmarked: no markings at all, just the hardware.
      b.addBox(0.10, 0.05, 0.14, +0.30, roofTop + 0.025, -0.10, trim);
      b.addBox(0.025, 0.26, 0.025, -0.28, roofTop + 0.13, -0.70, trim);
    }

    // Push bar. Kept slim and set close in: the earlier one was a full-width
    // slab that hid the whole front of the car behind it.
    b.addBox(W * 0.70, 0.075, 0.07, 0, lampY + 0.01, half + 0.11, trim);
    b.addBox(W * 0.70, 0.065, 0.07, 0, lampY - 0.24, half + 0.11, trim);
    for (const px of [-0.30, 0.30]) {
      b.addBox(0.06, 0.32, 0.06, px * W, lampY - 0.115, half + 0.11, trim);
    }
    // Grille and rear-screen strobes.
    b.addBox(0.26, 0.06, 0.05, +W * 0.14, lampY - 0.115, half - 0.005, 0x2f7dff);
    b.addBox(0.26, 0.06, 0.05, -W * 0.14, lampY - 0.115, half - 0.005, 0xff2418);
    b.addBox(0.20, 0.06, 0.05, +0.30, gy + 0.05, deck + 0.30, 0x2f7dff);
    b.addBox(0.20, 0.06, 0.05, -0.30, gy + 0.05, deck + 0.30, 0xff2418);
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

/**
 * Where the flashing lamps sit, in body-local space. Must track the light bar
 * in buildCarGeometry: roof panel top (0.935) plus the bar's own height.
 */
export const LAMP_OFFSETS = [
  new THREE.Vector3(+0.38, 1.040, -0.14),
  new THREE.Vector3(-0.38, 1.040, -0.14),
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
    // Now that the arches are cut away the wheel is actually on show, so the
    // alloy runs most of the way out to the rim rather than being a small
    // hub cap. The outermost band stays dark: that is the tyre sidewall.
    const isRim = onFace && r < radius * 0.80;
    if (isRim) {
      // A little radial shading so the face is not one flat disc -- it reads
      // as spokes catching the light without needing any extra geometry.
      const t = r / (radius * 0.80);
      const k = 0.72 + 0.28 * Math.abs(Math.cos(Math.atan2(pos.getY(i), pos.getZ(i)) * 5)) * t;
      colors[i * 3] = rim.r * k; colors[i * 3 + 1] = rim.g * k; colors[i * 3 + 2] = rim.b * k;
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
