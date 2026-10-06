// Do they hit the trees?
//
// "They still seem to crash into trees a lot... I wonder if they don't know the
// size of their cars."
//
// They know their size: the probes sweep a plate the car's own width and start it
// within four centimetres of the real nose. What went wrong was what the probes
// were allowed to see. Trees are GROUP.PROP, and a tree is deliberately not a thing
// to brake for -- counting them in the last-resort wall clamp had units crawling
// through anywhere wooded -- but they must still be seen by the clamp that decides
// what speed the route ahead can be taken at. Probed directly at a trunk 29 m away,
// RAY_SOLID reported the full 60 m clear.
//
// The road rigs cannot measure this. Their routes are on roads, so what gets hit
// there is kerbs and other police cars: at a 150 km/h ghost, seventeen contacts
// over four routes and not one of them a tree or a building. So this drives a chase
// straight through the densest wood on the map and counts what it touches.
//
//   hits        contacts above a knock, split into trees and everything else
//   mean        the unit's average speed, because braking for every trunk is its
//               own kind of failure -- the wood is supposed to be crossed
//   stopped     share of the run under 15 km/h
import { sweepBox, groups, GROUP } from '../src/physics/world.js';

const PROPS = groups(0xFFFF, GROUP.PROP);

/** Trunks, by collision group rather than by guessing their dimensions. */
function trunks() {
  const g = window.__game;
  const out = [];
  g.world.forEachCollider((c) => {
    const member = c.collisionGroups ? (c.collisionGroups() >>> 16) : 0;
    if (!(member & GROUP.PROP)) return;
    const t = c.translation();
    out.push({ x: t.x, z: t.z });
  });
  return out;
}

/** The densest patch of them, which is where a chase gets interesting. */
function copse() {
  if (window.__copse) return window.__copse;
  const pts = trunks();
  let best = null;
  for (let i = 0; i < pts.length; i += 3) {
    const a = pts[i];
    let n = 0;
    for (const b of pts) {
      const dx = b.x - a.x, dz = b.z - a.z;
      if (dx * dx + dz * dz < 2500) n++;              // within 50 m
    }
    if (!best || n > best.n) best = { x: a.x, z: a.z, n };
  }
  window.__copse = best;
  return best;
}

window.__runTrees = async function (kph = 80, tweak = null, label = '', runs = 6) {
  window.__treesDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const site = copse();
    if (!site || site.n < 8) { window.__res = 'no wood on this map'; window.__treesDone = true; return window.__res; }

    const rows = [];
    let hits = 0, trees = 0, spd = 0, stopped = 0, n = 0;
    for (let i = 0; i < runs; i++) {
      const r = run(site, i, kph, tweak);
      if (!r) continue;
      n++;
      hits += r.hits; trees += r.trees; spd += r.spd; stopped += r.stopped;
      rows.push(r.line);
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${label ? label + '  ' : ''}${n} crossings of a wood ${site.n} trunks thick:  `
      + `hits ${hits} (trees ${trees})  mean ${Math.round(spd / n)} kph  `
      + `stopped ${Math.round((stopped * 100) / n)}%`);
    window.__res = rows.join('\n');
    window.__treesDone = true;
    return window.__res;
  } catch (e) {
    window.__treesDone = true;
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

  // A line straight across the wood, at a different angle each run.
  const ang = (which / 6) * Math.PI * 2;
  const ux = Math.sin(ang), uz = Math.cos(ang);
  const speed = kph / 3.6;
  const start = { x: site.x - ux * 150, z: site.z - uz * 150 };

  const p = g.player;
  p.repair();
  p.teleport({ x: start.x, y: 0.9, z: start.z }, ang);
  p.setVelocity({ x: ux * speed, y: 0, z: uz * speed });
  p._readState();

  const car = g.createVehicle('interceptor', 'interceptor',
    { x: start.x - ux * 25, y: 0.95, z: start.z - uz * 25 }, ang, { police: true });
  if (!car) { g.paused = false; return null; }
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  o.setRole(ROLE.PURSUE);
  o.driver.allowOffRoad = true;
  car.setVelocity({ x: ux * speed, y: 0, z: uz * speed });
  car._readState();

  const DIRS = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    { x: 0.7, y: 0, z: 0.7 }, { x: -0.7, y: 0, z: 0.7 },
    { x: 0.7, y: 0, z: -0.7 }, { x: -0.7, y: 0, z: -0.7 },
  ];
  const nearATree = () => {
    const at = { x: car.position.x, y: car.position.y + 0.5, z: car.position.z };
    for (const d of DIRS) {
      if (sweepBox(car.world, at, d, 4, PROPS, car.body, 0.3) < 4) return true;
    }
    return false;
  };

  let hits = 0, trees = 0, frames = 0, sum = 0, slow = 0, lastAt = 0, along = 0;
  for (let i = 0; i < 26 * 60; i++) {
    along += speed / 60;
    if (along > 300) break;
    p.teleport({ x: start.x + ux * along, y: 0.9, z: start.z + uz * along }, ang);
    p.setVelocity({ x: ux * speed, y: 0, z: uz * speed });
    p._readState();
    g.heat.value = 5;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(ux * speed, 0, uz * speed);
    k.confidence = 1;

    o.update(1 / 60, p);
    if (tweak) tweak(o.driver, o, car);
    g.stepHeadless(1 / 60);

    frames++;
    sum += car.speed * 3.6;
    if (car.speed * 3.6 < 15) slow++;
    if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
      lastAt = car.lastImpactAt;
      hits++;
      if (nearATree()) trees++;
    }
  }

  const dmg = car.damage;
  g.despawnPolice(o);
  g.paused = false;
  g.heat.reset();

  return {
    line: `  run ${which}  hits ${hits} (trees ${trees})  `
      + `mean ${Math.round(sum / Math.max(1, frames))} kph  `
      + `stopped ${Math.round((slow * 100) / Math.max(1, frames))}%  `
      + `damage ${dmg.toFixed(2)}`,
    hits,
    trees,
    spd: sum / Math.max(1, frames),
    stopped: slow / Math.max(1, frames),
  };
}
