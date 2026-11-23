// Driving Ashfield City's raised roads end to end: does anything fall off, or crash into the structure?
//
// "Drive on the actual road as well, just to double check it. Doesn't like you don't like fall through it."
// The game's own driver takes the player's car along a route over the raised roads -- each way along the
// expressway joining from the ring, up each slip road onto the ring and along it, down each expressway ramp --
// and every step it is checked against the deck it should be on.
//
//   await import('/tests/viaducts.js');  __runViaducts()   // then window.__via
//
//   fell     the car more than 2.5 m under every raised road's deck near it, while on a raised stretch
//   damage   what the drive cost the car (a barrier, a pier, a ramp's edge)
export async function runViaducts() {
  const g = window.__game, v = g.player, G = g.graph;
  const { Driver, SKILL } = window.__modules;
  g.onBusted = () => { g.outcome = null; };
  // Nothing else on the road: what is measured is the structure, not who the driver ran into.
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  const raised = G.edges.filter((e) => e.elevated);
  const routes = [];
  const ex = G.edges.filter((e) => e.express);
  const exNodes = [...new Set(ex.flatMap((e) => [e.a, e.b]))].map((id) => G.nodes[id]).sort((a, b) => a.x - b.x);
  const ringBefore = (n) => {
    // The ring node one before `n` round the ring: the route comes along the ring and turns off.
    for (const eid of n.edges) { const e = G.edges[eid]; if (e.kind === 'motorway') return G.nodes[e.a === n.id ? e.b : e.a]; }
    return null;
  };
  const w0 = exNodes[0], e0 = exNodes[exNodes.length - 1];
  routes.push({ name: 'expressway west to east', path: [ringBefore(w0).id, ...exNodes.map((n) => n.id)] });
  routes.push({ name: 'expressway east to west', path: [ringBefore(e0).id, ...exNodes.slice().reverse().map((n) => n.id)] });
  for (const e of raised.filter((r) => r.kind === 'ramp')) {
    const a = G.nodes[e.a], b = G.nodes[e.b];
    const foot = a.elevated ? b : a, top = a.elevated ? a : b;
    const on = top.edges.map((id) => G.edges[id]).find((x) => x !== e && x.elevated);
    if (!on) continue;
    const next = G.nodes[on.a === top.id ? on.b : on.a];
    routes.push({ name: (top.type === 'express' ? 'down from the expressway at ' : 'up onto the ring at ') + Math.round(top.x) + ',' + Math.round(top.z),
      path: top.type === 'express' ? [next.id, top.id, foot.id] : [foot.id, top.id, next.id] });
  }
  const out = [];
  for (const r of routes) {
    const pts = G.pathToPoints(r.path, 2.5, true);
    if (pts.length < 3) continue;
    const p0 = pts[0], p1 = pts[2];
    const hd = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const n0 = G.nodes[r.path[0]];
    v.teleport({ x: p0.x, y: (n0.y !== undefined ? n0.y : g.sim.heightAt(p0.x, p0.z)) + 0.9, z: p0.z }, hd);
    v.setVelocity({ x: Math.sin(hd) * 10, y: 0, z: Math.cos(hd) * 10 });
    // Read back now: the driver finds its place on the path from where the car is, and until the next step
    // that was where the last route left it -- most of them "finished" in a second or two.
    v._readState();
    if (v.repair) v.repair();
    const d = new Driver(v, SKILL.pursuit);
    d.setPath(pts);
    let fell = null, t = 0;
    while (t < 100 && d.remaining() > 15) {
      G.queryY = v.position.y - 0.9;
      const c = d.followPath(1 / 60, 28);
      G.queryY = null;
      g.stepHeadless(1 / 60, c);
      t += 1 / 60;
      // Police patrols too: one on a slip road was most of what the first runs "hit".
      if ((t * 60 | 0) % 30 === 0) {
        for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
        for (const o of g.vehicles.slice()) if (o !== v && !o.remote && !o.isAircraft) g.removeVehicle(o);
      }
      const p = v.position;
      let near = null;
      for (const e of raised) {
        if (Math.abs(p.x - e.points[0].x) > 600 && Math.abs(p.x - e.points[e.points.length - 1].x) > 600) continue;
        const ly = G.levelOn(e, p.x, p.z);
        if (ly - (g.sim.terrainAt(p.x, p.z)) < 1) continue;          // a ramp's foot: on the ground anyway
        const dist = Math.min(...e.segs.map((s) => { const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, l2 = dx * dx + dz * dz; let u = l2 ? ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / l2 : 0; u = Math.max(0, Math.min(1, u)); return Math.hypot(s.a.x + dx * u - p.x, s.a.z + dz * u - p.z); }));
        if (dist > e.width * 0.5 + 1) continue;
        if (near === null || Math.abs(p.y - ly) < Math.abs(near)) near = p.y - ly;
      }
      if (near !== null && near < -2.5 && !fell) fell = `${Math.round(p.x)},${Math.round(p.z)}`;
      if ((t * 60 | 0) % 240 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    out.push({ route: r.name, done: d.remaining() <= 15, t: +t.toFixed(1), fell, damage: +v.damage.toFixed(3) });
  }
  window.__via = out;
  return out;
}
window.__runViaducts = runViaducts;
