// Can they stay with a fast car on real roads?
//
// "The police car seems really slow. They need to be able to match the fastest
// of the fast cars."
//
// tests/outrun.js already says the cars are not the problem: an interceptor
// run flat out in a straight line tops out at 241 km/h against the Stiletto's
// 240, and 249 with the rubber band at full stretch. So if they cannot keep
// up, it is the driver and not the machine, and this measures the driver.
//
// A ghost target is carried along a route through the road network at a fixed
// speed -- it cannot crash, so the run is the same length every time and the
// only thing that varies is how well the pursuit follows it. Two interceptors
// start on top of it, and what comes back is:
//
//   mean      their average speed over the run
//   behind    how far back they are at the end, averaged
//   withPct   how much of the run at least one of them was within 60 m, which
//             is the difference between a pursuit and a search
//   hits      impacts above a knock, because speed bought by crashing is not
//             speed -- the lesson of every other change in this file's company
//
// Run it at several ghost speeds. 90 km/h is brisk for a town, 150 is what a
// Stiletto does on a main road, and the gap between those two columns is the
// thing the player is complaining about.
import { sweepBox, groups, GROUP, RAY_WALL } from '../src/physics/world.js';
import { clamp } from '../src/util/math.js';

/** Shortest signed angle between two headings. */
function angleWrap(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

window.__runKeepUp = async function (speeds = [90, 120, 150], seconds = 45, routes = 4) {
  return window.__keepUpSweep(null, speeds, seconds, routes);
};

/**
 * The same run with the spec or the driver patched, for comparing a change
 * against what is in the game inside one page session.
 *
 *   __keepUpSweep((d) => { d.limitScale = 3; })
 */
window.__keepUpSweep = async function (tweak, speeds = [90, 120, 150], seconds = 45, routes = 4) {
  // A sweep takes a couple of minutes, and nothing about window.__res says
  // whether the answer in it is this sweep's or the last one's. Two settings
  // were compared without this and came back identical, correctly: it was the
  // same string read twice. Worse, a second sweep was started on top of a
  // running one, and both were then driving the same game.
  if (window.__keepUpBusy) return 'busy: a sweep is already running';
  window.__keepUpBusy = true;
  window.__res = null;
  try {
    await ready();
    const rows = [];
    for (const kph of speeds) {
      // Several different routes, because one is not a measurement. A run is
      // exactly repeatable -- same roads, same start, same answer -- so
      // repeating it tells you nothing, and the differences being looked for
      // here are smaller than the difference between two bits of town.
      let mean = 0, within = 0, behind = 0, hits = 0, worst = 0, sliding = 0, spins = 0;
      let hard = 0, wrecked = 0;
      const what = { tree: 0, building: 0, other: 0 };
      const bind = {};
      let lat = 0, wide = 0, drifting = 0, off = 0, offBad = 0;
      for (let i = 0; i < routes; i++) {
        const r = chase(kph, seconds, tweak, i);
        mean += r.mean; within += r.within; behind += r.behind; hits += r.hits;
        sliding += r.sliding; spins += r.spins; hard += r.hard; wrecked += r.wrecked;
        for (const k of Object.keys(what)) what[k] += r.what[k];
        for (const k of Object.keys(r.bind)) bind[k] = (bind[k] || 0) + r.bind[k];
        lat += r.lat; wide += r.wide; drifting += r.drifting;
        off += r.off; offBad += r.offBad;
        worst = Math.max(worst, r.damage);
        await new Promise((res) => setTimeout(res, 0));
      }
      rows.push(`ghost ${String(kph).padStart(3)} kph, ${routes} routes   `
        + `mean ${String(Math.round(mean / routes)).padStart(3)} kph   `
        + `with it ${String(Math.round((within / routes) * 100)).padStart(3)}%   `
        + `behind ${String(Math.round(behind / routes)).padStart(4)} m   `
        + `hits ${String(hits).padStart(3)}   hard ${String(hard).padStart(2)}   `
        + `wrecked ${wrecked}   trees ${String(what.tree).padStart(2)}   `
        + `walls ${String(what.building).padStart(2)}   worst damage ${worst.toFixed(2)}   `
        + `sliding ${String(Math.round((sliding / routes) * 100)).padStart(3)}%   `
        + `lost it ${spins}x`);
      const tot = Object.values(bind).reduce((a, b) => a + b, 0) || 1;
      rows.push(`    off the road ${Math.round((wide / routes) * 100)}%   `
        + `aim off ${((off / routes) * 57.3).toFixed(0)} deg `
        + `(badly ${Math.round((offBad / routes) * 100)}%)   `
        + `sideways ${Math.round((drifting / routes) * 100)}%   `
        + `tyre used in corners `
        + `${Math.round((lat / routes) * 100)}%   capped by `
        + Object.keys(bind).sort((a, b) => bind[b] - bind[a]).slice(0, 5)
          .map((k) => `${k} ${Math.round((bind[k] * 100) / tot)}%`).join(' '));
    }
    window.__res = rows.join('\n');
    return window.__res;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
    return window.__res;
  } finally {
    window.__keepUpBusy = false;
  }
};

/**
 * One setting after another in a single page session, in a single call -- see the
 * note on __weaveSweep. Results land in window.__sweep as they finish.
 */
window.__keepUpGripSweep = async function (values, tweak, speeds = [150], seconds = 40, routes = 4) {
  window.__sweep = [];
  window.__sweepDone = false;
  for (const x of values) {
    await window.__keepUpSweep((d, o, v) => tweak(d, o, v, x), speeds, seconds, routes);
    for (const row of window.__res.split('\n')) {
      window.__sweep.push(`${String(x).padStart(6)}  ${row}`);
    }
  }
  window.__sweepDone = true;
  window.__res = window.__sweep.join('\n');
  return window.__res;
};

/** An impact above this is a crash rather than a scrape. */
const HARD = 25;

/** Trees and the like, and buildings, each on their own. */
const PROPS_ONLY = groups(0xFFFF, GROUP.PROP);

async function ready() {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A long route through the road network, the same one every time.
 *
 * Along the roads' own polylines, not from junction to junction. The first
 * version of this strung the node positions together, which is a chord across
 * every bend -- so the ghost spent much of the run off the carriageway and
 * cut corners no car would take. Anything measured against that is measuring
 * a pursuit of something that is not driving on the road, and the first
 * attempt at a fix was judged against exactly that.
 */
function route(which = 0) {
  const g = window.__game;
  const gr = g.graph;
  if (!window.__keepUpRoutes) window.__keepUpRoutes = {};
  if (window.__keepUpRoutes[which]) return window.__keepUpRoutes[which];
  // Deliberately not the game's rng: this has to be the same roads whatever
  // else has happened in the session before it.
  let seed = 20260102 + which * 7919;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let node = gr.nodes[Math.floor(rnd() * gr.nodes.length)];
  const pts = [{ x: node.x, z: node.z }];
  let from = null;
  for (let leg = 0; leg < 60; leg++) {
    const options = [];
    for (const id of node.edges) {
      const e = gr.edges[id];
      const other = gr.nodes[e.a === node.id ? e.b : e.a];
      if (other && (!from || other.id !== from.id)) options.push({ e, other });
    }
    if (!options.length) break;
    const pick = options[Math.floor(rnd() * options.length)];
    // The edge's own points, in the direction of travel, so the ghost follows
    // the road round its bends instead of cutting across them.
    const line = pick.e.a === node.id ? pick.e.points : pick.e.points.slice().reverse();
    for (let i = 1; i < line.length; i++) pts.push({ x: line[i].x, z: line[i].z });
    from = node;
    node = pick.other;
  }
  window.__keepUpRoutes[which] = pts;
  return pts;
}

function chase(kph, seconds, tweak, which) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;

  const pts = route(which);
  const speed = kph / 3.6;
  const p = g.player;
  p.repair();
  p.teleport({ x: pts[0].x, y: 0.9, z: pts[0].z }, 0);
  p._readState();

  const units = [];
  for (const off of [-4, 4]) {
    const car = g.createVehicle('interceptor', 'interceptor',
      { x: pts[0].x + off, y: 0.95, z: pts[0].z - 12 }, 0, { police: true });
    if (!car) continue;
    const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
    o.setRole(ROLE.PURSUE);
    o.driver.allowOffRoad = true;
    car._readState();
    car.setVelocity({ x: 0, y: 0, z: 0 });
    units.push(o);
  }

  // Carry the ghost along the route at a fixed speed.
  let leg = 0, along = 0, lastAt = new Map();
  let lastHead = null, yaw = 0;
  let n = 0, sum = 0, within = 0, hits = 0;
  // Sideways and spun. Contacts do not measure "they slide out and lose
  // control": a unit can spin, gather it up and carry on without touching
  // anything, and that is still the complaint.
  let sliding = 0, spins = 0;
  const spinning = new Map();
  // A scrape and a crash are not the same event and "hits" counts both. What a
  // player calls crashing is a car hitting something hard enough to stop it, or
  // being wrecked outright, so those are counted apart.
  let hard = 0, wrecked = 0;
  const dead = new Set();
  // Which limit is in force, and how much of the tyre is actually being used.
  // "I don't know why they don't go faster through the turns. Do they have like
  // 100% grip?" They have about 94% of it close up and more than 100% at range, so
  // if they are slow through a corner the cornering limit is not what is doing it --
  // and this says what is.
  const bind = {};
  let latSum = 0, latN = 0;
  // Running wide, which is what "they overshoot turn-ins and keep going off route"
  // looks like from the outside: time spent off the carriageway, and time spent
  // genuinely sideways, which is the drift the assist is meant to produce.
  let wide = 0, drifting = 0;
  // Off the carriageway is not the same thing as off line. A unit cutting a
  // corner across a verge is off the carriageway and doing exactly what it
  // should; one that overshot a turn-in is pointing somewhere its target is not.
  // So: the pure-pursuit aim angle, mean and the share of frames past 35 degrees,
  // which is what overshooting a turn-in looks like from the numbers.
  let offSum = 0, offN = 0, offBad = 0;
  // What they hit, not just how often. takeImpact only gets the speed change, so
  // attribution happens here: at the moment of a knock, look round the car with a
  // props-only mask and a buildings-only one and see which is closer. Crude, and
  // enough to tell a tree from a wall, which is the question.
  const what = { tree: 0, building: 0, other: 0 };
  const DIRS = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    { x: 0.7, y: 0, z: 0.7 }, { x: -0.7, y: 0, z: 0.7 },
    { x: 0.7, y: 0, z: -0.7 }, { x: -0.7, y: 0, z: -0.7 },
  ];
  const blame = (v) => {
    const o = { x: v.position.x, y: v.position.y + 0.5, z: v.position.z };
    let tree = 99, wall = 99;
    for (const d of DIRS) {
      tree = Math.min(tree, sweepBox(v.world, o, d, 4, PROPS_ONLY, v.body, 0.3));
      wall = Math.min(wall, sweepBox(v.world, o, d, 4, RAY_WALL, v.body, 0.3));
    }
    if (tree < 4 && tree <= wall) what.tree++;
    else if (wall < 4) what.building++;
    else what.other++;
  };
  for (let i = 0; i < seconds * 60; i++) {
    const a = leg === 0 ? pts[0] : pts[leg - 1];
    const b = pts[leg];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    along += speed / 60;
    while (along > len && leg < pts.length - 1) { along -= len; leg++; }
    if (leg >= pts.length - 1) break;
    const t = Math.min(1, along / len);
    let x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const hx = (b.x - a.x) / len, hz = (b.z - a.z) / len;
    // Weaving, for the case the pursuit actually has trouble with: a target
    // holding a perfect line never asks a unit to change its mind, and a
    // player never holds one. The swerve is a few metres either side of the
    // lane, which is what overtaking parked cars and clipping apexes looks
    // like from behind.
    if (window.__keepUpWeave) {
      const sway = Math.sin(i / 38) * window.__keepUpWeave;
      x += -hz * sway;
      z += hx * sway;
    }
    const head = Math.atan2(hx, hz);
    p.teleport({ x, y: 0.9, z }, head);
    // Velocity first, then read the state off it: the other way round leaves
    // forwardSpeed derived from the velocity teleport had just cleared, and the
    // ghost reads as stationary to anything that asks how fast it is going.
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    // And the yaw rate its own path implies, because teleport leaves it at zero and
    // a ghost with no yaw rate is a car that never appears to be turning. Anything
    // that predicts where the target is going -- Officer._leadAim -- reads this, so
    // without it the rigs could not have seen a cornering lead at all.
    // Smoothed, because the route is a polyline and its corners are instant: the
    // raw frame-to-frame heading change spikes to several radians a second where
    // two segments meet, which no car does. A real yaw rate builds and decays, and
    // feeding the unsmoothed version to anything that predicts the target's line
    // judges it on a jerk rather than a corner.
    const raw = lastHead === null ? 0 : angleWrap(head - lastHead) * 60;
    lastHead = head;
    yaw += (clamp(raw, -3, 3) - yaw) * 0.12;
    p.body.setAngvel({ x: 0, y: yaw, z: 0 }, true);
    p._readState();

    g.heat.value = 5;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(hx * speed, 0, hz * speed);
    k.confidence = 1;

    // After the officer's update, not before it: Officer.update writes
    // allowOffRoad, arcFloor and limitScale onto the driver every frame, so a
    // tweak applied once at spawn is overwritten before it is ever read. A
    // whole sweep of arcFloor values was measured that way and came back as
    // noise, because none of them were in force.
    for (const o of units) {
      o.update(1 / 60, p);
      if (tweak) tweak(o.driver, o, o.vehicle);
    }
    g.stepHeadless(1 / 60);

    let near = Infinity;
    for (const o of units) {
      n++;
      sum += o.vehicle.speed * 3.6;
      near = Math.min(near, o.distanceTo(p.position));
      const v = o.vehicle;
      const c = o.driver.caps;
      if (c) {
        let who = 'asked', low = c.asked;
        for (const key of ['safe', 'wall', 'way', 'slide']) {
          if (c[key] < low - 0.01) { low = c[key]; who = key; }
        }
        if (who === 'safe') {
          let w2 = 'sClear', l2 = c.sClear;
          for (const key of ['sTravel', 'sRunout', 'sArc', 'sBack']) {
            if (c[key] < l2 - 0.01) { l2 = c[key]; w2 = key; }
          }
          who = w2.slice(1);
        }
        bind[who] = (bind[who] || 0) + 1;
      }
      // Lateral acceleration as a share of what the tyres can give, while the car
      // is actually turning. One is the limit; well under one and the corner is
      // being taken slowly for some reason other than grip.
      if (v.speed > 8 && Math.abs(v.yawRate) > 0.08) {
        const lat = Math.abs(v.yawRate * v.speed);
        latSum += lat / Math.max(1, o.driver._mu() * 9.81);
        latN++;
      }
      let onRoad = 0;
      for (const wh of v.wheels) if (wh.surface === 1) onRoad++;
      if (onRoad < 3) wide++;
      if (v.speed > 8) {
        const off = Math.abs(o.driver.aimError || 0);
        offSum += off; offN++;
        if (off > 0.6) offBad++;
      }
      const slip = Math.abs(v.slipAngleBody);
      if (slip > 0.22 && v.speed > 8) drifting++;
      if (slip > 0.22 && v.speed > 5) sliding++;
      if (slip > 1.0 && v.speed > 5) {
        if (!spinning.get(o)) { spins++; spinning.set(o, true); }
      } else if (slip < 0.5) spinning.set(o, false);
      if (v.lastImpactAt && v.lastImpactAt !== lastAt.get(o) && v.lastImpact > 4) {
        lastAt.set(o, v.lastImpactAt);
        hits++;
        if (v.lastImpact > HARD) hard++;
        blame(v);
      }
      if (v.damage >= 0.99 && !dead.has(o)) { dead.add(o); wrecked++; }
    }
    if (near < 60) within++;
  }

  const behind = units.map((o) => Math.round(o.distanceTo(p.position)));
  const damage = units.map((o) => +o.vehicle.damage.toFixed(2));
  // Through despawnPolice, not removeVehicle: the callsign has to go back in
  // the pool. These rigs make officers by hand, and over a session of sweeps
  // they had taken all 199 of them -- after which every unit in the game is
  // U0, and the soak's duplicate-callsign check fails on a game that is
  // perfectly healthy. A test that cries wolf is worse than no test.
  for (const o of units) g.despawnPolice(o);
  g.paused = false;
  g.heat.reset();

  return {
    hard,
    wrecked,
    what,
    bind,
    lat: latN ? latSum / latN : 0,
    wide: wide / Math.max(1, n),
    off: offN ? offSum / offN : 0,
    offBad: offN ? offBad / offN : 0,
    drifting: drifting / Math.max(1, n),
    sliding: sliding / Math.max(1, n),
    spins,
    mean: sum / Math.max(1, n),
    within: (within * 2) / Math.max(1, n),
    behind: (behind[0] + (behind.length > 1 ? behind[1] : behind[0])) / 2,
    hits,
    damage: Math.max.apply(null, damage),
  };
}
