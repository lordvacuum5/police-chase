// How much traffic does a driving player meet?
//
// "I saw hardly any traffic. And then there were like two, and I went straight
// through them." Drives the player along the roads at 18 m/s (teleported down
// RoadGraph.walkAhead, a random way at a dead end) with nobody wanted, and
// samples once a frame:
//
//   near      mean traffic cars within 150 m
//   close     mean traffic cars within 80 m
//   ghosts    share of frames with a dormant (bodiless) traffic car within 100 m
//             -- one the player can drive straight through
//   cars      mean traffic cars in the game
//
// window.__runTrafficSeen(seconds) -> window.__res. Same start every run.

window.__runTrafficSeen = async function (seconds = 120) {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, gr = g.graph, p = g.player;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = () => {
    const ns = gr.nodes.filter((n) => n.edges.length >= 2);
    const n = ns[Math.floor(rnd() * ns.length)];
    const a = rnd() * Math.PI * 2;
    return { x: n.x, z: n.z, dx: Math.sin(a), dz: Math.cos(a) };
  };
  let at = pick();
  const s = { n: 0, near: 0, close: 0, ghost: 0, cars: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    g.heat.value = 0;
    let next = gr.walkAhead(at.x, at.z, at.dx, at.dz, 18 / 60);
    if (!next || Math.hypot(next.x - at.x, next.z - at.z) < 0.05) next = pick();
    at = next;
    const y = (g.groundAt ? g.groundAt(at.x, at.z) : 0) + 0.6;
    p.teleport({ x: at.x, y, z: at.z }, Math.atan2(at.dx, at.dz));
    p.setVelocity({ x: at.dx * 18, y: 0, z: at.dz * 18 });
    g._update(1 / 60);
    if (i < 600) continue; // let the ring fill
    s.n++;
    let ghost = false;
    for (const c of g.traffic.cars) {
      const d = Math.hypot(c.v.position.x - at.x, c.v.position.z - at.z);
      if (d < 150) s.near++;
      if (d < 80) s.close++;
      if (d < 100 && c.v.dormant) ghost = true;
      s.cars++;
    }
    if (ghost) s.ghost++;
  }
  const n = Math.max(1, s.n);
  window.__res = `${g.mapDef.id} traffic ${seconds}s  near(150m) ${(s.near / n).toFixed(2)}  `
    + `close(80m) ${(s.close / n).toFixed(2)}  ghosts ${(100 * s.ghost / n).toFixed(1)}%  cars ${(s.cars / n).toFixed(1)}`;
  return window.__res;
};
