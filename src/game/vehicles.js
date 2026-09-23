// Vehicle definitions and the procedural bodywork that goes with them.
//
// The numbers here are ordinary engineering values -- kilograms, newtons per
// metre, newton-metres -- because the simulation in physics/vehicle.js treats
// them as such. Tuning the handling means changing real quantities: soften the
// rear anti-roll bar and the car stops snapping into oversteer; shorten first
// gear and it stops feeling like it is stuck in one ratio forever.

import * as THREE from 'three';
import { MeshBuilder, buildGrouped } from '../util/meshbuild.js';
import { policeTexture } from './livery.js';
import {
  buildSuvGeometry, buildVanGeometry, buildOffroadGeometry, addPoliceKit,
} from './bodies.js';

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
  // Height above the road, in metres, at which cornering force enters the body
  // (see physics/vehicle.js). 0 is the road itself, which is what every car
  // was tuned on; only a car with the grip to roll itself needs more.
  rollCentre: 0,
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

/**
 * Tuning levers, applied across whole groups of cars.
 *
 * The police were still struggling to keep up at every wanted level -- "just
 * increase their speed and grip a bit" -- and the Badger and the Stiletto were
 * both "a bit too fast", on maps where slipping between two houses already
 * loses a pursuit. Measured before and after in README, "Evening it up".
 */
const POLICE_POWER = 1.12;
const POLICE_GRIP = 1.08;
const STILETTO_POWER = 0.85;
const BADGER_POWER = 0.86;

/**
 * The fleet's gears: the patrol car's ratios with a taller sixth, so the extra
 * power turns into top speed as well as acceleration instead of running into
 * the limiter at 222 km/h like the Runner.
 */
const POLICE_GEARS = [0, 4.20, 2.75, 2.05, 1.62, 1.32, 0.96];

