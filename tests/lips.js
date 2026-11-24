// A slip road's foot over the street it leaves: does the edge of its deck jolt a car driving along the street across it?
//   const m = await import('/tests/lips.js');  await m.lips([[x, z, edgeId], ...])   // from tests/steps.js `at`
// Per spot, both ways and three lines: kick (the most the car's rise changes in 1/60 s, m/s), damage; a control, the same
// on the middle of a plain street, first.
export async function lips(spots, speed = 22) {
  const g = window.__game, G = g.graph, v = g.player, sim = g.sim, out = [];
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 1;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  for (const [x, z, id] of spots) {
    const e = G.edges[id];
    let bs = 0, bd = Infinity;
    for (let s = 0; s < e.length; s += 0.5) { const p = G.pointAt(e, s), d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; bs = s; } }
    const p = G.pointAt(e, bs);
    const r = { x, z, id, kick: 0, damage: 0, runs: 0 };
    for (const dir of [1, -1]) {
      for (const off of [-1.5, 0, 1.5]) {
        const tx = p.tx * dir, tz = p.tz * dir, hd = Math.atan2(tx, tz), back = speed * 0.7;
        const sx = x - tx * back - tz * off, sz = z - tz * back + tx * off;
        v.teleport({ x: sx, y: sim.terrainAt(sx, sz) + 0.7, z: sz }, hd);
        v.setVelocity({ x: tx * speed, y: 0, z: tz * speed });
        v._readState();
        for (let k = 0; k < 24; k++) g.stepHeadless(1 / 60, { throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
        v.repair();
        let was = v.linvel.y;
        for (let k = 0; k < 40; k++) {
          g.stepHeadless(1 / 60, { throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
          r.kick = Math.max(r.kick, Math.abs(v.linvel.y - was));
          was = v.linvel.y;
        }
        r.damage = Math.max(r.damage, v.damage || 0);
        r.runs++;
      }
    }
    r.kick = +r.kick.toFixed(2); r.damage = +r.damage.toFixed(3);
    out.push(r);
    await new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  }
  return out;
}
