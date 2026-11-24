// Sliding along the crash barriers. "I was riding along a wall once and suddenly I just hit almost an invisible
// little, a tiny almost joint, and then I just like went 100% damage." On every raised road, both sides and both ways:
// the car 1.6 m off the wall at `kph`, turned 5 degrees into it, throttle on and leaning on the wheel towards it.
//   const m = await import('/tests/scrape.js'); m.scrape()      // window.__sc
//   hurt   runs costing over 5% damage; wrecked over 50%; stops where it lost over 12 m/s in a tenth of a second
export async function scrape(kph = 180, opts = {}) {
  const g = window.__game, G = g.graph, v = g.player;
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 1;
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  const out = window.__sc = { n: 0, hurt: 0, wrecked: 0, stops: 0, off: 0, metres: 0, dmg: 0, at: [], done: false };
  const sp = kph / 3.6;
  for (const e of G.edges) {
    if (!e.elevated || e.length < 24) continue;
    for (const sg of [1, -1]) {
      for (const dir of [1, -1]) {
        const s = dir > 0 ? Math.min(6, e.length * 0.2) : Math.max(e.length - 6, e.length * 0.8);
        const p = G.pointAt(e, s), tx = p.tz * 0 + p.tx * dir, tz = p.tz * dir;
        const y = G.levelOn(e, p.x, p.z);
        if (y - g.sim.terrainAt(p.x, p.z) < 2) continue;
        const o = e.width * 0.5 - 1.6, nx = -p.tz * sg, nz = p.tx * sg;
        const a = 5 * Math.PI / 180, hx = tx * Math.cos(a) + nx * Math.sin(a), hz = tz * Math.cos(a) + nz * Math.sin(a);
        v.teleport({ x: p.x + nx * o, y: y + 0.6, z: p.z + nz * o }, Math.atan2(hx, hz));
        v.setVelocity({ x: hx * sp, y: 0, z: hz * sp });
        v._readState();
        v.repair();
        // Which way the wheel goes to lean on it.
        const cross = tx * nz - tz * nx;
        let last = v.speed, worst = 0, where = null;
        out.n++;
        for (let i = 0; i < 180; i++) {
          g.stepHeadless(1 / 60, { throttle: 1, brake: 0, steer: cross > 0 ? -0.12 : 0.12, handbrake: 0 });
          if (i % 6 === 5) { const drop = last - v.speed; if (drop > worst) { worst = drop; where = [Math.round(v.position.x), Math.round(v.position.z)]; } last = v.speed; }
          out.metres += v.speed / 60;
          if (v.position.y < y - 4 && v.position.y < g.sim.terrainAt(v.position.x, v.position.z) + 2) { out.off++; break; }
          if (v.damage > 0.6) break;
        }
        out.dmg += v.damage;
        if (v.damage > 0.05) out.hurt++;
        if (v.damage > 0.5) out.wrecked++;
        if (worst > 12) out.stops++;
        if ((v.damage > 0.05 || worst > 12) && out.at.length < 400) out.at.push([e.kind, e.id, sg, dir, +v.damage.toFixed(2), Math.round(worst), where]);
      }
    }
    await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
  }
  out.metres = Math.round(out.metres);
  out.done = true;
  return out;
}
