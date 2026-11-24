// Is there anything in the way on any road in the city? A car's own box swept along both lanes of every road,
// ground and raised, against everything solid that does not give way.
//
//   const m = await import('/tests/snags.js');  await m.snags()
//
// Each lane is followed in 2 m steps with a box 1.8 m wide, 1.0 m high and 4 m long, 0.45 m clear of the road, and
// what it meets is noted: { kind, id, x, z, group, dims } -- gathered by place, the first of each.
export async function snags(opts = {}) {
  const g = window.__game, G = g.graph, W = g.world, sim = g.sim;
  const { RAPIER, GROUP, groups } = await import('/src/physics/world.js');
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const shape = new RAPIER.Cuboid(0.9, 0.5, 2.0);
  const MASK = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP | GROUP.STREET);
  const found = [], byKind = {};
  let n = 0;
  for (const e of G.edges) {
    if (e.dead || e.cut) continue;
    if (opts.kind && e.kind !== opts.kind) continue;
    if (e.kind === 'alley' && e.length < 15) continue;
    const lane = e.kind === 'alley' ? [0] : [e.width * 0.25, -e.width * 0.25];
    for (const o of lane) {
      for (let s = 1; s < e.length - 1; s += 2) {
        const p = G.pointAt(e, s), x = p.x - p.tz * o, z = p.z + p.tx * o;
        const y = e.deck ? G.levelOn(e, x, z) : sim.heightAt(x, z);
        const yaw = Math.atan2(p.tx, p.tz);
        n++;
        let hit = null;
        W.intersectionsWithShape({ x, y: y + 0.95, z }, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, shape, (c) => {
          const b = c.parent();
          const dyn = b && b.bodyType() === 0;
          if (dyn && !opts.dynamic) return true;
          const h = c.halfExtents ? c.halfExtents() : null, t = c.translation();
          hit = { group: c.collisionGroups() >>> 16, dyn, type: c.shape.type, dims: h ? [+h.x.toFixed(2), +h.y.toFixed(2), +h.z.toFixed(2)] : null, at: [Math.round(t.x), +t.y.toFixed(1), Math.round(t.z)] };
          return false;
        }, undefined, MASK);
        if (!hit) continue;
        const k = `${e.kind}${e.elevated ? '+' : ''}`;
        byKind[k] = (byKind[k] || 0) + 1;
        if (!found.some((f) => Math.hypot(f.x - x, f.z - z) < 12)) found.push({ kind: k, id: e.id, name: e.name, x: Math.round(x), z: Math.round(z), y: +y.toFixed(1), ...hit });
      }
    }
  }
  return { n, hits: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, places: found.length, found };
}
