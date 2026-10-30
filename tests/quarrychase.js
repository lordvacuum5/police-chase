// Can the police get to a car in the quarry?
//
// "The routing system by the quarry is messed up in the quarry ... And also,
// when the police tries to get stuff on the terraces, just tell them to
// basically just drive off the edge and get down to the quarry."
//
// The player parked on the quarry floor, three stars, the roster filled as
// the force rig does; then `seconds` of the chase. Reports how near the
// nearest unit got and when, how many units came within 25 m, how many ended
// up down on the floor (and how many of those came off the top rather than
// down the track), and how many sat still a long way off for ten seconds and
// more -- stuck against the rock.
//
// window.__runQuarryChase(seconds) -> window.__res

window.__runQuarryChase = async function (seconds = 60, where = 'floor') {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, p = g.player, q = g.world.__map.quarry;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  const ox = Math.cos(q.open), oz = Math.sin(q.open);
  // On the floor, off to the far side from the way in -- or, `ledge`, halfway
  // up the terraces on that side, dropped onto the ledge from above.
  const T = q.tiers, k = Math.floor((T - 1) / 2);
  const rl = q.r - 6 - (T - 1 - k) * q.bench + q.bench * 0.5;
  const x = q.x - ox * (where === 'ledge' ? rl : 25), z = q.z - oz * (where === 'ledge' ? rl : 25);
  p.repair();
  p.teleport({ x, y: where === 'ledge' ? q.floor + 80 : g.sim.heightAt(x, z) + 0.7, z }, Math.atan2(-oz, ox));
  for (let i = 0; i < 60 * 6 && !(p.grounded >= 4 && p.speed < 0.3); i++) { g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 1 }; g._update(1 / 60); }
  p.setVelocity({ x: 0, y: 0, z: 0 });
  g.heat.value = 3;
  for (let i = 0; i < 40 && g.dispatcher.units.length < g.dispatcher.rules.units; i++) {
    const u = g.spawnPoliceNear(p.position, 3);
    if (!u) break;
    g.dispatcher.units.push(u);
  }
  const floorY = q.floor + 3;
  const track = new Map();       // unit -> { wasHigh, still, came }
  let nearest = Infinity, nearestAt = null, within = new Set(), t = 0;
  for (let i = 0; i < seconds * 60; i++) {
    g.heat.value = Math.max(g.heat.value, 3);
    // Known where you are, as with air support over the quarry: this is about
    // getting there, not finding you.
    g.applyMark(p.position, p.linvel);
    g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
    g._update(1 / 60);
    t += 1 / 60;
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      // In three dimensions: a unit on the floor under your ledge is not with you.
      const d = Math.hypot(v.position.x - p.position.x, v.position.y - p.position.y, v.position.z - p.position.z);
      if (d < nearest) { nearest = d; nearestAt = t; }
      if (d < 25) within.add(u);
      const s = track.get(u) || { wasHigh: false, still: 0, worstStill: 0, inQuarryHigh: false };
      const inQ = Math.hypot(v.position.x - q.x, v.position.z - q.z) < q.r;
      if (inQ && v.position.y > floorY + 6) s.inQuarryHigh = true;
      if (v.position.y > floorY + 6 && inQ) s.wasHigh = true;
      s.still = v.speed < 1 && d > 40 ? s.still + 1 / 60 : 0;
      s.worstStill = Math.max(s.worstStill, s.still);
      s.floor = inQ && v.position.y < floorY;
      track.set(u, s);
    }
  }
  g.forceControls = null;
  const all = [...track.values()];
  const onFloor = all.filter((s) => s.floor).length;
  const offTop = all.filter((s) => s.floor && s.wasHigh).length;
  const stuck = all.filter((s) => s.worstStill > 10).length;
  window.__res = `quarry chase, you on the ${where} (${(p.position.y - q.floor).toFixed(0)} m up), ${seconds}s: units ${track.size}, nearest ${nearest.toFixed(0)} m at ${nearestAt ? nearestAt.toFixed(0) : '-'} s, `
    + `within 25 m ${within.size}, on the floor at the end ${onFloor} (came off a ledge or the top ${offTop}), `
    + `stuck over 10 s ${stuck}, damage to you ${p.damage.toFixed(2)}`;
  return window.__res;
};
