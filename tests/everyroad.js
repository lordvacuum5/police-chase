// The game's own driver down every road on the map, one at a time, nothing else about: what does it hit, where
// does it stop, where does it leave the ground?
//   const m = await import('/tests/everyroad.js');  m.everyRoad();   // window.__er as it goes
//   bad: { kind, id, why: 'stuck' | 'damage' | 'air' | 'under', x, z, v }
export async function everyRoad(opts = {}) {
  const g = window.__game, G = g.graph, v = g.player, sim = g.sim;
  const { Driver, SKILL } = window.__modules;
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 1;
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.heat.value = 0;
  const out = window.__er = { n: 0, total: 0, bad: [], done: false };
  const list = G.edges.filter((e) => !e.dead && !e.cut && e.length > 24 && !e.turningHead && (!opts.kind || e.kind === opts.kind) && (!opts.raised || e.elevated));
  out.total = list.length * 2;
  for (const e of list) {
    for (const fwd of [true, false]) {
      out.n++;
      const ids = fwd ? [e.a, e.b] : [e.b, e.a];
      // Smoothed, as everything that drives is given it: raw, a raised road's points are 2 m apart and nothing steers by them.
      const pts = G.pathToPoints(ids, 2.4, true);
      if (!pts || pts.length < 3) continue;
      const p0 = pts[0], p1 = pts[Math.min(3, pts.length - 1)], hd = Math.atan2(p1.x - p0.x, p1.z - p0.z);
      const lv = (x, z) => (e.deck ? G.levelOn(e, x, z) : sim.heightAt(x, z));
      v.teleport({ x: p0.x, y: lv(p0.x, p0.z) + 0.85, z: p0.z }, hd);
      v.setVelocity({ x: Math.sin(hd) * 9, y: 0, z: Math.cos(hd) * 9 });
      v._readState();
      if (v.repair) v.repair();
      const d = new Driver(v, SKILL.pursuit);
      d.setPath(pts);
      let t = 0, still = 0, air = 0, why = null;
      const lim = e.length / 5 + 12;
      while (t < lim && d.remaining() > 8) {
        G.queryY = v.position.y - 0.9;
        const c = d.followPath(1 / 60, Math.min(22, (e.speed || 14) * 1.3));
        G.queryY = null;
        g.stepHeadless(1 / 60, c);
        t += 1 / 60;
        still = v.speed < 0.7 ? still + 1 / 60 : 0;
        const p = v.position, up = p.y - lv(p.x, p.z);
        air = (v.grounded !== undefined ? v.grounded : 4) === 0 ? air + 1 / 60 : 0;
        if (v.damage > 0.015) { why = 'damage'; break; }
        if (up < -1.2) { why = 'under'; break; }
        if (air > 0.5) { why = 'air'; break; }
        if (still > 4) { why = 'stuck'; break; }
      }
      if (!why && d.remaining() > 8) why = 'slow';
      if (why) out.bad.push({ kind: e.kind, id: e.id, why, x: Math.round(v.position.x), z: Math.round(v.position.z), y: +v.position.y.toFixed(1), road: +lv(v.position.x, v.position.z).toFixed(1), dmg: +v.damage.toFixed(2), t: +t.toFixed(1), left: Math.round(d.remaining()), fwd });
      if (out.n % 4 === 0) await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
    }
  }
  out.done = true;
  return out;
}
