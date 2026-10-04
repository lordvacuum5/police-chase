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
      let mean = 0, within = 0, behind = 0, hits = 0, worst = 0;
      for (let i = 0; i < routes; i++) {
        const r = chase(kph, seconds, tweak, i);
        mean += r.mean; within += r.within; behind += r.behind; hits += r.hits;
        worst = Math.max(worst, r.damage);
        await new Promise((res) => setTimeout(res, 0));
      }
      rows.push(`ghost ${String(kph).padStart(3)} kph, ${routes} routes   `
        + `mean ${String(Math.round(mean / routes)).padStart(3)} kph   `
        + `with it ${String(Math.round((within / routes) * 100)).padStart(3)}%   `
        + `behind ${String(Math.round(behind / routes)).padStart(4)} m   `
        + `hits ${String(hits).padStart(3)}   worst damage ${worst.toFixed(2)}`);
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
  let n = 0, sum = 0, within = 0, hits = 0;
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
    p.teleport({ x, y: 0.9, z }, Math.atan2(hx, hz));
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });

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
      if (v.lastImpactAt && v.lastImpactAt !== lastAt.get(o) && v.lastImpact > 4) {
        lastAt.set(o, v.lastImpactAt);
        hits++;
      }
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
    mean: sum / Math.max(1, n),
    within: (within * 2) / Math.max(1, n),
    behind: (behind[0] + (behind.length > 1 ? behind[1] : behind[0])) / 2,
    hits,
    damage: Math.max.apply(null, damage),
  };
}
