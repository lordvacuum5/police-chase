// Haldon Vale's quarry: what happens to a car that goes off the top, or over
// the jumps on the floor.
//
// "Just a big drop off somewhere where you can like have a massive fall down
// quarry ... add some jumps." Each run puts the player on a run-up at a speed,
// holds the throttle straight on for eight seconds, and reports:
//
//   air       seconds off the ground
//   high      the highest it got above the quarry floor, m
//   landed    on the floor the right way up (and when), or not
//   damage    what it cost, 0-1
//
// window.__runQuarry() -> window.__res
//   'rim'    off the top of the cliff, from 30 m back
//   'kick'   over the kicker on the floor
//   'table'  over the table on the floor

window.__runQuarry = async function (speeds = [60, 90, 120]) {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, p = g.player, q = g.world.__map.quarry;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  const ox = Math.cos(q.open), oz = Math.sin(q.open), tx = -oz, tz = ox;
  const k = q.edge;
  const runs = {
    // From 30 m back along the run-up, heading in: the run-up is uphill over
    // grass, and nobody arrives at the top much faster than this.
    rim: { x: k.x - Math.sin(k.heading) * 30, z: k.z - Math.cos(k.heading) * 30, h: k.heading },
    // The floor kicker's lip is at centre + o*22 - t*12, facing +t.
    kick: { x: q.x + ox * 22 - tx * (q.r - 18), z: q.z + oz * 22 - tz * (q.r - 18), h: Math.atan2(tx, tz) },
    // The table is at centre - o*22, crossed along -t.
    table: { x: q.x - ox * 22 + tx * (q.r - 18), z: q.z - oz * 22 + tz * (q.r - 18), h: Math.atan2(-tx, -tz) },
  };
  const out = [];
  // Three seconds of game first: on a page just loaded the first run's car
  // went nowhere.
  for (let i = 0; i < 180; i++) { g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 }; g._update(1 / 60); }
  for (const [name, r] of Object.entries(runs)) {
    for (const kmh of speeds) {
      const v = kmh / 3.6;
      p.teleport({ x: r.x, y: g.sim.heightAt(r.x, r.z) + 0.7, z: r.z }, r.h);
      p.setVelocity({ x: Math.sin(r.h) * v, y: 0, z: Math.cos(r.h) * v });
      // Mended, wheels and all: what one run did to the car otherwise slowed the next.
      p.repair();
      let air = 0, high = -1e9, landed = null, went = false;
      for (let i = 0; i < 60 * 8; i++) {
        // Hold the speed it was given, and the heading, as a driver would: on
        // the cross-slope by the rim a car left to itself turned downhill.
        let err = Math.atan2(p.forward.x, p.forward.z) - r.h;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        g.forceControls = { throttle: p.speed < v ? 1 : 0, brake: 0, steer: Math.max(-1, Math.min(1, -err * 3)), handbrake: 0 };
        g._update(1 / 60);
        const d = Math.hypot(p.position.x - q.x, p.position.z - q.z);
        high = Math.max(high, p.position.y - q.floor);
        if (p.grounded === 0 && i > 30) { air += 1 / 60; went = true; }
        if (went && !landed && p.grounded >= 4 && d < q.r - 6 && Math.abs(p.position.y - g.sim.heightAt(p.position.x, p.position.z)) < 1.2) {
          landed = { t: +(i / 60).toFixed(1), up: +p.up.y.toFixed(2), dmg: +p.damage.toFixed(2) };
        }
      }
      g.forceControls = null;
      out.push(`${name} ${kmh} km/h: air ${air.toFixed(1)} s, high ${high.toFixed(0)} m, `
        + (landed ? `landed at ${landed.t} s upright ${landed.up}` : 'never landed on the floor')
        + `, damage ${p.damage.toFixed(2)}, ends up ${p.up.y.toFixed(2)}`);
    }
  }
  window.__res = out.join('\n');
  return window.__res;
};
