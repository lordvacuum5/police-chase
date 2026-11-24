// Does the ground drawn at a distance stand up through the roads? "It shows green grass ... as I get closer, it
// then turns to tarmac ... I've seen it in other places as well." Each level of detail of the terrain tiles
// (world/citygen.js buildTerrain) is read back as the triangles it is, and under each road -- its middle and both
// sides of its carriageway, every 6 m -- compared with the height the road is drawn at.
//   const m = await import('/tests/farground.js');  m.farGround()
//   per level: over  samples where the ground is above the road, worst  by how much, m
export function farGround() {
  const g = window.__game, G = g.graph, sim = g.sim;
  let terrain = null;
  g.scene.traverse((o) => { if (o.name === 'terrain' && o.isGroup) terrain = o; });
  const out = [];
  const tiles = terrain.children.filter((l) => l.isLOD);
  for (let L = 0; L < tiles[0].levels.length; L++) {
    const map = new Map();
    let size = 0;
    for (const t of tiles) {
      const m = t.levels[L].object, p = m.geometry.attributes.position, n = Math.round(Math.sqrt(p.count));
      const step = p.getX(1) - p.getX(0);
      size = step * (n - 1);
      map.set(`${Math.round(p.getX(0))},${Math.round(p.getZ(0))}`, { p, n, step, x0: p.getX(0), z0: p.getZ(0) });
    }
    const keys = [...map.values()];
    const at = (x, z) => {
      const t = keys.find((q) => x >= q.x0 && x < q.x0 + size && z >= q.z0 && z < q.z0 + size);
      if (!t) return -Infinity;
      const u = (x - t.x0) / t.step, v = (z - t.z0) / t.step, i = Math.min(t.n - 2, Math.floor(u)), j = Math.min(t.n - 2, Math.floor(v));
      const a = u - i, b = v - j, Y = (ii, jj) => t.p.getY(jj * t.n + ii);
      // Split b-d, as buildTerrainMesh indexes it.
      return a + b <= 1 ? Y(i, j) + (Y(i + 1, j) - Y(i, j)) * a + (Y(i, j + 1) - Y(i, j)) * b
        : Y(i + 1, j + 1) + (Y(i, j + 1) - Y(i + 1, j + 1)) * (1 - a) + (Y(i + 1, j) - Y(i + 1, j + 1)) * (1 - b);
    };
    const r = { level: L, step: keys[0].step, n: 0, over: 0, worst: 0, at: null, kinds: {} };
    for (const e of G.edges) {
      if (e.bridge && !e.elevated) continue;
      for (let s = 2; s < e.length; s += 6) {
        const p = G.pointAt(e, s);
        for (const o of [0, e.width * 0.45, -e.width * 0.45]) {
          const x = p.x - p.tz * o, z = p.z + p.tx * o, road = e.deck ? G.levelOn(e, x, z) : sim.terrainAt(x, z) + 0.06;
          r.n++;
          const d = at(x, z) - road;
          if (d > 0) { r.over++; r.kinds[e.kind] = (r.kinds[e.kind] || 0) + 1; if (d > r.worst) { r.worst = +d.toFixed(2); r.at = [Math.round(x), Math.round(z), e.kind]; } }
        }
      }
    }
    out.push(r);
  }
  return out;
}