/** A torque curve with every point scaled. */
function scaled(k, curve) {
  return curve.map(([rpm, nm]) => [rpm, Math.round(nm * k)]);
}

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
    // Grip at speed (see physics/vehicle.js). Ramps in from 72 km/h, full by
    // 150. Measured at full lock: 140 km/h went from 11 degrees of body slip
    // on average (17 at worst) to under 2 (3), and steady cornering grip at
    // 140 km/h from 1.29 g to 1.45. Stiffer and grippier at the rear than the
    // front, so the extra bite never outruns the tail.
    highSpeedTyre: {
      from: 20, to: 42,
      stiffness: { front: 2.2, rear: 2.8 },
      grip: { front: 1.15, rear: 1.25 },
    },
  }),

  /**
   * The Stiletto: a mid-engined supercar, and the other way to run.
   *
   * Everything the Runner is not. A V12 that revs to 8 800 on a seven-speed
   * gearbox, good for about 258 km/h where every other car in the game runs
   * into its limiter at about 220; wide, sticky tyres and
   * real downforce, so it corners harder the faster it goes; low, stiff and
   * short of travel, so it hates kerbs and grass. And it is fragile: carbon
   * and aluminium rather than a saloon's steel, so the contact the Runner
   * shrugs off ends this one's run in a handful of hits.
   *
   * The trade is meant to be real. The Runner is the car you can lean on the
   * police with; this is the car you had better not let them touch.
   */
  supercar: makeSpec({
    name: 'Stiletto',
    body: 'supercar',
    dims: { w: 2.00, h: 0.98, l: 4.58 },
    // Collider bottom 0.20 m off the ground and top at the roof, 1.18 m, same
    // clearance as the saloons. Shifted forward because the body is placed on
    // the axles rather than centred on a centre of mass this far back.
    colliderY: 0.195,
    colliderZ: 0.214,
    mass: 1390,
    // Mid-engined: the weight sits behind the driver.
    frontWeight: 0.42,
    wheelbase: 2.68,
    trackFront: 1.70,
    trackRear: 1.66,
    wheelRadius: 0.35,
    wheelWidth: 0.30,
    // Visual only: the rears are visibly wider, as on anything mid-engined.
    // The physics runs one tyre width; the difference is carried in gripBias.
    wheelWidthRear: 0.35,
    wheelMass: 20,
    // Less yaw inertia than a front-engined saloon of the same mass, because
    // the heavy parts are near the middle. That is what makes it turn in.
    inertiaScale: { yaw: 0.92, roll: 1.05, pitch: 0.90 },
    suspension: Object.assign({}, baseSuspension, {
      mountY: 0.08,
      rest: 0.28,
      // Short and stiff. A 140 mm kerb takes most of the travel, and you feel
      // it -- that is part of the car's character, not an accident.
      travel: 0.16,
      stiffness: 62000,
      dampCompress: 5600,
      dampRebound: 7600,
      bumpStop: 34000,
      maxForce: 38000,
      // Its grip reaches 2 g at speed, and with cornering force going in at
      // the road it tipped over at about 1.7: full lock from 100 km/h upward
      // put it on its roof. Taken in 18 cm up, the lever that rolls it is a
      // third shorter and the tipping point comes out well past anything the
      // tyres can do.
      rollCentre: 0.18,
      arbFront: 15500,
      arbRear: 12500,
    }),
    engine: Object.assign({}, baseEngine, {
      idleRpm: 1000,
      redline: 8800,
      brakeTorque: 64,
      inertia: 0.21,
      // Twelve cylinders fire six times a revolution; see audio.js.
      order: 6,
      // Launch control: see physics/vehicle.js. Near the top of the torque
      // curve without being at the part of it that just lights up the rears.
      launchRpm: 4800,
      // Taken down by 18%, with the final drive shortened to match. As first
      // built it did 0-200 in 9.8 s and 304 km/h, against 222 km/h for the
      // fastest police car even with the rubber band at full stretch, and 223
      // for the helicopter: at five stars you could simply drive away from all
      // of it on any long straight. Now 0-100 in 4.4 s, 0-200 in 12.2 and
      // 257 km/h (tests/outrun.js) -- still far quicker than the Runner, but a
      // pursuit car closing on the rubber band can live with it, and the
      // helicopter can outfly it.
      torqueCurve: scaled(STILETTO_POWER, [
        [900, 320], [2000, 426], [3000, 502], [4000, 551],
        [5000, 578], [6000, 587], [7000, 569], [8000, 525], [9000, 466],
      ]),
    }),
    // Seven ratios. Changes at roughly 66 / 95 / 125 / 157 / 191 / 225 km/h,
    // and seventh runs into the limiter at about 258.
    gears: [0, 3.15, 2.18, 1.66, 1.32, 1.08, 0.92, 0.80],
    reverseGear: 3.10,
    finalDrive: 6.0,
    shiftUpRpm: 8400,
    shiftDownRpm: 4300,
    // A twin-clutch box: the torque interruption is a fraction of the Runner's.
    shiftTime: 0.06,
    brakes: { maxTorque: 3100, frontBias: 0.60, handbrakeTorque: 3600 },
    steering: {
      maxAngle: 0.52,
      minAngle: 0.055,
      // Sized for the grip it actually has, so the limiter does not hold it
      // back to what a saloon could do.
      latLimit: 17.5,
      overshoot: 1.18,
      slipAllowance: 0.06,
      rate: 2.95,
      returnRate: 4.4,
    },
    // Slipperier than the saloons, with more downforce than the Runner's 0.42:
    // 0.6 m^2 is about 1.9 kN of extra load at 200 km/h. It was 0.95, and with
    // the rest of the grip that went with it (see highSpeedTyre) the car
    // cornered at 2 g at 220 km/h.
    aero: { dragArea: 0.62, downforce: 0.60 },
    tractionControl: 0.90,
    tcSlipThreshold: 0.13,
    // 1.18 until the car was found to have too much grip everywhere, not only
    // at speed: 1.57 g at 60 km/h, now 1.50 -- still well past the Runner's 1.28.
    gripScale: 1.12,
    // Wider rears carry the traction; the fronts are trimmed to match, so the
    // extra grip does not simply turn into extra understeer.
    gripBias: { front: 1.10, rear: 1.13 },
    // Low, on wide summer tyres: the verge is genuinely bad news. Grass mu
    // 0.62 comes up to only about 0.74, against the Runner's 0.96.
    offRoadGrip: 1.20,
    // A little under half the Runner's 3.2. Every hit costs about 2.3 times as
    // much, and because engine power falls away past 28% damage, two solid
    // ones and it is already down on the car it was.
    durability: 1.40,
    topSpeedHint: 72,
    // Grip at speed. The first setting was weighted hard to the rear (grip
    // x1.16 front, x1.40 rear; stiffness x1.4, x2.4), because with 58% of the
    // weight at the back an even one spun it at 140 km/h. It overdid it: the
    // tail could never let go, so full lock at any speed just pushed the nose
    // wide at up to 2 g with the body dead straight -- 0.4 degrees of slip at
    // 180 km/h. "You can steer full lock and it will still remain stable."
    //
    // Now the fronts are a touch stiffer and grippier than the rears at speed,
    // so held at full lock the tail comes round: 7 degrees on average at
    // 180 km/h, 14 at worst, shedding speed, and straight again within a
    // fraction of a second of letting go. It does not spin. A gentle input
    // still holds its line (tests/highspeed.js; README, "Grip at speed").
    highSpeedTyre: {
      from: 20, to: 42,
      stiffness: { front: 1.2, rear: 1.05 },
      grip: { front: 1.05, rear: 0.97 },
    },
  }),

  /** Bread-and-butter patrol car. Heavy, soft, tough, and slower. */
  patrol: makeSpec({
    name: 'Patrol',
    gears: POLICE_GEARS.slice(),
    mass: 1780,
    frontWeight: 0.56,
    dims: { w: 1.94, h: 1.26, l: 4.92 },
    wheelbase: 2.95,
    suspension: Object.assign({}, baseSuspension, {
      stiffness: 40000, arbFront: 13000, arbRear: 9200, dampRebound: 6200,
    }),
    engine: Object.assign({}, baseEngine, {
      torqueCurve: scaled(POLICE_POWER, [
        [800, 322], [1500, 455], [2500, 558], [3500, 590],
        [4500, 569], [5500, 514], [6500, 416], [7200, 333],
      ]),
    }),
    // Fleet brakes: bigger discs, and an anti-lock system the runner has not
    // got. See README, "Better brakes than yours".
    brakes: { maxTorque: 3500, frontBias: 0.64, handbrakeTorque: 2800, abs: 1, gripBonus: 1.52 },
    aero: { dragArea: 0.76, downforce: 0.25 },
    gripScale: 0.97 * POLICE_GRIP,
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
    gears: POLICE_GEARS.slice(),
    mass: 1700,
    frontWeight: 0.545,
    dims: { w: 1.96, h: 1.22, l: 4.90 },
    wheelbase: 2.92,
    suspension: Object.assign({}, baseSuspension, { arbFront: 13200, arbRear: 9400 }),
    // Genuinely more engine than the runner, and slipperier -- an interceptor
    // that cannot out-accelerate the car it is chasing is just scenery.
    engine: Object.assign({}, baseEngine, {
      torqueCurve: scaled(POLICE_POWER, [
        [800, 324], [1500, 464], [2500, 570], [3500, 616],
        [4500, 605], [5500, 553], [6500, 458], [7200, 372],
      ]),
    }),
    brakes: { maxTorque: 3800, frontBias: 0.63, handbrakeTorque: 3000, abs: 1, gripBonus: 1.58 },
    aero: { dragArea: 0.70, downforce: 0.40 },
    gripScale: 0.99 * POLICE_GRIP,
    gripBias: { front: 1.09, rear: 1.05 },
    offRoadGrip: 1.85,
    durability: 2.8,
    topSpeedHint: 99,
  }),

  /** Unmarked pursuit car. Fastest thing they have, and hardest to spot. */
  unmarked: makeSpec({
    name: 'Unmarked',
    gears: POLICE_GEARS.slice(),
    mass: 1620,
    frontWeight: 0.53,
    suspension: Object.assign({}, baseSuspension, { arbRear: 8800 }),
    engine: Object.assign({}, baseEngine, {
      torqueCurve: scaled(POLICE_POWER, [
        [800, 340], [1500, 488], [2500, 600], [3500, 648],
        [4500, 637], [5500, 581], [6500, 480], [7200, 389],
      ]),
    }),
    brakes: { maxTorque: 4000, frontBias: 0.62, handbrakeTorque: 3200, abs: 1, gripBonus: 1.62 },
    aero: { dragArea: 0.67, downforce: 0.44 },
    gripScale: 1.0 * POLICE_GRIP,
    gripBias: { front: 1.08, rear: 1.06 },
    offRoadGrip: 1.88,
    durability: 2.4,
    topSpeedHint: 103,
  }),

  /**
   * Police SUV. Heavy, tall and four-wheel drive: as quick as an interceptor
   * off the line, better than anything on the grass, and a lot of car to be
   * shunted by. Rolls more than a saloon, so the springs and bars are stiff
   * and cornering force goes in above the road, as on the Stiletto.
   */
  suv: makeSpec({
    name: 'Police SUV',
    gears: POLICE_GEARS.slice(),
    body: 'suv',
    mass: 2150,
    frontWeight: 0.52,
    dims: { w: 2.0, h: 1.56, l: 4.95 },
    colliderY: 0.46,
    wheelbase: 2.98,
    trackFront: 1.70,
    trackRear: 1.70,
    wheelRadius: 0.39,
    wheelWidth: 0.28,
    wheelMass: 26,
    drive: 'awd',
    inertiaScale: { yaw: 1.2, roll: 1.3, pitch: 1.1 },
    suspension: Object.assign({}, baseSuspension, {
      mountY: 0.12, rest: 0.40, travel: 0.26, stiffness: 56000,
      dampCompress: 5600, dampRebound: 7600, bumpStop: 34000, maxForce: 46000,
      arbFront: 19000, arbRear: 14000, rollCentre: 0.16,
    }),
    engine: Object.assign({}, baseEngine, {
      torqueCurve: scaled(POLICE_POWER, [
        [800, 380], [1500, 540], [2500, 660], [3500, 690],
        [4500, 670], [5500, 610], [6500, 500], [7200, 400],
      ]),
    }),
    finalDrive: 3.85,
    brakes: { maxTorque: 4400, frontBias: 0.63, handbrakeTorque: 3400, abs: 1, gripBonus: 1.5 },
    aero: { dragArea: 0.92, downforce: 0.2 },
    gripScale: 0.98 * POLICE_GRIP,
    gripBias: { front: 1.08, rear: 1.06 },
    offRoadGrip: 2.0,
    durability: 3.4,
    topSpeedHint: 92,
  }),

  /**
   * Armoured van, at five stars only. Slow -- a diesel in a box -- but three
   * and a half tonnes of it, built to take hits and to hand them out. It is not
   * there to catch you; it is there to be in the way when the others do.
   */
  van: makeSpec({
    name: 'Armoured Van',
    body: 'van',
    mass: 3400,
    frontWeight: 0.55,
    dims: { w: 2.05, h: 2.1, l: 5.9 },
    colliderY: 0.72,
    wheelbase: 3.66,
    trackFront: 1.76,
    trackRear: 1.76,
    wheelRadius: 0.40,
    wheelWidth: 0.26,
    wheelMass: 30,
    drive: 'rwd',
    inertiaScale: { yaw: 1.25, roll: 1.35, pitch: 1.2 },
    suspension: Object.assign({}, baseSuspension, {
      mountY: 0.12, rest: 0.42, travel: 0.24, stiffness: 96000,
      dampCompress: 9600, dampRebound: 13000, bumpStop: 70000, maxForce: 90000,
      arbFront: 30000, arbRear: 24000, rollCentre: 0.24,
    }),
    engine: Object.assign({}, baseEngine, {
      idleRpm: 750,
      redline: 5000,
      brakeTorque: 90,
      inertia: 0.45,
      torqueCurve: [
        [700, 520], [1500, 780], [2500, 860], [3500, 820], [4500, 690], [5200, 540],
      ],
    }),
    gears: [0, 4.6, 2.9, 1.95, 1.42, 1.0, 0.8],
    finalDrive: 3.9,
    shiftUpRpm: 4500,
    shiftDownRpm: 2100,
    shiftTime: 0.2,
    brakes: { maxTorque: 7600, frontBias: 0.62, handbrakeTorque: 5000, abs: 1, gripBonus: 1.4 },
    steering: {
      maxAngle: 0.55, minAngle: 0.05, latLimit: 9.5, overshoot: 1.15,
      slipAllowance: 0.06, rate: 2.0, returnRate: 3.2,
    },
    aero: { dragArea: 1.9, downforce: 0.1 },
    gripScale: 0.93 * POLICE_GRIP,
    gripBias: { front: 1.06, rear: 1.04 },
    offRoadGrip: 1.7,
    durability: 9,
    topSpeedHint: 44,
  }),

  /**
   * The Badger: a square old 4x4, and the third way to run. Slow on the road
   * and heavy in the corners, but the toughest thing you can drive, long
   * springs that do not care about kerbs, and four-wheel drive on tyres that
   * grip on grass nearly as well as on tarmac -- so the shortcut across the
   * park that bogs everyone else down is yours.
   */
  offroad: makeSpec({
    name: 'Badger',
    body: 'offroad',
    mass: 2050,
    frontWeight: 0.54,
    dims: { w: 1.95, h: 1.62, l: 4.45 },
    colliderY: 0.52,
    wheelbase: 2.65,
    trackFront: 1.62,
    trackRear: 1.62,
    wheelRadius: 0.42,
    wheelWidth: 0.30,
    wheelMass: 28,
    drive: 'awd',
    inertiaScale: { yaw: 1.1, roll: 1.25, pitch: 1.1 },
    suspension: Object.assign({}, baseSuspension, {
      mountY: 0.12, rest: 0.44, travel: 0.32, stiffness: 50000,
      dampCompress: 5000, dampRebound: 7000, bumpStop: 30000, maxForce: 46000,
      arbFront: 15000, arbRear: 11000, rollCentre: 0.22,
    }),
    engine: Object.assign({}, baseEngine, {
      redline: 6500,
      torqueCurve: scaled(BADGER_POWER, [
        [800, 400], [1500, 550], [2500, 640], [3500, 650],
        [4500, 615], [5500, 530], [6500, 420],
      ]),
    }),
    // Short, low gearing and five speeds, which is what a working four-wheel
    // drive has: geared to pull, not to cruise. It runs out of revs in top at
    // about 145 km/h rather than pulling on to 190 -- "the Land Rover needs to
    // top out at like 140 kilometres an hour", because the fleet is not fast
    // enough to make a chase of it otherwise.
    gears: [0, 4.30, 3.35, 2.70, 2.20, 1.85],
    finalDrive: 3.9,
    shiftUpRpm: 6000,
    brakes: { maxTorque: 3200, frontBias: 0.62, handbrakeTorque: 4000 },
    // A brick, and now drag is most of what holds the top end down.
    aero: { dragArea: 1.25, downforce: 0.1 },
    gripScale: 0.96,
    gripBias: { front: 1.04, rear: 1.04 },
    // Grass mu 0.62 comes up to about 1.1: as good as most of the fleet does
    // on the road, and far more than the Stiletto's 0.74.
    offRoadGrip: 1.8,
    durability: 4.0,
    topSpeedHint: 55,
  }),
};

