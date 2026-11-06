// What full brakes and a sudden steer do to the computer's police car, on the flat, at speed.
//
// "It almost just looks like they almost just jolt." In a chase, half the frames round a jolt
// had two wheels down, and the speed going at 3-5 km/h a frame on full brake: 6 g.
//
//   await import('/tests/stoppie.js');
//   await __runStoppie();
import { drivablePoliceSpec } from '../src/game/vehicles.js';

window.__runStoppie = async function (kph = 140) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    const e = g.graph.edges.filter((x) => !x.cut && x.points && x.points.length > 3)
      .map((x) => {
        const a = x.points[0], b = x.points[x.points.length - 1];
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
      }).sort((m, n) => n.len - m.len)[0];
    const h = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
    const start = { x: e.a.x, y: g.sim.heightAt(e.a.x, e.a.z) + 0.9, z: e.a.z };
    p.teleport({ x: e.a.x + 400, y: g.sim.heightAt(e.a.x + 400, e.a.z) + 2, z: e.a.z + 400 }, 0);
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    g.heat.value = 0;
    const idle = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const u = g.spawnPoliceNear(start, 5);
    const v = u.vehicle;
    v.assist.shielded = false;
    const ai = v.spec;
    const speed = kph / 3.6;
    const rows = [];
    const run = (label, spec, control, frames, every) => {
      v.spec = spec;
      v.repair();
      v.teleport(start, h);
      v.setVelocity({ x: Math.sin(h) * speed, y: 0, z: Math.cos(h) * speed });
      v._readState();
      for (let i = 0; i < 40; i++) {
        v.setControls({ throttle: 0.6, brake: 0, steer: 0, handbrake: 0 });
        v.setVelocity({ x: Math.sin(h) * speed, y: v.linvel.y, z: Math.cos(h) * speed });
        g.heat.value = 0;
        g.stepHeadless(1 / 60, idle);
      }
      const out = [];
      let min = 4, liftF = 0, liftR = 0, maxYaw = 0, maxPitch = 0, first = v.speed, stopAt = null;
      for (let i = 0; i < frames; i++) {
        v.setControls(control(i));
        g.heat.value = 0;
        g.stepHeadless(1 / 60, idle);
        const f = (v.wheels[0].grounded ? 1 : 0) + (v.wheels[1].grounded ? 1 : 0);
        const r = (v.wheels[2].grounded ? 1 : 0) + (v.wheels[3].grounded ? 1 : 0);
        if (f < 2) liftF++;
        if (r < 2) liftR++;
        min = Math.min(min, f + r);
        maxYaw = Math.max(maxYaw, Math.abs(v.angvel.y));
        const pitch = Math.asin(Math.max(-1, Math.min(1, v.forward.y))) * 57.3;
        maxPitch = Math.max(maxPitch, Math.abs(pitch));
        if (stopAt === null && v.speed < 1) stopAt = i / 60;
        if (i % every === 0) out.push(`${Math.round(v.speed * 3.6)}k f${f}r${r} y${v.angvel.y.toFixed(2)} p${pitch.toFixed(1)}`);
      }
      const dec = (first - v.speed) / (frames / 60);
      rows.push(`${label}: from ${Math.round(first * 3.6)} km/h, mean ${(dec / 9.81).toFixed(1)} g over ${(frames / 60).toFixed(1)} s, least wheels ${min}, frames front up ${liftF} rear up ${liftR}, most yaw ${maxYaw.toFixed(2)}, most pitch ${maxPitch.toFixed(1)} deg${stopAt === null ? '' : `, stopped ${stopAt.toFixed(2)} s`}`);
      rows.push('   ' + out.join(' | '));
    };
    const full = () => ({ throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    const steer = (i) => ({ throttle: 0.6, brake: 0, steer: i < 30 ? 0.8 : 0, handbrake: 0 });
    const human = drivablePoliceSpec('interceptor');
    run('AI, full brake', ai, full, 30, 3);
    run('person\'s car, full brake', human, full, 30, 3);
    run('AI, steer 0.8 for 0.5 s', ai, steer, 60, 4);
    run('person\'s car, steer 0.8 for 0.5 s', human, steer, 60, 4);
    v.spec = ai;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  return window.__res;
};
