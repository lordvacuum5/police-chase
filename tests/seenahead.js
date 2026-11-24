// "When driving fast it's hard to see the civilian cars until the last moment. They fade into existence too close to the player."
// The player carried along the motorway, and along the streets, nobody wanted, traffic as it comes:
//   const m = await import('/tests/seenahead.js');  await m.seenAhead()       // window.__sa
// For every traffic car that comes within 60 m ahead: how far ahead it was when it was first there to be seen (in front,
// within 35 degrees, nearer than the fog's end); `first` the median, `under` 200 and 350 m shares, `pop` the cars that came into
// being in view (in front) and the nearest of those, m; per km: cars met.
export async function seenAhead(runs = [['motorway', 67, 60], ['dual', 50, 40], ['street', 33, 60]]) {
  const g = window.__game, G = g.graph, p = g.player, out = window.__sa = [];
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.dispatcher.update = () => {};
  const far = g.scene.fog ? g.scene.fog.far : 900;
  for (const [kind, sp, secs] of runs) {
    g.traffic.preset = false;
    g.traffic.clear();
    const es = G.edges.filter((e) => (kind === 'street' ? e.kind === 'street' && !e.elevated : e.kind === kind && e.elevated) && !e.dead && e.length > 50);
    let e = es[Math.floor(es.length / 3)], fwd = true, s = 2, dist = 0;
    const first = new Map(), met = new Set(), firsts = [], known = new Set();
    const r = { kind, kph: Math.round(sp * 3.6), met: 0, first: 0, under200: 0, under350: 0, pop: 0, popNear: null, cars: 0, n: 0, oncoming: 0, lanes: {} };
    for (let i = 0; i < secs * 60; i++) {
      s += sp / 60; dist += sp / 60;
      while (s > e.length) {
        s -= e.length;
        const node = fwd ? e.b : e.a, dirp = G.pointAt(e, fwd ? e.length : 0), k0 = fwd ? 1 : -1;
        let best = null, bc = -2;
        for (const id of G.nodes[node].edges) { const o = G.edges[id]; if (o === e || o.dead || o.cut || o.kind !== e.kind || !!o.elevated !== !!e.elevated) continue; const q = G.pointAt(o, o.a === node ? 0 : o.length), c = (q.tx * dirp.tx + q.tz * dirp.tz) * (o.a === node ? 1 : -1) * k0; if (c > bc) { bc = c; best = o; } }
        if (!best) { e = es[(es.indexOf(e) + 17 + es.length) % es.length] || es[0]; fwd = true; s = 2; first.clear(); break; }
        fwd = best.a === node; e = best;
      }
      const q = G.pointAt(e, fwd ? s : e.length - s), tx = q.tx * (fwd ? 1 : -1), tz = q.tz * (fwd ? 1 : -1), y = e.deck ? G.levelOn(e, q.x, q.z) : g.groundAt(q.x, q.z);
      const ox = -tz * 3.5, oz = tx * 3.5;
      p.teleport({ x: q.x + ox, y: y + 0.6, z: q.z + oz }, Math.atan2(tx, tz));
      p.setVelocity({ x: tx * sp, y: 0, z: tz * sp });
      p._readState();
      p.repair();
      g.heat.value = 0;
      const c = g.camera;
      c.position.set(q.x - tx * 8, y + 3.2, q.z - tz * 8);
      c.lookAt(q.x + tx * 20, y + 1, q.z + tz * 20);
      c.updateMatrixWorld(true);
      g.stepHeadless(1 / 60, { throttle: 0.2, brake: 0, steer: 0, handbrake: 0 });
      r.n++; r.cars += g.traffic.cars.length;
      for (const t of g.traffic.cars) {
        const dx = t.v.position.x - q.x, dz = t.v.position.z - q.z, d = Math.hypot(dx, dz), f = (dx * tx + dz * tz) / (d || 1);
        const infront = f > 0.82 && d < far && Math.abs(t.v.position.y - y) < 8;
        if (!known.has(t.id)) { known.add(t.id); if (infront && i > 300) { r.pop++; r.popNear = Math.min(r.popNear === null ? 1e9 : r.popNear, Math.round(d)); } }
        if (infront && !first.has(t.id)) first.set(t.id, d);
        if (infront && d < 60 && !met.has(t.id) && i > 600) { met.add(t.id); firsts.push(first.get(t.id)); }
        // Which lane the ones on this road are in, m off its middle, their own way.
        if (i % 30 === 0 && d < 250 && e.elevated) {
          const on = G.nearestEdgeTo(t.v.position, 20);
          if (on && on.edge.kind === kind) {
            const w = G.pointAt(on.edge, on.along), lat = -(t.v.position.x - w.x) * w.tz + (t.v.position.z - w.z) * w.tx, way = w.tx * t.v.forward.x + w.tz * t.v.forward.z >= 0 ? 1 : -1;
            const k = Math.round(lat * way);
            if (k < -1) { r.wrong = r.wrong || {}; const w2 = r.wrong[t.id] = r.wrong[t.id] || [Math.round(t.v.position.x), Math.round(t.v.position.z), k, +(t.v.forward.x * w.tx + t.v.forward.z * w.tz).toFixed(2), on.edge.id, t.lane, t.v.dormant ? 1 : 0, Math.round(t.v.speed), 0]; w2[8]++; }
            r.lanes[k] = (r.lanes[k] || 0) + 1;
            if (t.v.forward.x * tx + t.v.forward.z * tz < 0) r.oncoming++;
          }
        }
      }
      if (i % 30 === 0) await new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); res(); }; ch.port2.postMessage(0); });
    }
    firsts.sort((a, b) => a - b);
    r.met = firsts.length; r.perKm = +(firsts.length / (dist / 1000)).toFixed(1);
    r.first = Math.round(firsts[Math.floor(firsts.length / 2)] || 0);
    r.under200 = +(firsts.filter((x) => x < 200).length / Math.max(1, firsts.length)).toFixed(2);
    r.under350 = +(firsts.filter((x) => x < 350).length / Math.max(1, firsts.length)).toFixed(2);
    r.cars = +(r.cars / r.n).toFixed(1);
    out.push(r);
  }
  return out;
}