/**
 * The interceptor, as a person has to drive it.
 *
 * Police cars are tuned for the AI, which plans its speed into a corner before
 * it gets there and never asks for more than it worked out it could have. A
 * person does not: they hold the wheel over and wait to see what happens. Put
 * a human in a stock interceptor and it slides -- "it's so hard to drive, like,
 * honestly, it just slides".
 *
 * The difference is one setting. Both player cars carry a `highSpeedTyre` (see
 * README, "Grip at speed"): above about 72 km/h the lateral curve stiffens, so
 * the car points where it is going instead of running nine degrees sideways
 * while it corners. The fleet has never had it, because nothing driving those
 * cars needed it. This gives the car a human drives the Runner's version of it
 * -- "maybe make it similar to the first car we ever made" -- and leaves every
 * AI interceptor exactly as it was, so the chase is unchanged.
 *
 * Applied to the one car, as its own copy of the spec, so it does not touch
 * the shared table: same body, same model, same collider, same engine.
 */
export function drivablePoliceSpec(key = 'interceptor') {
  const base = SPECS[key] || SPECS.interceptor;
  return Object.assign({}, base, {
    // The Runner's setting, but coming in from 29 km/h rather than 72.
    //
    // Matching the Runner exactly was aiming at the wrong target: the Runner
    // is itself a handful, which is the point of it -- floor it mid-corner at
    // 60 km/h and it goes to 18 degrees of slip and does not come back. A
    // chase happens at city speeds, and the whole 40-80 km/h band was below
    // where the setting did anything, so the car was still raw exactly where
    // it was being driven. Measured, `tests/drivable.js`.
    //
    // Nothing is done about traction control here, because every car already
    // has it (makeSpec's default, 0.85): turning it up moved wheelspin by four
    // hundredths on tarmac and on grass, and body slip not at all. What was
    // missing was grip in the corner, not restraint on the throttle.
    // Front grip was 1.15, below the rear's 1.25, which is what kept the tail
    // planted -- and also what made the nose run wide of the lock the driver
    // asked for from about 70 km/h up: "at higher speeds, like fifty to a
    // hundred, it needs to be slightly better at turning". At 1.24 the two
    // ends are almost even, and the car goes round measurably tighter at the
    // top of that band without getting loose at the bottom of it
    // (tests/policeturn.js; README, "Turning at chase speeds"):
    //
    //   full lock, steady speed   50 km/h   70 km/h   90 km/h   100 km/h
    //   radius, was               10.6 m    21.9 m    36.6 m    43.9 m
    //   radius, now               10.3 m    19.7 m    30.6 m    36.4 m
    //   body slip, was / now      4.9/5.0   1.4/1.5   0.5/0.5   0.3/0.2
    //
    // Stiffening the front instead was tried and made it worse, and giving the
    // steering limiter a higher lateral target did nothing the tyres had not
    // already done.
    highSpeedTyre: {
      from: 8, to: 30,
      stiffness: { front: 2.2, rear: 2.8 },
      grip: { front: 1.24, rear: 1.25 },
    },
    // A shade more bite at the back than the fleet setting, for the same
    // reason: the tail stepping out is what a person cannot catch.
    gripBias: { front: base.gripBias.front, rear: base.gripBias.rear + 0.04 },

    // Heavier and stronger than anything the other side can be driving, so a
    // shove is a shove: "my police car should have more power than any of the
    // criminal cars... you should be able to shove him." A quarter of a tonne
    // over the Runner was not enough to feel, because what moves a car in a
    // contact is momentum, and half a tonne is. The engine goes up with it so
    // the extra mass is not paid for in acceleration.
    mass: Math.round(base.mass * 1.14),
    engine: Object.assign({}, base.engine, {
      torqueCurve: base.engine.torqueCurve.map(([rpm, nm]) => [rpm, Math.round(nm * 1.12)]),
    }),
  });
}

