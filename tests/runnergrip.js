// The first car on the grass and on the road, as settings to compare.
//
// "Can you make it to the first car we ever made ... has a bit more grip off-road and just, you
// know, handles a little bit better, because otherwise the police are just so good now. It has no
// chance." Same place, same controls, one setting at a time:
//
//   await import('/tests/runnergrip.js');
//   await __runRunnerGrip({ offRoadGrip: 1.9 });
//
// lat    mean lateral g held at that speed, on a fixed steering command
// slip   mean body slip while doing it, degrees: how far sideways the car is
// stop   full brake from 100 km/h, m
// run    0 to 100 km/h, s
import { SPECS } from '../src/game/vehicles.js';
import { boxesNear } from '../src/ai/localplan.js';

function solidNear(g, x, z, r) {
  for (const b of boxesNear(g, x, z, r)) {
    const dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
    if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < r) return true;
  }
  return false;
}

function grassSpot(g) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 4000; i++) {
    const x = (rnd() - 0.5) * 1400, z = (rnd() - 0.5) * 1400;
    let ok = true;
    for (let a = 0; a < 16 && ok; a++) {
      const t = (a / 16) * Math.PI * 2;
      for (const r of [0, 20, 40, 60]) {
        const px = x + Math.sin(t) * r, pz = z + Math.cos(t) * r;
        if (g.sim.surfaceAt(px, pz) !== 0) { ok = false; break; }
        if (Math.abs(g.sim.heightAt(px, pz) - g.sim.heightAt(x, z)) > 5) { ok = false; break; }
      }
    }
    if (ok && !solidNear(g, x, z, 60)) return { x, z };
  }
  return null;
}

window.__runRunnerGrip = async function (patch = null) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    const v = g.player;
    const spec = patch ? Object.assign({}, SPECS.runner, patch) : SPECS.runner;
    v.spec = spec;
    const grass = grassSpot(g);
    const e = g.graph.edges.filter((x) => !x.cut && x.points && x.points.length > 3)
      .map((x) => {
        const a = x.points[0], b = x.points[x.points.length - 1];
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
      }).filter((x) => g.sim.surfaceAt(x.a.x, x.a.z) !== 0)
      .sort((m, n) => n.len - m.len)[0];
    const roadH = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
    let ctl = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const step = () => {
      g.heat.value = 0;
      v.setControls(ctl);
      g.stepHeadless(1 / 60, ctl);
    };
    const place = (x, z, h, kph) => {
      v.repair();
      v.teleport({ x, y: g.sim.heightAt(x, z) + 0.9, z }, h);
      const s = kph / 3.6;
      v.setVelocity({ x: Math.sin(h) * s, y: 0, z: Math.cos(h) * s });
      v._readState();
      for (let i = 0; i < 12; i++) { ctl = { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 }; step(); }
    };
    const rows = [];
    const at = (name, x, z, h) => {
      const parts = [];
      for (const [kph, steer] of [[50, 0.8], [80, 0.8], [110, 0.8]]) {
        place(x, z, h, kph);
        let lat = 0, slip = 0, n = 0, was = Math.atan2(v.linvel.x, v.linvel.z);
        for (let i = 0; i < 80; i++) {
          const err = kph / 3.6 - Math.abs(v.forwardSpeed);
          ctl = { throttle: Math.max(0, Math.min(1, err * 0.4)), brake: 0, steer, handbrake: 0 };
          step();
          // How fast the way it is going is turning, times its speed: the sideways g it really pulled.
          const now = Math.atan2(v.linvel.x, v.linvel.z);
          let d = now - was; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
          was = now;
          if (i > 25) { lat += Math.abs(d * 60 * v.speed); slip += Math.abs(v.slipAngleBody || 0); n++; }
        }
        parts.push(`${kph}: ${(lat / n / 9.81).toFixed(2)} g, slip ${((slip / n) * 57.3).toFixed(1)}`);
      }
      place(x, z, h, 100);
      const sx = v.position.x, sz = v.position.z;
      for (let i = 0; i < 480 && v.speed > 0.5; i++) { ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 0 }; step(); }
      const stop = Math.hypot(v.position.x - sx, v.position.z - sz);
      place(x, z, h, 0);
      let run = null;
      for (let i = 0; i < 900 && run === null; i++) { ctl = { throttle: 1, brake: 0, steer: 0, handbrake: 0 }; step(); if (v.speed > 100 / 3.6) run = i / 60; }
      rows.push(`${name}: ${parts.join(' | ')} | stop ${stop.toFixed(0)} m | 0-100 ${run === null ? '-' : run.toFixed(1)} s`);
    };
    if (grass) at('grass', grass.x, grass.z, 0.7); else rows.push('no grass spot');
    at('road', e.a.x, e.a.z, roadH);
    v.spec = SPECS.runner;
    window.__res = rows.join('\n');
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
  return window.__res;
};
