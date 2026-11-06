// Less health, nothing lost until it has all gone, and then lights out.
//
// "Police cars have less health, so it's easier to wreck them ... when you wreck them, I want
// the police lights to turn off ... even at 99, I want them to be moving just as fast and have
// no negative effects on their speed or acceleration in any way."
//
//   await import('/tests/wreckcop.js');
//   await __runWreckCop();  // then window.__res
//
// For each police car the computer drives: how many 50 km/h shunts (14 m/s of change) finish
// it; full throttle for 8 s from the same spot on the same heading at 0, 50 and 99 damage; a
// wreck made at speed, how long and how far it took to stop, and whether it stays stopped, is
// off the arrest count and the map, and is lit.
window.__runWreckCop = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    const rows = [];
    const idle = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    g.heat.value = 5;
    // Somewhere straight and flat: the longest road edge near the middle.
    const e = g.graph.edges.filter((x) => !x.cut && x.points && x.points.length > 3)
      .map((x) => {
        const a = x.points[0], b = x.points[x.points.length - 1];
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
      }).sort((m, n) => n.len - m.len)[0];
    const h = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
    const start = { x: e.a.x, y: g.sim.heightAt(e.a.x, e.a.z) + 0.9, z: e.a.z };
    // The player well out of it.
    p.teleport({ x: e.a.x + 400, y: g.sim.heightAt(e.a.x + 400, e.a.z) + 2, z: e.a.z + 400 }, 0);
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    g.paused = true;

    const u = g.spawnPoliceNear(start, 5);
    if (!u) throw new Error('no unit');
    const v = u.vehicle;
    v.assist.shielded = false;
    rows.push(`car ${v.spec.name || ''} durability ${v.spec.durability} wreckAt ${v.spec.wreckAt} wreckPower ${v.spec.wreckPower}, road ${Math.round(e.len)} m`);

    // Shunts to finish it.
    v.repair();
    let shunts = 0;
    while (v.damage < (v.spec.wreckAt ?? 0.92) && shunts < 30) { v.takeImpact(14); shunts++; }
    rows.push(`50 km/h shunts to wreck: ${shunts} (damage ${v.damage.toFixed(2)})`);

    // The same pull at each level of damage.
    for (const dmg of [0, 0.5, 0.99, 0]) {
      v.repair();
      v.damage = dmg;
      v.teleport(start, h);
      v.setVelocity({ x: 0, y: 0, z: 0 });
      let at4 = 0;
      const steps = 8 * 60;
      for (let i = 0; i < steps; i++) {
        v.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
        g.heat.value = 0;
        g.stepHeadless(1 / 60, idle);
        if (i === 4 * 60) at4 = v.speed;
      }
      rows.push(`damage ${Math.round(dmg * 100)}: ${Math.round(at4 * 3.6)} km/h at 4 s, ${Math.round(v.speed * 3.6)} at 8 s, disabled ${v.disabled}`);
    }
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  return window.__res;
};

/** A wreck made in the real game: a unit on the player's tail is finished at speed. */
window.__runWreckLive = async function (seconds = 14) {
  window.__res = null;
  try {
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;
    g.heat.value = 5;
    const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    let u = null;
    for (let i = 0; i < 30 * 30 && !u; i++) {
      g.stepHeadless(1 / 30, ctl);
      g.heat.value = 5;
      u = g.dispatcher.units.find((o) => !o.human && o.vehicle.speed > 15 && o.distanceTo(p.position) > 40 && o.distanceTo(p.position) < 140);
    }
    if (!u) throw new Error('no unit up to speed');
    const v = u.vehicle;
    const before = v.speed;
    const at = { x: v.position.x, z: v.position.z };
    v.assist.shielded = false;
    v.damage = 0.99;
    const atFull = v.disabled;
    v.takeImpact(30);
    g.stepHeadless(1 / 30, ctl);
    const rows = [`at 99 disabled ${atFull}; wrecked at ${Math.round(before * 3.6)} km/h, now disabled ${v.disabled}, damage ${v.damage}, lit ${!v.disabled}, chasing ${g.dispatcher.units.filter((o) => !o.human && !o.vehicle.disabled).length}`];
    let stoppedAt = null, moved = 0;
    for (let i = 0; i < seconds * 30; i++) {
      g.heat.value = 5;
      g.stepHeadless(1 / 30, ctl);
      if (v.removed) { rows.push(`removed at ${(i / 30).toFixed(1)} s`); break; }
      if (stoppedAt === null && v.speed < 0.3) {
        stoppedAt = i / 30;
        moved = Math.hypot(v.position.x - at.x, v.position.z - at.z);
      }
      if (i % 90 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    rows.push(`stopped after ${stoppedAt === null ? 'never' : stoppedAt.toFixed(1) + ' s'}, ${Math.round(moved)} m on; then speed ${v.speed.toFixed(2)}, still disabled ${v.disabled}, damage ${v.damage}, on roster ${g.dispatcher.units.includes(u)}, distance to player ${Math.round(Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z))} m`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  return window.__res;
};
