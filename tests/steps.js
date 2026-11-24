// Invisible walls and steps on the ground roads: "like right in front of me there, is an invisible wall ... where
// the road crosses". The whole width of every ground road, every 1 m along and across:
//   step   the height the wheels ride jumps more than 0.28 m in 0.5 m
//   wall   something solid, of any kind, that a car's body would meet: a box 1.7 x 0.64 x 1.7 m, its bottom 0.14 m over
//          the road, at anything static (TERRAIN, BUILDING, PROP, RAMP; not HILL, which is the ground itself)
//   const m = await import('/tests/steps.js');  m.steps()      m.steps({ bridges: true }) for those near the water
export async function steps(opts = {}) {
  const g = window.__game, G = g.graph, W = g.world, sim = g.sim;
  const { RAPIER, GROUP, groups } = await import('/src/physics/world.js');
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const shape = new RAPIER.Cuboid(0.85, 0.32, 0.85);
  const MASK = groups(0xFFFF, GROUP.TERRAIN | GROUP.BUILDING | GROUP.PROP | GROUP.RAMP);
  const out = { n: 0, step: 0, wall: 0, groups: {}, at: [] };
  const note = (k, x, z, extra) => {
    out[k]++;
    const near = out.at.find((q) => q.k === k && Math.hypot(q.x - x, q.z - z) < 10);
    if (near) near.n++; else out.at.push({ k, x: Math.round(x), z: Math.round(z), n: 1, ...extra });
  };
  const nearBridge = (e) => e.bridge || G.nodes[e.a].edges.concat(G.nodes[e.b].edges).some((id) => G.edges[id].bridge && !G.edges[id].elevated);
  const yaw45 = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) };
  for (const e of G.edges) {
    if (e.elevated || e.dead || e.cut || (e.kind === 'alley' && e.length < 15)) continue;
    if (opts.bridges && !nearBridge(e)) continue;
    const half = e.width * 0.5 - 0.9, st = opts.step || 1;
    for (let s = 0.5; s < e.length; s += st) {
      const p = G.pointAt(e, s);
      for (let o = -half; o <= half; o += st) {
        const x = p.x - p.tz * o, z = p.z + p.tx * o, y = sim.terrainAt(x, z);
        out.n++;
        for (const [dx, dz] of [[p.tx, p.tz], [-p.tz, p.tx]]) {
          const d = Math.abs(sim.terrainAt(x + dx * 0.5, z + dz * 0.5) - y);
          if (d > 0.28) { note('step', x, z, { d: +d.toFixed(2), kind: e.kind, id: e.id, name: e.name }); break; }
        }
        let hit = null;
        W.intersectionsWithShape({ x, y: y + 0.46, z }, yaw45, shape, (c) => {
          const b = c.parent();
          if (b && b.bodyType() === 0) return true;
          const gr = c.collisionGroups() >>> 16;
          if (gr & GROUP.HILL) return true;
          const t = c.translation();
          if (gr === GROUP.TERRAIN && t.y < -0.5) return true;                // the plate under the map
          const h = c.halfExtents ? c.halfExtents() : null;
          hit = { gr, dims: h ? [+h.x.toFixed(1), +h.y.toFixed(1), +h.z.toFixed(1)] : null, top: h ? +(t.y + h.y - y).toFixed(2) : null };
          return false;
        }, undefined, MASK);
        if (hit) { out.groups[hit.gr] = (out.groups[hit.gr] || 0) + 1; note('wall', x, z, { ...hit, kind: e.kind, id: e.id, name: e.name }); }
      }
    }
  }
  out.at.sort((a, b) => b.n - a.n);
  return out;
}
