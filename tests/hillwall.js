// The invisible wall, caught in the step it happens in.
//
// "There's still an issue with like almost going into, like hitting an invisible wall on the ground ... It's
// different spots of the map, but it's mainly really steep, pretty steep hills when you're going very fast."
// tests/hillcharge.js counts a car that loses a quarter of its speed in a fifth of a second, which also counts
// every tree it is aimed into (its clear-way check does not see the woods). This watches every physics step
// instead, and for the step that took the most speed says what the car was touching during it:
//
//   await import('/tests/hillwall.js');  await __runHillWall(200, 40, 'runner')   // then window.__res
//
//   wall      lost over 40 km/h in one physics step (after the car's own corrections) touching nothing but the ground (hill, plate) or nothing at all
//   object    the same with a tree, a wall, a car in it: a real thing, not the bug
//   worst     the biggest one-step losses, with what was touched and how far the springs were through
//
// `kind`: 'runner', 'supercar', 'offroad', or 'police' for an AI interceptor (with its keelKick).
import { boxesNear } from '../src/ai/localplan.js';
import { GROUP } from '../src/physics/world.js';

const gname = (m) => Object.entries(GROUP).filter(([, b]) => m & b).map(([k]) => k).join('+') || 'none';

function slopeAt(g, x, z) {
  const e = 3, h = (a, b) => g.sim.heightAt(a, b);
  const dx = (h(x + e, z) - h(x - e, z)) / (2 * e), dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
  return { s: Math.hypot(dx, dz), dx, dz };
}

function solidNear(g, x, z, r) {
  for (const b of boxesNear(g, x, z, r)) {
    const dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
    if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < r) return true;
  }
  return false;
}

export function steepSlopes(g, spots, seed0 = 91) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const all = [];
  for (let i = 0; i < 9000; i++) {
    const x = (rnd() - 0.5) * 1500, z = (rnd() - 0.5) * 1500;
    const sl = slopeAt(g, x, z);
    if (sl.s > 0.12 && sl.s < 0.8) all.push({ x, z, ...sl });
  }
  all.sort((a, b) => b.s - a.s);
  const pick = [];
  for (const a of all) {
    if (pick.length >= spots) break;
    if (pick.some((b) => Math.hypot(a.x - b.x, a.z - b.z) < 50)) continue;
    const k = 1 / a.s, ux = a.dx * k, uz = a.dz * k;
    let clear = true;
    for (let d = -40; d <= 40 && clear; d += 10) if (solidNear(g, a.x + ux * d, a.z + uz * d, 4)) clear = false;
    if (clear) pick.push({ ...a, ux, uz });
  }
  return pick;
}

window.__runHillWall = async function (kph = 200, spots = 40, kind = 'runner', seconds = 2.5) {
  window.__res = null;
  const g = window.__game;
  const ow = g.world.step.bind(g.world);
  try {
    const p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    if (g.traffic) g.traffic.clear();
    g.heat.value = 0;
    const pick = steepSlopes(g, spots);
    let v;
    if (kind === 'police') {
      p.teleport({ x: 900, y: g.sim.heightAt(900, 900) + 2, z: 900 }, 0);
      v = g.spawnPoliceNear({ x: pick[0].x, y: 0, z: pick[0].z }, 5).vehicle;
      v.assist.shielded = false;
    } else {
      if (p.specKey !== kind) {
        const old = p;
        g.player = g.createVehicle(kind, kind, { x: old.position.x, y: old.position.y + 1, z: old.position.z }, 0, {});
        g.removeVehicle(old);
      }
      v = g.player;
    }
    // Every step: the speed lost in it -- after the car's own corrections (Vehicle.postStep, where
    // _rideUpHill puts speed back), which is what the player feels -- and what the car touched during it.
    let watch = null, before = 0;
    g.world.step = (...a) => {
      const b0 = v.body.linvel();
      before = Math.hypot(b0.x, b0.z);
      ow(...a);
    };
    const op = v.postStep.bind(v);
    v.postStep = (dt) => {
      op(dt);
      if (!watch) return;
      const b1 = v.body.linvel();
      const lost = before - Math.hypot(b1.x, b1.z);
      if (lost * 3.6 < 15) return;
      const touched = new Set();
      for (const c of v.keel ? [v.collider, v.keel] : [v.collider]) {
        g.world.contactPairsWith(c, (o) => {
          if (o === v.collider || o === v.keel) return;
          g.world.contactPair(c, o, (m) => {
            if (m.numContacts() > 0) touched.add((c === v.keel ? 'keel:' : 'body:') + (o.__vehicle ? 'CAR' : gname((o.collisionGroups() >>> 16) & 0xFFFF)));
          });
        });
      }
      watch.push({ lost: Math.round(lost * 3.6), from: Math.round(before * 3.6), touched: [...touched], springs: +Math.max(...v.wheels.map((w) => w.compression / v.spec.suspension.travel)).toFixed(2), wheels: v.grounded, up: +v.up.y.toFixed(2), slope: Math.round(slopeAt(g, v.position.x, v.position.z).s * 100), at: [Math.round(v.position.x), Math.round(v.position.z)] });
    };
    const speed = kph / 3.6;
    let walls = 0, objects = 0;
    const worst = [];
    for (const a of pick) {
      v.repair();
      const sx = a.x - a.ux * 40, sz = a.z - a.uz * 40;
      v.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, Math.atan2(a.ux, a.uz));
      v.setVelocity({ x: a.ux * speed, y: 0, z: a.uz * speed });
      v._readState();
      watch = [];
      for (let i = 0; i < seconds * 60; i++) {
        v.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
        g.heat.value = 0;
        g.stepHeadless(1 / 60, kind === 'police' ? { throttle: 0, brake: 1, steer: 0, handbrake: 1 } : { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
      }
      const big = watch.filter((w) => w.lost >= 40);
      const ground = (w) => w.touched.every((t) => /HILL|TERRAIN|none/.test(t));
      if (big.some(ground)) walls++;
      else if (big.length) objects++;
      for (const w of big) worst.push(Object.assign({ slopeAt: Math.round(a.s * 100), wall: ground(w) }, w));
      watch = null;
      await new Promise((r) => setTimeout(r, 0));
    }
    worst.sort((m, n) => n.lost - m.lost);
    window.__res = [`${kind} at ${kph} km/h, ${pick.length} slopes: wall ${walls}, object ${objects}`]
      .concat(worst.filter((w) => w.wall).slice(0, 6).map((w) => JSON.stringify(w)))
      .concat(worst.filter((w) => !w.wall).slice(0, 4).map((w) => 'object ' + JSON.stringify(w))).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  g.world.step = ow;
  for (const v of g.vehicles) if (Object.prototype.hasOwnProperty.call(v, 'postStep')) delete v.postStep;
  return window.__res;
};