// ---------------------------------------------------------------- liveries

export const LIVERIES = {
  runner:      { body: 0xd94f16, accent: 0x1a1614, glass: 0x0e1319, trim: 0x131619 },
  supercar:    { body: 0xb3101e, accent: 0x141416, glass: 0x0b0f14, trim: 0x101113 },
  patrol:      { body: 0xeef2f6, accent: 0x13233f, glass: 0x0e1319, trim: 0x14171b },
  interceptor: { body: 0x0f1626, accent: 0xe8edf4, glass: 0x0d1218, trim: 0x14171b },
  unmarked:    { body: 0x23272e, accent: 0x1a1e24, glass: 0x0c1015, trim: 0x15181c },
  suv:         { body: 0xf1f4f7, accent: 0x13233f, glass: 0x0b1016, trim: 0x15181c },
  van:         { body: 0xeef1f4, accent: 0x13233f, glass: 0x0b1016, trim: 0x1b1f25 },
  offroad:     { body: 0x4c7a3a, accent: 0xe9e2c8, glass: 0x0e1319, trim: 0x15171a },
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
  if (spec.body === 'supercar') return buildSupercarGeometry(spec, livery);
  if (spec.body === 'suv') return buildSuvGeometry(spec, livery, opts);
  if (spec.body === 'van') return buildVanGeometry(spec, livery, opts);
  if (spec.body === 'offroad') return buildOffroadGeometry(spec, livery, opts);
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
  let lamps = null;
  if (opts.police) {
    if (!opts.unmarked) {
      // The shared kit (see bodies.js): a full-width light bar, battenburg
      // down the whole flank rather than one door, chevrons, roof number,
      // push bar and grille strobes. The band stops short of the nose, where
      // the wings step down below its top edge.
      lamps = addPoliceKit(b, decals, {
        flankX: hw,
        band: { y0: tyreTop + 0.01, y1: wingTop - 0.03, z0: -half + 0.22, z1: cowl + bonnetD * 0.55 },
        roof: { y: roofTop, z: -0.14, halfW: 0.46 },
        roofId: { z0: 0.16, z1: 0.42 },
        bonnet: {
          y0: belt + 0.082, y1: belt + 0.082,
          z0: cowl + bonnetD * 0.10, z1: cowl + bonnetD * 0.10 + 0.30, halfW: 0.66,
        },
        rear: { z: -half * 0.998, y0: 0.04, y1: 0.40, halfW: 0.72 },
        nose: { z: half, y: lampY - 0.115, halfW: hw },
        barW: 1.36,
      }, trim);

      // Shark-fin aerial and a whip, as on any modern response car.
      b.addTaperedBox(0.07, 0.11, 0.26, 0, roofTop + 0.05, rf0 + 0.18, body, 0.3, 0.35, 0, -0.06);
      b.addBox(0.025, 0.30, 0.025, -0.30, roofTop + 0.14, rf0 + 0.34, trim);
      // A-pillar spotlight.
      b.addBox(0.11, 0.11, 0.17, +(hw - 0.06), belt + 0.055, cowl - 0.02, 0xb9bec6);
    } else {
      // Unmarked: no markings at all, just the hardware.
      b.addBox(0.10, 0.05, 0.14, +0.30, roofTop + 0.025, -0.10, trim);
      b.addBox(0.025, 0.26, 0.025, -0.28, roofTop + 0.13, -0.70, trim);
      // Push bar and hidden grille strobes.
      b.addBox(W * 0.70, 0.075, 0.07, 0, lampY + 0.01, half + 0.11, trim);
      b.addBox(W * 0.70, 0.065, 0.07, 0, lampY - 0.24, half + 0.11, trim);
      for (const px of [-0.30, 0.30]) {
        b.addBox(0.06, 0.32, 0.06, px * W, lampY - 0.115, half + 0.11, trim);
      }
      b.addBox(0.26, 0.06, 0.05, +W * 0.14, lampY - 0.115, half - 0.005, 0x2f7dff);
      b.addBox(0.26, 0.06, 0.05, -W * 0.14, lampY - 0.115, half - 0.005, 0xff2418);
    }
    // Rear-screen strobes.
    b.addBox(0.20, 0.06, 0.05, +0.30, gy + 0.05, deck + 0.30, 0x2f7dff);
    b.addBox(0.20, 0.06, 0.05, -0.30, gy + 0.05, deck + 0.30, 0xff2418);
  }

  const geo = buildGrouped([b, decals]);
  geo.userData.lamps = lamps;
  return geo;
}

