// "Maybe we should have denser traffic ... on the America map. Is that why it just looks so empty, or did you test that
// already and does it like lag?" The player carried along the roads at 18 m/s, nobody wanted, for each setting:
//   const m = await import('/tests/busyroads.js');  await m.busyRoads([[28, 150], [50, 110]])   // [cars, simulated within m]
//   cars   in the game      near   within 150 m      seen   within 250 m and within 60 degrees of straight ahead
//   awake  simulated        ms     a frame's update, mean (and p95); triangles and calls in a drawn frame, mean
export async function busyRoads(settings, secs = 60, opts = {}) {
  const g = window.__game, G = g.graph, p = g.player, out = window.__br = [];
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (opts.alone !== false) g.dispatcher.update = () => {};
  const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  for (const [count, sim] of settings) {
    window.__trafficCount = count;
    window.__trafficSim = sim;
    g.traffic.preset = false;
    g.traffic.clear();
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const nodes = G.nodes.filter((n) => n.edges.length >= 2 && !n.elevated && Math.hypot(n.x, n.z) < (opts.r || 1100));
    const pick = () => { const n = nodes[Math.floor(rnd() * nodes.length)], a = rnd() * 6.28; return { x: n.x, z: n.z, dx: Math.sin(a), dz: Math.cos(a) }; };
    let at = pick();
    const r = { count, sim, n: 0, cars: 0, near: 0, seen: 0, awake: 0, ms: 0, p95: 0, tris: 0, calls: 0, frames: 0 };
    const times = [];
    for (let i = 0; i < secs * 60; i++) {
      let next = G.walkAhead(at.x, at.z, at.dx, at.dz, 18 / 60);
      if (!next || Math.hypot(next.x - at.x, next.z - at.z) < 0.05) next = pick();
      at = next;
      p.teleport({ x: at.x, y: g.groundAt(at.x, at.z) + 0.6, z: at.z }, Math.atan2(at.dx, at.dz));
      p.setVelocity({ x: at.dx * 18, y: 0, z: at.dz * 18 });
      p._readState();
      p.repair();
      g.heat.value = 0;
      const c = g.camera;
      c.position.set(at.x - at.dx * 7, p.position.y + 3, at.z - at.dz * 7);
      c.lookAt(at.x + at.dx * 10, p.position.y + 1, at.z + at.dz * 10);
      c.updateMatrixWorld(true);
      const t = performance.now();
      g.stepHeadless(1 / 60, { throttle: 0.2, brake: 0, steer: 0, handbrake: 0 });
      times.push(performance.now() - t);
      if (i > 600) {
        r.n++;
        r.cars += g.traffic.cars.length;
        for (const q of g.traffic.cars) {
          const dx = q.v.position.x - at.x, dz = q.v.position.z - at.z, d = Math.hypot(dx, dz);
          if (d < 150) r.near++;
          if (d < 250 && (dx * at.dx + dz * at.dz) / (d || 1) > 0.5) r.seen++;
          if (!q.v.dormant) r.awake++;
        }
      }
      if (i % 120 === 119) {
        g._fogTick = 14; g._fogCull();
        if (g._cullTraffic && opts.cull !== false) g._cullTraffic();
        g.renderer.info.autoReset = true;
        g.renderer.render(g.scene, c);
        if (i > 600) { r.tris += g.renderer.info.render.triangles; r.calls += g.renderer.info.render.calls; r.frames++; }
      }
      if (i % 30 === 0) await breathe();
    }
    const late = times.slice(600).sort((a, b) => a - b);
    r.ms = +(late.reduce((a, b) => a + b, 0) / late.length).toFixed(2);
    r.p95 = +late[Math.floor(late.length * 0.95)].toFixed(2);
    for (const k of ['cars', 'near', 'seen', 'awake']) r[k] = +(r[k] / r.n).toFixed(2);
    r.tris = Math.round(r.tris / r.frames / 1000); r.calls = Math.round(r.calls / r.frames);
    out.push(r);
  }
  return out;
}
