// Does somebody else's car keep up with itself up a steep hill?
//
// "There's still ... an issue with ... hitting an invisible wall on the ground. Happened a lot in multiplayer
// today ... I saw police cars do it quite a lot ... mainly really steep, pretty steep hills when you're going
// very fast." In multiplayer every car another machine owns -- the other player's, and on a guest every police
// car -- is a body here pulled after what its owner says (Game._netDriveRemote). It is never stepped like a car
// of our own, so whatever a car of our own does on a hill only in Vehicle.prepare it does not do.
//
// The player's car is driven flat out up the steepest slopes and where it was is written down every frame.
// Then a remote car of the same kind is given those positions as if they had come over the network, one a
// frame, and how far it falls behind them is measured:
//
//   await import('/tests/remotehill.js');  await __runRemoteHill(150, 20)   // then window.__res
//
//   behind    the worst gap to where it should be, m, per slope, and the mean of those
//   over2     frames more than 2 m behind, in all
//   snapped   times it fell more than NET_SNAP (5 m) behind and was put there outright
//   stalls    frames in which it lost over 30 km/h when the car it copies lost under 10: the hitch you see
//   worstStall the biggest of those, km/h
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

function slopes(g, spots) {
  let seed = 91;
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

window.__runRemoteHill = async function (kph = 150, spots = 20, kind = null) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    if (g.traffic) g.traffic.clear();
    g.heat.value = 0;
    const pick = slopes(g, spots);
    const speed = kph / 3.6;
    const far = { x: 900, z: 900 };
    const go = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    let rv = null;
    const rows = [];
    let over2 = 0, snapped = 0, stalls = 0, sumBehind = 0, worstStall = 0;
    for (const a of pick) {
      // Recorded: the player's own car, flat out up it.
      const sx = a.x - a.ux * 40, sz = a.z - a.uz * 40, h = Math.atan2(a.ux, a.uz);
      if (rv) rv.teleport({ x: far.x + 30, y: g.sim.heightAt(far.x + 30, far.z) + 2, z: far.z }, 0);
      p.repair();
      p.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, h);
      p.setVelocity({ x: a.ux * speed, y: 0, z: a.uz * speed });
      p._readState();
      const snaps = [];
      for (let i = 0; i < 150; i++) {
        g.stepHeadless(1 / 60, go);
        snaps.push({
          x: p.position.x, y: p.position.y, z: p.position.z,
          qx: p.quaternion.x, qy: p.quaternion.y, qz: p.quaternion.z, qw: p.quaternion.w,
          vx: p.linvel.x, vy: p.linvel.y, vz: p.linvel.z,
        });
      }
      // Replayed: a remote car of the same kind, told each frame where that car was.
      p.teleport({ x: far.x, y: g.sim.heightAt(far.x, far.z) + 1, z: far.z }, 0);
      p.setVelocity({ x: 0, y: 0, z: 0 });
      if (!rv) {
        const k = kind || p.specKey;
        rv = g.createVehicle(k, k, { x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, h, { remote: true });
        for (const w of rv.wheels) w.compression = rv.spec.suspension.rest * 0.6;
      }
      rv.repair();
      rv.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, h);
      rv.setVelocity({ x: a.ux * speed, y: 0, z: a.uz * speed });
      rv._readState();
      let worst = 0, worstAt = null, prevS = speed;
      for (let i = 0; i < snaps.length - 1; i++) {
        const want = snaps[i];
        const off = Math.hypot(want.x - rv.position.x, want.y - rv.position.y, want.z - rv.position.z);
        if (off > 5) snapped++;
        g._netDriveRemote(rv, want, 1 / 60);
        g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
        const b = Math.hypot(snaps[i + 1].x - rv.position.x, snaps[i + 1].y - rv.position.y, snaps[i + 1].z - rv.position.z);
        if (b > 2) over2++;
        if (b > worst) { worst = b; worstAt = { t: +(i / 60).toFixed(2), slope: +(slopeAt(g, rv.position.x, rv.position.z).s * 100).toFixed(0) }; }
        const sNow = Math.hypot(rv.linvel.x, rv.linvel.z);
        const wDrop = i > 0 ? (Math.hypot(snaps[i - 1].vx, snaps[i - 1].vz) - Math.hypot(want.vx, want.vz)) * 3.6 : 0;
        const drop = (prevS - sNow) * 3.6;
        if (drop > 30 && wDrop < 10) { stalls++; worstStall = Math.max(worstStall, drop); }
        prevS = sNow;
      }
      sumBehind += worst;
      rows.push(JSON.stringify({ slope: +(a.s * 100).toFixed(0), behind: +worst.toFixed(2), worstAt }));
      await new Promise((r) => setTimeout(r, 0));
    }
    rows.sort((m, n) => JSON.parse(n).behind - JSON.parse(m).behind);
    window.__res = [`${pick.length} slopes at ${kph} km/h, remote ${rv && rv.specKey}: mean worst gap ${(sumBehind / pick.length).toFixed(2)} m, frames over 2 m ${over2}, snapped ${snapped}, stalls ${stalls}, worst stall ${Math.round(worstStall)} km/h`]
      .concat(rows.slice(0, 6)).join('\n');
    if (rv) g.removeVehicle(rv);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  return window.__res;
};