/**
 * The Stiletto's bodywork: a low mid-engined wedge, lofted rather than boxed.
 *
 * Every other car in the game is a saloon, which is mostly flat panels and
 * suits tapered boxes. This one is all curves along its length -- a nose that
 * rises into the wings, a short cabin pushed forward, a roof that falls away
 * into a long engine cover, and haunches that swell over the rear wheels --
 * so it is built from lofted cross-sections (MeshBuilder.addLoft).
 *
 * Heights are worked out above the ground and converted, because that is how
 * a car's proportions are actually described. The body is also not centred on
 * the centre of mass: with 58% of the weight at the back, a body centred on
 * the CoM would have a stubby nose and a tail a metre and a half long. It is
 * placed on the axles instead, with the collider shifted to match
 * (`colliderZ` in the spec).
 */
function buildSupercarGeometry(spec, livery) {
  const b = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const sus = spec.suspension;

  // Where the ground is, in body space, with the car settled on its springs.
  const sag = (spec.mass * 9.81 * 0.25) / sus.stiffness;
  const hub = sus.mountY - (sus.rest - sag);
  const G = -(hub - spec.wheelRadius);      // add to a height above ground
  const y = (h) => h - G;

  const zf = spec.wheelbase * (1 - spec.frontWeight);
  const zr = -spec.wheelbase * spec.frontWeight;
  const nose = zf + 0.95, tail = zr - 0.95;
  const eps = 0.002;

  // --- body -----------------------------------------------------------
  // Six-point half profile: underside, lower chamfer, flank, shoulder, and a
  // deck running in to the centreline. `ys` is the underside, which is what
  // jumps up over each wheel to open the arch.
  const bodySec = (z, h) => ({
    z,
    pts: [
      [0, y(h.ys)],
      [h.xs - 0.05, y(h.ys)],
      [h.xs, y(h.sill)],
      [h.xs, y(h.sh)],
      [h.xd, y(h.dk)],
      [0, y(h.dk + (h.crown || 0.02))],
    ],
  });
  // The shape at a handful of stations, without the arches. Everything in
  // between is interpolated, which is what lets the arches be cut as real
  // curves below rather than as notches.
  const R = spec.wheelRadius + 0.06;         // arch radius, about the hub
  const keys = [
    // A low, wide nose that rises into the wings.
    { z: nose,          ys: 0.15, sill: 0.20, xs: 0.80, sh: 0.44, xd: 0.70, dk: 0.49, crown: 0 },
    { z: nose - 0.12,   ys: 0.13, sill: 0.22, xs: 0.93, sh: 0.58, xd: 0.76, dk: 0.60, crown: 0.01 },
    { z: nose - 0.32,   ys: 0.13, sill: 0.24, xs: 0.98, sh: 0.69, xd: 0.79, dk: 0.68, crown: 0.02 },
    { z: zf + R + 0.02, ys: 0.13, sill: 0.25, xs: 1.0,  sh: 0.76, xd: 0.80, dk: 0.74, crown: 0.02 },
    { z: zf,            ys: 0.13, sill: 0.25, xs: 1.0,  sh: 0.84, xd: 0.78, dk: 0.83, crown: 0.02 },
    // Doors. Waisted in, so the haunches read as haunches.
    { z: zf - R - 0.02, ys: 0.14, sill: 0.21, xs: 0.97, sh: 0.84, xd: 0.76, dk: 0.87, crown: 0.02 },
    { z: 0.55,          ys: 0.15, sill: 0.22, xs: 0.935, sh: 0.82, xd: 0.74, dk: 0.90, crown: 0.02 },
    { z: -0.25,         ys: 0.15, sill: 0.24, xs: 0.915, sh: 0.84, xd: 0.72, dk: 0.92, crown: 0.02 },
    // The widest part of the car is over the rear wheels.
    { z: zr + R + 0.02, ys: 0.15, sill: 0.27, xs: 0.99, sh: 0.88, xd: 0.74, dk: 0.93, crown: 0.02 },
    { z: zr,            ys: 0.15, sill: 0.27, xs: 1.025, sh: 0.92, xd: 0.72, dk: 0.93, crown: 0.02 },
    // Tail, cut off square the way they all are now.
    { z: zr - R - 0.02, ys: 0.20, sill: 0.29, xs: 1.0,  sh: 0.88, xd: 0.72, dk: 0.91, crown: 0.02 },
    { z: tail + 0.14,   ys: 0.22, sill: 0.33, xs: 0.97, sh: 0.87, xd: 0.74, dk: 0.90, crown: 0.02 },
    { z: tail,          ys: 0.25, sill: 0.35, xs: 0.93, sh: 0.85, xd: 0.78, dk: 0.87, crown: 0 },
  ].sort((p, q) => p.z - q.z);

  const at = (z) => {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].z < z) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const u = Math.min(1, Math.max(0, (z - k0.z) / (k1.z - k0.z)));
    const o = {};
    for (const f of ['ys', 'sill', 'xs', 'sh', 'xd', 'dk', 'crown']) o[f] = k0[f] + (k1[f] - k0[f]) * u;
    return o;
  };

  // Round arches. The underside follows a circle about the hub, stepping
  // straight down to the sill at each end -- a square notch the length of the
  // opening, which is what this was at first, reads as a black box around
  // every wheel.
  const hubH = spec.wheelRadius;             // hub height above the ground
  const archDz = [-1, -0.92, -0.75, -0.45, 0, 0.45, 0.75, 0.92, 1];
  const sections = [];
  const inArch = (z) => Math.abs(z - zf) < R + 0.01 || Math.abs(z - zr) < R + 0.01;
  for (const k of keys) if (!inArch(k.z)) sections.push(bodySec(k.z, k));
  for (const zc of [zf, zr]) {
    sections.push(bodySec(zc - R - eps, at(zc - R - eps)));
    sections.push(bodySec(zc + R + eps, at(zc + R + eps)));
    for (const f of archDz) {
      const dz = f * R, z = zc + dz;
      const h = at(z);
      h.ys = Math.max(h.ys, hubH + Math.sqrt(Math.max(0, R * R - dz * dz)));
      h.sill = Math.max(h.sill, h.ys + 0.01);
      h.sh = Math.max(h.sh, h.sill + 0.03);
      sections.push(bodySec(z, h));
    }
  }
  b.addLoft(sections, (edge) => (edge === 0 ? 0x0a0b0d : body));

  // --- cabin and engine cover -------------------------------------------
  // Four-point half profile: base, side glass, roof edge, crown. One loft
  // carries the screen, the roof, the rear buttresses and the engine cover,
  // coloured by which run it is.
  const cabSec = (z, xb, hb, xt, ht, crown = 0.02) => ({
    z, pts: [[0, y(hb)], [xb, y(hb)], [xt, y(ht)], [0, y(ht + crown)]],
  });
  const screenBase = zf - 0.22;
  b.addLoft([
    cabSec(screenBase, 0.72, 0.84, 0.70, 0.855, 0),
    cabSec(0.40, 0.75, 0.88, 0.55, 1.165),
    cabSec(-0.20, 0.73, 0.90, 0.53, 1.18),
    cabSec(-0.95, 0.71, 0.91, 0.58, 1.00),
    cabSec(tail + 0.08, 0.72, 0.875, 0.68, 0.905, 0.01),
  ], (edge, run) => {
    if (edge <= 0) return body;
    if (run === 0) return glass;                         // windscreen
    if (run === 1) return edge === 1 ? glass : body;     // side glass, roof
    if (run === 2) return edge === 1 ? body : glass;     // buttresses, rear screen
    return body;                                         // engine cover
  });
  // Louvres across the engine cover. As a whole dark panel the cabin, screen
  // and cover merged into one black slab from above; a few slats say "engine
  // under here" without it.
  for (const [lz, lh] of [[-1.20, 0.985], [-1.42, 0.965], [-1.64, 0.945]]) {
    b.addBox(0.66, 0.02, 0.07, 0, y(lh + 0.012), lz, 0x15171a);
  }

  // --- arch liners --------------------------------------------------------
  // The arches are cut clean through the loft, so beside each wheel you would
  // see straight through the car. A dark block inboard of the tyres closes it.
  // One per arch, and no taller than the underside over the wheel: a single
  // core the length of the car stood up through the bonnet near the nose.
  for (const zc of [zf, zr]) {
    b.addBox(1.26, y(hubH + R - 0.01) - y(0.12), R * 2,
      0, (y(hubH + R - 0.01) + y(0.12)) * 0.5, zc, 0x08090b);
  }

  // --- front ------------------------------------------------------------
  // Splitter, twin intakes, and slim lamps swept back into the wings.
  b.addTaperedBox(1.86, 0.03, 0.34, 0, y(0.12), nose - 0.10, trim, 0.98, 0.80);
  for (const sgn of [1, -1]) {
    b.addBox(0.50, 0.12, 0.05, sgn * 0.46, y(0.25), nose - 0.005, 0x07080a);
    b.addTaperedBox(0.44, 0.045, 0.30, sgn * 0.66, y(0.575), nose - 0.20, 0xe7edf5,
      0.9, 0.7, sgn * 0.30);
    b.addTaperedBox(0.46, 0.02, 0.32, sgn * 0.66, y(0.545), nose - 0.21, 0x0b0d10,
      1, 1, sgn * 0.30);
  }
  b.addBox(0.34, 0.08, 0.04, 0, y(0.30), nose - 0.004, 0x07080a);

  // --- flanks -----------------------------------------------------------
  // The side intake behind the door is the signature of a mid-engined car:
  // that is where the radiators and the engine breathe.
  for (const sgn of [1, -1]) {
    b.addTaperedBox(0.05, 0.26, 0.56, sgn * 0.915, y(0.56), zr + R + 0.30, 0x07080a, 1, 0.55);
    // Door shut lines.
    b.addBox(0.012, y(0.80) - y(0.26), 0.018, sgn * 0.938, (y(0.80) + y(0.26)) * 0.5,
      zf - R - 0.06, trim);
    b.addBox(0.012, y(0.82) - y(0.26), 0.018, sgn * 0.918, (y(0.82) + y(0.26)) * 0.5,
      -0.12, trim);
    // Side skirt.
    b.addTaperedBox(0.06, 0.06, (zf - R) - (zr + R) - 0.06, sgn * 0.93, y(0.18),
      (zf - R + zr + R) * 0.5, trim, 0.8, 1);
    // Mirrors, on thin stalks off the base of the A-pillar.
    b.addBox(0.10, 0.025, 0.04, sgn * 0.80, y(0.93), screenBase - 0.10, trim);
    b.addTaperedBox(0.17, 0.07, 0.12, sgn * 0.90, y(0.95), screenBase - 0.12, body, 0.8, 0.75);
  }

  // --- rear -------------------------------------------------------------
  // A black panel across the tail with four round-ish lamps set into it, a
  // raised lip, a deep diffuser with fins, and the exhausts in the middle.
  const rz = tail - 0.004;
  b.addBox(1.78, y(0.84) - y(0.46), 0.05, 0, (y(0.84) + y(0.46)) * 0.5, rz, 0x0d0e11);
  for (const lx of [0.42, 0.70]) {
    for (const sgn of [1, -1]) {
      b.addBox(0.17, 0.10, 0.05, sgn * lx, y(0.73), rz - 0.012, 0xd01f22);
      b.addBox(0.09, 0.05, 0.05, sgn * lx, y(0.73), rz - 0.02, 0xff5a4a);
    }
  }
  b.addBox(1.80, 0.035, 0.18, 0, y(0.885), tail + 0.05, body);
  b.addTaperedBox(1.40, y(0.40) - y(0.15), 0.46, 0, (y(0.40) + y(0.15)) * 0.5,
    tail + 0.18, 0x0a0b0d, 1, 0.55, 0, -0.10);
  for (const fx of [-0.45, -0.15, 0.15, 0.45]) {
    b.addBox(0.02, 0.18, 0.40, fx, y(0.24), tail + 0.18, trim);
  }
  for (const sgn of [1, -1]) {
    b.addBox(0.13, 0.08, 0.10, sgn * 0.16, y(0.40), tail - 0.02, 0x2a2d32);
    b.addBox(0.09, 0.05, 0.02, sgn * 0.16, y(0.40), tail - 0.07, 0x050506);
  }

  return buildGrouped([b]);
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
