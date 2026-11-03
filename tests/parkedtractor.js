// Police cars against the parked tractor and trailer on Haldon Vale.
//
// "There's a tractor with a trailer, right? And it never moves ... the police
// cars don't know it's there ... the police cars just hit it."
//
// One interceptor at a time, driving its pursuit from 150 m out across the
// field at a player stopped 60 m beyond the tractor, from `bearings` directions
// round it. Reports for each: did it touch, how fast, how close it passed, and
// what the look-ahead sweep read on the way in. Also says whether a sweep at a
// car's height sees the thing at all.
import { sweepBox, RAY_GROUNDS, RAY_SOLID } from '../src/physics/world.js';

window.__runParkedTractor = async function (bearings = 8, seconds = 25) {
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
    const group = g.world.__map.life.parked;
    const body = group.userData.body;
    const home = { ...body.translation() }, homeR = { ...body.rotation() };
    const yaw = 2 * Math.atan2(homeR.y, homeR.w);
    // The middle of the whole rig: trailer at 0, tractor 6.85 m ahead of it.
    const cx = home.x + Math.sin(yaw) * 3.4, cz = home.z + Math.cos(yaw) * 3.4;
    const p = g.player;
    const gy = (x, z) => (g.groundAt ? g.groundAt(x, z) : 0);
    const rows = [];
    // Can a sweep at a car's height see it?
    const sw = (mask) => {
      const o = { x: cx - 40, y: gy(cx - 40, cz) + 0.5, z: cz };
      return +sweepBox(g.world, o, { x: 1, y: 0, z: 0 }, 60, mask, null, 1).toFixed(1);
    };
    rows.push(`sweep from 40 m: RAY_GROUNDS ${sw(RAY_GROUNDS)}, RAY_SOLID ${sw(RAY_SOLID)}`);
    let touched = 0;
    for (let b = 0; b < bearings; b++) {
      const a = (b / bearings) * Math.PI * 2;
      const sx = cx + Math.sin(a) * 150, sz = cz + Math.cos(a) * 150;
      const tx = cx - Math.sin(a) * 60, tz = cz - Math.cos(a) * 60;
      body.setTranslation(home, true);
      body.setRotation(homeR, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.repair();
      p.teleport({ x: tx, y: gy(tx, tz) + 0.9, z: tz }, 0);
      p._readState();
      const car = g.createVehicle('interceptor', 'interceptor',
        { x: sx, y: gy(sx, sz) + 0.95, z: sz }, a + Math.PI, { police: true });
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.PURSUE);
      o.driver.allowOffRoad = true;
      car._readState();
      let hit = 0, nearest = Infinity, top = 0, moved = 0, got = 0;
      for (let i = 0; i < seconds * 60; i++) {
        p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
        o.update(1 / 60, p);
        g.stepHeadless(1 / 60);
        const t = body.translation();
        moved = Math.max(moved, Math.hypot(t.x - home.x, t.z - home.z));
        const r = Math.hypot(car.position.x - cx, car.position.z - cz);
        if (r < nearest) nearest = r;
        top = Math.max(top, car.speed);
        if (!hit && moved > 0.02) hit = car.speed * 3.6;
        if (i % 120 === 0) await new Promise((r2) => setTimeout(r2, 0));
        if (Math.hypot(car.position.x - tx, car.position.z - tz) < 12) { got = (i + 1) / 60; break; }
      }
      if (moved > 0.02) touched++;
      rows.push(`${String(Math.round(a * 57.3)).padStart(3)} deg: ${moved > 0.02 ? `HIT at ${Math.round(hit)} km/h, shoved ${moved.toFixed(1)} m` : 'clear'}, passed ${nearest.toFixed(1)} m from its middle, top ${Math.round(top * 3.6)} km/h, ${got ? `there in ${got.toFixed(1)} s` : `NEVER GOT THERE, stuck ${Math.round(Math.hypot(car.position.x - tx, car.position.z - tz))} m off`}`);
      g.removeVehicle(car);
    }
    body.setTranslation(home, true);
    body.setRotation(homeR, true);
    rows.unshift(`${touched} of ${bearings} hit it`);
    window.__res = rows;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
