// One tree, open ground, and a unit driving straight at it.
//
// "When one was chasing me, when I had outrun basically all of them, somehow it
// crashed into a tree. It was relatively far away from me. It was one tree, and it
// crashed into it. I had a 100% grip. How did it do that?"
//
// Grip was never the question. The avoidance in Driver._avoidScenery sweeps three
// boxes -- one down the line of travel and one twenty-four degrees either side --
// and steers toward whichever flank has more room:
//
//   bias = ((leftClear - rightClear) / reach) * urgency^2 * 2.4
//
// A tree dead ahead is inside all three sweeps, so both flanks report the same
// distance, the difference is zero, and the bias is zero. There is a tie-break for
// exactly this -- re-probe at sixty degrees -- but on open ground both of those
// come back at the full reach, so they are tied too. The car has a perfectly good
// measurement of a trunk twenty metres in front of it, no reason to prefer either
// side, and steers not one degree.
//
// A wood hides this. Trunks come in groups, so something is always closer on one
// side than the other and the difference is never zero; the copse rig in trees.js
// crosses a thirty-eight-trunk wood and the ties break themselves. It takes a tree
// standing on its own to produce the dead heat, which is why the one the player
// hit was a lone one.
//
//   hit         did it touch the trunk at all
//   miss by     closest approach, minus the clearance it needed
//   bias        the steering bias the avoidance produced on the way in
import { sweepBox, groups, GROUP } from '../src/physics/world.js';

const PROPS = groups(0xFFFF, GROUP.PROP);

/** Trunks, by collision group rather than by guessing their dimensions. */
function trunks() {
  const out = [];
  window.__game.world.forEachCollider((c) => {
    const member = c.collisionGroups ? (c.collisionGroups() >>> 16) : 0;
    if (!(member & GROUP.PROP)) return;
    const t = c.translation();
    out.push({ x: t.x, z: t.z });
  });
  return out;
}

/**
 * Trees with nothing else near them. The bug needs a dead heat between the
 * flanks, and anything else within a sweep's reach breaks it.
 */
function loners(clear = 30, want = 6) {
  if (window.__loners) return window.__loners;
  const pts = trunks();
  const out = [];
  for (const a of pts) {
    let alone = true;
    for (const b of pts) {
      if (b === a) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      if (dx * dx + dz * dz < clear * clear) { alone = false; break; }
    }
    if (alone) out.push(a);
    if (out.length >= want) break;
  }
  window.__loners = out;
  return out;
}

/**
 * The other half of the report: "when I had outrun basically all of them". A unit
 * at full stretch, sent a long way across country to a quarry it cannot see, which
 * is the case the lone-tree runs above do not reproduce -- they miss the tree every
 * time, at 80 and at 150. So this one does not aim at anything. It sends a unit
 * 400 m across the map and writes down the state of the car at the instant it
 * touches a trunk, which is the only way to stop guessing at the mechanism.
 */
window.__runCrossCountry = async function (kph = 150, runs = 8) {
  window.__loneDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    const rows = [];
    let hits = 0;
    const gr = g.graph;
    for (let i = 0; i < runs; i++) {
      g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
      g.onEscaped = () => { g.outcome = null; };
      g.paused = true;
      g.heat.value = 5;
      // Two nodes a long way apart, the same pair every time.
      let seed = 777 + i * 7919;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const a = gr.nodes[Math.floor(rnd() * gr.nodes.length)];
      let b = null;
      for (let k = 0; k < 400; k++) {
        const c = gr.nodes[Math.floor(rnd() * gr.nodes.length)];
        const d = Math.hypot(c.x - a.x, c.z - a.z);
        if (d > 380) { b = c; break; }
      }
      if (!b) continue;

      const p = g.player;
      p.repair();
      p.teleport({ x: b.x, y: 0.9, z: b.z }, 0);
      p.setVelocity({ x: 0, y: 0, z: 0 });
      p._readState();

      const car = g.createVehicle('interceptor', 'interceptor',
        { x: a.x, y: 0.95, z: a.z }, Math.atan2(b.x - a.x, b.z - a.z), { police: true });
      if (!car) continue;
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.PURSUE);
      o.driver.allowOffRoad = true;
      car._readState();

      let lastAt = 0;
      for (let f = 0; f < 45 * 60; f++) {
        g.heat.value = 5;
        const k = g.dispatcher.knowledge;
        k.seen = true; k.position.copy(p.position); k.velocity.set(0, 0, 0); k.confidence = 1;
        o.update(1 / 60, p);
        g.stepHeadless(1 / 60);
        if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
          lastAt = car.lastImpactAt;
          const at = { x: car.position.x, y: car.position.y + 0.5, z: car.position.z };
          let tree = 99;
          for (const d of DIRS) {
            tree = Math.min(tree, sweepBox(car.world, at, d, 4, PROPS, car.body, 0.3));
          }
          if (tree < 4) {
            hits++;
            const d = o.driver;
            const c = d.caps || {};
            const road = d._onCarriageway ? d._onCarriageway() : null;
            rows.push(`  trunk at ${Math.round(car.kmh)} kph  impact ${car.lastImpact.toFixed(0)}  `
              + `wallNear ${(d.wallNear || 0).toFixed(1)}  bias ${(d.wallBias || 0).toFixed(2)}  `
              + `on road ${road}  asked ${(c.asked || 0).toFixed(0)}  `
              + `clear ${(c.sClear === undefined ? -1 : c.sClear).toFixed(0)}  `
              + `arc ${(c.sArc === undefined ? -1 : c.sArc).toFixed(0)}  `
              + `wall ${(c.wall === undefined || c.wall === Infinity ? -1 : c.wall).toFixed(0)}  `
              + `path ${d.hasPath ? 'yes' : 'NO'}`);
          }
        }
        if (o.distanceTo(p.position) < 25) break;
      }
      g.removeVehicle(car);
      g.paused = false;
      g.heat.reset();
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${runs} cross-country runs: ${hits} trunk contacts`);
    window.__res = rows.join(NL);
    window.__loneDone = true;
    return window.__res;
  } catch (e) {
    window.__loneDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};

const NL = String.fromCharCode(10);

const DIRS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  { x: 0.7, y: 0, z: 0.7 }, { x: -0.7, y: 0, z: 0.7 },
  { x: 0.7, y: 0, z: -0.7 }, { x: -0.7, y: 0, z: -0.7 },
];

window.__runLoneTree = async function (kph = 80, tweak = null, label = '') {
  window.__loneDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const sites = loners();
    if (!sites.length) {
      window.__res = 'no isolated tree on this map';
      window.__loneDone = true;
      return window.__res;
    }
    const rows = [];
    let hit = 0, n = 0;
    for (let i = 0; i < sites.length; i++) {
      const r = run(sites[i], i, kph, tweak);
      if (!r || !r.reached) continue;
      n++;
      if (r.hit) hit++;
      rows.push(r.line);
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${label ? label + '  ' : ''}${n} lone trees driven at, ${kph} kph: `
      + `hit ${hit} of ${n}`);
    window.__res = rows.join('\n');
    window.__loneDone = true;
    return window.__res;
  } catch (e) {
    window.__loneDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};

