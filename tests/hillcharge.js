// A police car driven flat out straight up every steep slope on the map.
//
// "One almost hit an invisible wall when it was going up a hill and just bounced back." Nobody
// steering and nobody braking, so anything that takes the speed is the car against the ground. Finds
// the steepest ground, runs at it from 40 m below at full throttle, and says what happened in the
// next 2.5 s. `stopped`: more than a quarter of its speed gone in 0.2 s.
//
//   await import('/tests/hillcharge.js');
//   await __runHillCharge(150, 40);
import { boxesNear } from '../src/ai/localplan.js';

function solidNear(g, x, z, r) {
  for (const b of boxesNear(g, x, z, r)) {
    const dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
    if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < r) return true;
  }
  return false;
}

function slopeAt(g, x, z) {
  const e = 3, h = (a, b) => g.sim.heightAt(a, b);
  const dx = (h(x + e, z) - h(x - e, z)) / (2 * e), dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
  return { s: Math.hypot(dx, dz), dx, dz };
}

window.__runHillCharge = async function (kph = 150, spots = 40, keep = null) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    g.heat.value = 0;
    let seed = 91;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const all = [];
    for (let i = 0; i < 9000; i++) {
      const x = (rnd() - 0.5) * 1500, z = (rnd() - 0.5) * 1500;
      const sl = slopeAt(g, x, z);
      if (sl.s > 0.12 && sl.s < 0.8) all.push({ x, z, ...sl });
    }
    all.sort((a, b) => b.s - a.s);
    // Well spread out, and clear on the way up.
    const pick = [];
    for (const a of all) {
      if (pick.length >= spots) break;
      if (pick.some((b) => Math.hypot(a.x - b.x, a.z - b.z) < 50)) continue;
      const k = 1 / a.s;
      const ux = a.dx * k, uz = a.dz * k;
      let clear = true;
      for (let d = -40; d <= 40 && clear; d += 10) if (solidNear(g, a.x + ux * d, a.z + uz * d, 4)) clear = false;
      if (clear) pick.push({ ...a, ux, uz });
    }
    if (!pick.length) { window.__res = `no clear slope in ${all.length}`; return window.__res; }
    const idle = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    p.teleport({ x: 900, y: g.sim.heightAt(900, 900) + 2, z: 900 }, 0);
    const u = g.spawnPoliceNear({ x: pick[0].x, y: 0, z: pick[0].z }, 5);
    const v = u.vehicle;
    v.assist.shielded = false;
    if (keep) keep(v);
    const speed = kph / 3.6;
    let stopped = 0, flipped = 0, worst = [], lost = 0;
    const rows = [];
    for (const a of pick) {
      v.repair();
      const sx = a.x - a.ux * 40, sz = a.z - a.uz * 40;
      const h = Math.atan2(a.ux, a.uz);
      v.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, h);
      v.setVelocity({ x: a.ux * speed, y: 0, z: a.uz * speed });
      v._readState();
      const hs = [];
      let worstDrop = 0, at = null, minUp = 1, keel = 0, body = 0, maxVy = -99, ground0 = 0;
      for (let i = 0; i < 150; i++) {
        v.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
        g.heat.value = 0;
        g.stepHeadless(1 / 60, idle);
        const s = Math.hypot(v.linvel.x, v.linvel.z);
        hs.push(s);
        minUp = Math.min(minUp, v.up.y);
        maxVy = Math.max(maxVy, v.linvel.y);
        if (v.grounded === 0) ground0++;
        for (const c of v.keel ? [v.collider, v.keel] : [v.collider]) {
          v.world.contactPairsWith(c, (o) => {
            if (o === v.collider || o === v.keel) return;
            let t = false;
            v.world.contactPair(c, o, (m) => { if (m.numContacts() > 0) t = true; });
            if (t) { if (c === v.keel) keel++; else body++; }
          });
        }
        if (i >= 12 && hs[i - 12] > 8) {
          const drop = 1 - s / hs[i - 12];
          if (drop > worstDrop) {
            worstDrop = drop;
            at = { t: +(i / 60).toFixed(2), from: Math.round(hs[i - 12] * 3.6), to: Math.round(s * 3.6), slope: +(slopeAt(g, v.position.x, v.position.z).s * 100).toFixed(0), vy: +v.linvel.y.toFixed(1), y: +(v.position.y - g.sim.heightAt(v.position.x, v.position.z)).toFixed(2), imp: +(v.lastImpact || 0).toFixed(0), up: +v.up.y.toFixed(2), wheels: v.grounded };
          }
        }
      }
      const isStop = worstDrop > 0.25;
      if (isStop) stopped++;
      if (minUp < 0.2) flipped++;
      lost += hs.length ? 1 - hs[hs.length - 1] / speed : 0;
      worst.push({ drop: +worstDrop.toFixed(2), slope: +(a.s * 100).toFixed(0), at, minUp: +minUp.toFixed(2), keel, body, air: +(ground0 / 60).toFixed(2), maxVy: +maxVy.toFixed(1), where: [Math.round(a.x), Math.round(a.z)] });
      await new Promise((r) => setTimeout(r, 0));
    }
    worst.sort((m, n) => n.drop - m.drop);
    rows.push(`${pick.length} slopes (steepest ${(pick[0].s * 100).toFixed(0)}%) at ${kph} km/h: thrown back ${stopped}, on its roof or side ${flipped}, mean speed lost by the end ${Math.round((lost / pick.length) * 100)}%, mean air ${(worst.reduce((s, x) => s + x.air, 0) / pick.length).toFixed(2)} s, up to ${Math.max(...worst.map((x) => x.maxVy))} m/s upward`);
    for (const w of worst.slice(0, 8)) rows.push(JSON.stringify(w));
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  return window.__res;
};
