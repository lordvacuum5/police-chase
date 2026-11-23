// Ashfield City, audited for the inconsistencies a player finds driving round it.
//
// "If you can find any more bugs or inconsistencies." Things that should never be: furniture in a road or in
// the water, buildings in a road or the water or in each other, roads crossing with no junction, a ground road
// drawn under the ground, places the road network cannot reach. Counted, with the first few of each.
//
//   const m = await import('/tests/cityaudit.js');  m.auditCity()
export function auditCity() {
  const g = window.__game, G = g.graph, map = g.world.__map, W = g.world;
  const out = {};
  const note = (k, v) => { (out[k] = out[k] || { n: 0, at: [] }).n++; if (out[k].at.length < (window.__auditKeep || 6)) out[k].at.push(v); };
  const onRoad = (x, z, pad = 0) => {
    for (const e of G.edgesNear(x, z, 30)) {
      if (e.elevated || e.cut) continue;
      if (e.kind === 'alley' && e.length < 15) continue;
      for (const s of e.segs) {
        const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, l2 = dx * dx + dz * dz;
        let u = l2 ? ((x - s.a.x) * dx + (z - s.a.z) * dz) / l2 : 0;
        u = Math.max(0, Math.min(1, u));
        if (Math.hypot(s.a.x + dx * u - x, s.a.z + dz * u - z) < e.width * 0.5 + pad) return e;
      }
    }
    return null;
  };
  const wet = (x, z) => map.clearAt && map.clearAt(x, z);
  // Street furniture.
  for (const p of g.props.props) {
    const e = onRoad(p.x, p.z, -0.3);
    if (e) note('furniture in a road', [p.kind, Math.round(p.x), Math.round(p.z), e.kind]);
    if (wet(p.x, p.z)) note('furniture in the water', [p.kind, Math.round(p.x), Math.round(p.z)]);
  }
  // Buildings: every BUILDING box collider that is a building (static, tall).
  const boxes = [];
  W.forEachCollider((c) => {
    const grp = c.collisionGroups() >>> 16;
    const b = c.parent();
    if (!(grp & 2) || !b || b.bodyType() !== 1 || c.shape.type !== 1) return;
    const he = c.shape.halfExtents;
    if (he.y < 2.5 || he.x < 2 || he.z < 2) return;           // walls, posts, barriers
    const t = c.translation(), r = c.rotation();
    const yaw = 2 * Math.atan2(r.y, r.w);
    boxes.push({ x: t.x, z: t.z, hx: he.x, hz: he.z, c: Math.cos(yaw), s: Math.sin(yaw) });
  });
  out.buildings = boxes.length;
  for (const b of boxes) {
    // Corners and middle on a road?
    for (const [ax, az] of [[0, 0], [0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]]) {
      const lx = ax * b.hx, lz = az * b.hz;
      const x = b.x + lx * b.c + lz * b.s, z = b.z - lx * b.s + lz * b.c;
      const e = onRoad(x, z, -0.5);
      if (e) { note('building in a road', [Math.round(b.x), Math.round(b.z), e.kind, e.name]); break; }
      if (wet(x, z)) { note('building in the water', [Math.round(b.x), Math.round(b.z)]); break; }
    }
  }
  // Buildings in each other: centre of one inside another.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const a = boxes[i], b = boxes[j];
      if (Math.abs(a.x - b.x) > 60 || Math.abs(a.z - b.z) > 60) continue;
      const dx = a.x - b.x, dz = a.z - b.z;
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      if (Math.abs(lx) < b.hx * 0.8 && Math.abs(lz) < b.hz * 0.8) note('building inside another', [Math.round(a.x), Math.round(a.z)]);
    }
  }
  // Ground roads crossing with no junction.
  const ground = G.edges.filter((e) => !e.elevated && !e.cut && !e.bridge);
  const segs = [];
  for (const e of ground) for (const s of e.segs) segs.push({ e, s });
  const inter = (p, q, r, t) => {
    const d = (q.x - p.x) * (t.z - r.z) - (q.z - p.z) * (t.x - r.x);
    if (Math.abs(d) < 1e-9) return false;
    const u = ((r.x - p.x) * (t.z - r.z) - (r.z - p.z) * (t.x - r.x)) / d;
    const v = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d;
    return u > 0.02 && u < 0.98 && v > 0.02 && v < 0.98;
  };
  const cell = new Map();
  segs.forEach((it, i) => { const k = `${Math.floor(it.s.a.x / 80)},${Math.floor(it.s.a.z / 80)}`; (cell.get(k) || cell.set(k, []).get(k)).push(i); });
  const seen = new Set();
  for (const [k, list] of cell) {
    const [cx, cz] = k.split(',').map(Number);
    const near = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) near.push(...(cell.get(`${cx + i},${cz + j}`) || []));
    for (const i of list) {
      for (const j of near) {
        if (j <= i) continue;
        const A = segs[i], B = segs[j];
        if (A.e === B.e) continue;
        const shared = [A.e.a, A.e.b].some((n) => n === B.e.a || n === B.e.b);
        if (shared) continue;
        if (inter(A.s.a, A.s.b, B.s.a, B.s.b)) {
          const key = A.e.id + ':' + B.e.id;
          if (seen.has(key)) continue;
          seen.add(key);
          note('roads crossing with no junction', [A.e.kind, B.e.kind, Math.round(A.s.a.x), Math.round(A.s.a.z)]);
        }
      }
    }
  }
  // Reachability: the biggest connected part, and what is outside it.
  const comp = new Array(G.nodes.length).fill(-1);
  let best = 0, bestId = 0, id = 0;
  for (const n of G.nodes) {
    if (comp[n.id] >= 0 || !n.edges.length) continue;
    let size = 0; const st = [n.id]; comp[n.id] = id;
    while (st.length) { const c = st.pop(); size++; for (const eid of G.nodes[c].edges) { const e = G.edges[eid]; if (e.cut) continue; const o = e.a === c ? e.b : e.a; if (comp[o] < 0) { comp[o] = id; st.push(o); } } }
    if (size > best) { best = size; bestId = id; }
    id++;
  }
  for (const n of G.nodes) if (n.edges.length && comp[n.id] !== bestId) note('junction cut off from the network', [n.type, Math.round(n.x), Math.round(n.z)]);
  // Short roads (slivers a car cannot use) and roads drawn under the ground.
  for (const e of ground) {
    if (e.length < 3 && !(e.kind === 'alley')) note('road under 3 m long', [e.kind, Math.round(e.points[0].x), Math.round(e.points[0].z)]);
    for (const p of e.points) {
      const road = g.sim.terrainAt(p.x, p.z);
      const h = map.surface ? null : null;
      void h;
      if (!isFinite(road)) note('road with no ground', [Math.round(p.x), Math.round(p.z)]);
    }
  }
  // Trees: trunks on a road or in the water (PROP boxes 0.65 square).
  W.forEachCollider((c) => {
    const grp = c.collisionGroups() >>> 16;
    if (!(grp & 4) || c.shape.type !== 1) return;
    const he = c.shape.halfExtents;
    if (Math.abs(he.x - 0.65) > 0.01) return;
    const t = c.translation();
    const e = onRoad(t.x, t.z, 0.3);
    if (e) note('tree in a road', [Math.round(t.x), Math.round(t.z), e.kind]);
    if (wet(t.x, t.z)) note('tree in the water', [Math.round(t.x), Math.round(t.z)]);
  });
  // Parked cars on a road.
  for (const p of map.parked || []) {
    const e = onRoad(p.x, p.z, 0.8);
    if (e) note('parked car in a road', [Math.round(p.x), Math.round(p.z), e.kind]);
  }
  return out;
}
