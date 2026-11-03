// A police car across open ground, with nothing to avoid.
//
// "They're kind of a bit slow. Like, they should be really fast on the rolling
// hills. There's nothing for them to avoid, really."
//
// Finds the longest straight lines on Haldon Vale that are grass all the way and
// clear of everything a good way either side, stops the player at the far end,
// and lets one interceptor drive its pursuit along it from a standstill. Each
// second: speed, throttle, wheels down, what limited it and what it saw.
import { sweepBox, RAY_GROUNDS, groups, GROUP } from '../src/physics/world.js';

const PROPS = groups(0xFFFF, GROUP.PROP);

function lines(g, n, want) {
  const out = [], gy = (x, z) => (g.groundAt ? g.groundAt(x, z) : 0);
  let seed = 90210;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let tries = 0; tries < 4000 && out.length < n; tries++) {
    const x = (rnd() - 0.5) * 1800, z = (rnd() - 0.5) * 1800, a = rnd() * Math.PI * 2;
    const dx = Math.sin(a), dz = Math.cos(a);
    let ok = true;
    for (let t = 0; t <= want && ok; t += 10) {
      const px = x + dx * t, pz = z + dz * t;
      if (g.sim.surfaceAt(px, pz) !== 0) ok = false;
    }
    if (!ok) continue;
    const o = { x, y: gy(x, z) + 1.5, z };
    if (sweepBox(g.world, o, { x: dx, y: 0, z: dz }, want, RAY_GROUNDS, null, 6) < want) continue;
    out.push({ x, z, a, dx, dz });
  }
  return out;
}

window.__runOpenField = async function (runs = 3, want = 450, seconds = 20, verbose = true) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;
    const gy = (x, z) => (g.groundAt ? g.groundAt(x, z) : 0);
    const rows = [];
    const found = lines(g, runs, want);
    rows.push(`${found.length} clear lines of ${want} m`);
    for (const l of found) {
      const p = g.player;
      const tx = l.x + l.dx * want, tz = l.z + l.dz * want;
      p.repair();
      p.teleport({ x: tx, y: gy(tx, tz) + 0.9, z: tz }, 0);
      p._readState();
      const car = g.createVehicle('interceptor', 'interceptor', { x: l.x, y: gy(l.x, l.z) + 0.95, z: l.z }, l.a, { police: true });
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.PURSUE);
      o.driver.allowOffRoad = true;
      car._readState();
      let top = 0, sum = 0, n = 0, at = 0, air = 0;
      const tally = {};
      for (let i = 0; i < seconds * 60; i++) {
        p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
        o.update(1 / 60, p);
        g.stepHeadless(1 / 60);
        top = Math.max(top, car.speed);
        const down = car.wheels.filter((w) => w.grounded).length;
        if (down < 2) air++;
        sum += car.speed; n++;
        const d = o.driver, c = d.caps || {};
        const cand = { safeClear: c.sClear, safeTravel: c.sTravel, runout: c.sRunout, arc: c.sArc, wall: c.wall, slide: c.slide, way: c.way };
        let who = 'asked', low = c.asked === undefined ? d.speedTarget : c.asked;
        for (const k of Object.keys(cand)) if (cand[k] < low - 0.01) { low = cand[k]; who = k; }
        tally[who] = (tally[who] || 0) + 1;
        if (verbose && i % 90 === 0) {
          const ctl = car.controls;
          rows.push(`  t${String(i / 60).padStart(2)} ${String(Math.round(car.speed * 3.6)).padStart(3)} km/h T${ctl.throttle.toFixed(1)} B${ctl.brake.toFixed(1)} S${ctl.steer.toFixed(2)} down ${down} asked ${Math.round((c.asked || 0) * 3.6)} clear ${(+d._clear).toFixed(0)} wall ${(+d.wallNear).toFixed(0)} tree ${d.treeNear === Infinity ? '-' : (+d.treeNear).toFixed(0)} ${who} ${Math.round(low * 3.6)} mode ${o._mode}`);
        }
        const left = Math.hypot(car.position.x - tx, car.position.z - tz);
        if (left < 40) { at = (i + 1) / 60; break; }
        if (i % 120 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const tot = Object.values(tally).reduce((a, b) => a + b, 0) || 1;
      rows.push(`line: top ${Math.round(top * 3.6)} km/h, mean ${Math.round((sum / n) * 3.6)} km/h, ${at ? `there in ${at.toFixed(1)} s` : 'not there'}, ${Math.round((air / n) * 100)}% off the ground, limited by ${Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, 4).map((k) => `${k} ${Math.round((tally[k] * 100) / tot)}%`).join(' ')}`);
      g.removeVehicle(car);
    }
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 400)];
  }
};