function run(site, which, kph, tweak) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;
  g.heat.value = 5;

  // Straight at the trunk, from a different bearing each time so the answer is
  // not one lucky approach. The quarry sits well beyond it and stays put: this is
  // the "I had outrun basically all of them" case, where the unit is driving at a
  // position rather than fighting a car.
  const ang = (which / 6) * Math.PI * 2;
  const ux = Math.sin(ang), uz = Math.cos(ang);
  const speed = kph / 3.6;
  const start = { x: site.x - ux * 110, z: site.z - uz * 110 };

  const p = g.player;
  p.repair();
  // Close behind the trunk, not far past it: a quarry two hundred metres away is
  // one the unit routes to by road, and then the tree is not on its way at all.
  // Sixty metres makes the straight line the obvious line, which is the case
  // being asked about.
  p.teleport({ x: site.x + ux * 60, y: 0.9, z: site.z + uz * 60 }, ang);
  p.setVelocity({ x: 0, y: 0, z: 0 });
  p._readState();

  const car = g.createVehicle('interceptor', 'interceptor',
    { x: start.x, y: 0.95, z: start.z }, ang, { police: true });
  if (!car) { g.paused = false; return null; }
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  o.setRole(ROLE.PURSUE);
  o.driver.allowOffRoad = true;
  car._readState();
  car.setVelocity({ x: ux * speed, y: 0, z: uz * speed });

  const DIRS = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    { x: 0.7, y: 0, z: 0.7 }, { x: -0.7, y: 0, z: 0.7 },
    { x: 0.7, y: 0, z: -0.7 }, { x: -0.7, y: 0, z: -0.7 },
  ];
  const onAnyTree = () => {
    const at = { x: car.position.x, y: car.position.y + 0.5, z: car.position.z };
    for (const d of DIRS) {
      if (sweepBox(car.world, at, d, 3, PROPS, car.body, 0.3) < 3) return true;
    }
    return false;
  };

  let hit = false, closest = 999, bias = 0, lastAt = 0, reached = false;
  for (let i = 0; i < 16 * 60; i++) {
    g.heat.value = 5;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(0, 0, 0);
    k.confidence = 1;

    o.update(1 / 60, p);
    if (tweak) tweak(o.driver, o, car);
    g.stepHeadless(1 / 60);

    const dx = car.position.x - site.x, dz = car.position.z - site.z;
    const d = Math.hypot(dx, dz);
    closest = Math.min(closest, d);
    // The bias on the way in, while the trunk is still in front.
    if (d > 8 && d < 30) bias = Math.max(bias, Math.abs(o.driver.wallBias || 0));
    if (d < 40) reached = true;
    if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
      lastAt = car.lastImpactAt;
      // This trunk, not whatever else is about: a hit 90 m away is a different
      // tree and a different question.
      if (d < 6 && onAnyTree()) hit = true;
    }
    // Past it, or stopped dead in front of it.
    const past = (car.position.x - site.x) * ux + (car.position.z - site.z) * uz;
    if (past > 12) break;
    if (car.speed < 1 && i > 240) break;
  }

  const need = car.spec.dims.w * 0.5 + 0.7;
  const line = `  tree ${which}: ${reached ? (hit ? 'HIT' : 'missed') : 'never went near it'}  `
    + `closest ${closest.toFixed(1)} m (needed ${need.toFixed(1)})  `
    + `bias ${bias.toFixed(2)}`;
  g.removeVehicle(car);
  g.paused = false;
  g.heat.reset();
  return { hit, reached, line };
}
