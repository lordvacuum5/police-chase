// Where can a car drive off Ashfield City's raised roads? Every 1.5 m of every deck's edge, is there a barrier?
//
//   const m = await import('/tests/deckgaps.js');  m.deckGaps()       // or deckGaps({ x, z, r }) for one place
//
// A grid over each raised road's surroundings is asked for the deck on top (a ray down, the raised decks' group
// only); where a deck cell has no deck within 1.6 m beside it, and the ground there is more than 1.5 m below, a
// ray goes across the edge 0.5 m up looking for a barrier. Reported as the gap cells, gathered into runs, the
// longest first: { x, z, n (cells, ~1.5 m each), drop, kind, id }.
export async function deckGaps(at = null) {
  const g = window.__game, G = g.graph, W = g.world, sim = g.sim;
  const { RAPIER, GROUP, groups } = await import('/src/physics/world.js');
  const DOWN = groups(0xFFFF, GROUP.RAMP), SIDE = groups(0xFFFF, GROUP.BUILDING);
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  // Stepped first: on a page whose physics had not run yet every ray misses, and it read as no gaps at all.
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const top = (x, z) => {
    ray.origin = { x, y: 60, z }; ray.dir = { x: 0, y: -1, z: 0 };
    const h = W.castRay(ray, 90, true, undefined, DOWN);
    return h ? 60 - (h.timeOfImpact !== undefined ? h.timeOfImpact : h.toi) : null;
  };
  const C = 1.5, cells = new Map();
  for (const e of G.edges) {
    if (!e.elevated) continue;
    for (let s = 0; s <= e.length; s += 1.5) {
      const p = G.pointAt(e, s);
      if (at && Math.hypot(p.x - at.x, p.z - at.z) > at.r) continue;
      const half = e.width * 0.5 + 3;
      for (let o = -half; o <= half; o += 1.5) {
        const x = p.x - p.tz * o, z = p.z + p.tx * o;
        const k = Math.round(x / C) + ',' + Math.round(z / C);
        if (!cells.has(k)) cells.set(k, e);
      }
    }
  }
  const tops = new Map();
  for (const k of cells.keys()) { const [i, j] = k.split(',').map(Number); tops.set(k, top(i * C, j * C)); }
  const gaps = [], jumps = (g.world.__map && g.world.__map.jumps) || [];
  for (const [k, y] of tops) {
    if (y === null) continue;
    const [i, j] = k.split(',').map(Number);
    const ground = sim.terrainAt(i * C, j * C);
    if (y - ground < 1.5) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const kk = (i + di) + ',' + (j + dj);
      const ny = tops.has(kk) ? tops.get(kk) : top((i + di) * C, (j + dj) * C);
      if (ny !== null && Math.abs(ny - y) < 1.2) continue;
      // Where there is meant to be none (world/jumps.js), not a gap.
      if (jumps.some((q) => Math.abs((i * C - q.x) * q.tx + (j * C - q.z) * q.tz) < q.len / 2 + 4 && Math.abs((i * C - q.x) * q.nx + (j * C - q.z) * q.nz) < 4)) continue;
      // Off the edge here: a barrier between 2 m in and 1.6 m out, at two heights?
      // Several, jittered: a single ray down the grid slips along the seam between two triangles of a wall.
      let held = false;
      for (const h of [0.23, 0.51, 0.83]) {
        for (const jit of [-0.37, 0.13, 0.41]) {
          ray.origin = { x: i * C - di * 3 + dj * jit, y: y + h, z: j * C - dj * 3 + di * jit };
          ray.dir = { x: di, y: 0, z: dj };
          if (W.castRay(ray, 7, true, undefined, SIDE)) { held = true; break; }
        }
        if (held) break;
      }
      if (!held) { gaps.push({ x: i * C, z: j * C, drop: +(y - ground).toFixed(1), e: cells.get(k) }); break; }
    }
  }
  // Runs: cells within 4 m of each other.
  const runs = [], used = new Set();
  gaps.forEach((c, a) => {
    if (used.has(a)) return;
    const run = [], st = [a]; used.add(a);
    while (st.length) { const u = st.pop(); run.push(gaps[u]); gaps.forEach((d, b) => { if (!used.has(b) && Math.hypot(d.x - gaps[u].x, d.z - gaps[u].z) < 4) { used.add(b); st.push(b); } }); }
    const m = run[Math.floor(run.length / 2)];
    runs.push({ x: Math.round(m.x), z: Math.round(m.z), n: run.length, drop: Math.max(...run.map((r) => r.drop)), kind: m.e.kind, id: m.e.id });
  });
  runs.sort((p, q) => q.n - p.n);
  return { cells: tops.size, decked: [...tops.values()].filter((y) => y !== null).length, gapCells: gaps.length, runs };
}

// The real question of each: the player's car driven sideways off the deck there at `speed` m/s. Off it, or held?
//   await m.pushTest([{ x, z }, ...])   -> per spot: where the car ended, `off` when it dropped under the deck
export async function pushTest(spots, speed = 15) {
  const g = window.__game, G = g.graph, v = g.player, out = [];
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.vehicleLimit = 1;
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  for (const q of spots) {
    // The deck it is at the edge of: from its centre line straight at the spot.
    let best = null, bd = Infinity;
    for (const e of G.edges) {
      if (!e.elevated) continue;
      for (let s = 0; s <= e.length; s += 2) { const p = G.pointAt(e, s); const d = Math.hypot(p.x - q.x, p.z - q.z); if (d < bd) { bd = d; best = { e, p }; } }
    }
    const { e, p } = best, dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1, hd = Math.atan2(dx, dz);
    const y = G.levelOn(e, p.x, p.z);
    v.teleport({ x: p.x, y: y + 0.9, z: p.z }, hd);
    v.setVelocity({ x: dx / l * speed, y: 0, z: dz / l * speed });
    v._readState();
    if (v.repair) v.repair();
    let off = false;
    for (let i = 0; i < 180; i++) {
      g.stepHeadless(1 / 60, { throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
      if (v.position.y < y - 3) { off = true; break; }
    }
    out.push({ spot: [q.x, q.z], kind: e.kind, off, end: [Math.round(v.position.x), +v.position.y.toFixed(1), Math.round(v.position.z)], deck: +y.toFixed(1) });
  }
  return out;
}

/** How far the deck as built (its collider) is from where the graph says it is, along every raised road's middle. */
export async function deckError() {
  const g = window.__game, G = g.graph, W = g.world;
  const { RAPIER, GROUP, groups } = await import('/src/physics/world.js');
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const out = [];
  let n = 0, over = 0;
  for (const e of G.edges) {
    if (!e.elevated) continue;
    let worst = 0, at = null;
    for (let s = 3; s < e.length - 3; s += 4) {
      const p = G.pointAt(e, s), y = G.levelOn(e, p.x, p.z);
      ray.origin = { x: p.x, y: y + 3, z: p.z }; ray.dir = { x: 0, y: -1, z: 0 };
      const h = W.castRay(ray, 8, true, undefined, groups(0xFFFF, GROUP.RAMP));
      n++;
      const d = h ? Math.abs(3 - h.timeOfImpact) : 8;
      if (d > 0.25) over++;
      if (d > worst) { worst = d; at = [Math.round(p.x), Math.round(p.z)]; }
    }
    out.push({ kind: e.kind, id: e.id, worst: +worst.toFixed(2), at });
  }
  out.sort((a, b) => b.worst - a.worst);
  return { samples: n, over, worst: out.slice(0, 14) };
}

/**
 * Is each ramp solid from the ground? "I can just phase straight through." The player's car driven at each side
 * of it where its deck is 0.8-3.2 m up, and along under it from its high end towards its foot: `through` counts
 * the ones that came out the other side (or, underneath, got to where the deck is under 2 m up).
 */
export async function solidTest(speed = 14) {
  const g = window.__game, G = g.graph, v = g.player, sim = g.sim, out = [];
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 1;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  const run = (x, z, hd, n, done) => {
    v.teleport({ x, y: sim.terrainAt(x, z) + 0.8, z }, hd);
    v.setVelocity({ x: Math.sin(hd) * speed, y: 0, z: Math.cos(hd) * speed });
    v._readState();
    if (v.repair) v.repair();
    for (let i = 0; i < n; i++) { g.stepHeadless(1 / 60, { throttle: 0.5, brake: 0, steer: 0, handbrake: 0 }); if (done(v.position)) return true; }
    return false;
  };
  for (const e of G.edges) {
    if (e.kind !== 'ramp') continue;
    const footA = !G.nodes[e.a].elevated;
    const at = (d) => { const s = footA ? d : e.length - d, p = G.pointAt(e, s); return { ...p, s, lift: G.levelOn(e, p.x, p.z) - sim.terrainAt(p.x, p.z) }; };
    const r = { id: e.id, side: 0, sideThrough: 0, under: null };
    for (let d = 5; d < e.length; d += 12) {
      const p = at(d);
      if (p.lift < 0.8 || p.lift > 3.2) continue;
      for (const sg of [1, -1]) {
        const nx = -p.tz * sg, nz = p.tx * sg, far = e.width * 0.5 + 12;
        r.side++;
        const hd = Math.atan2(-nx, -nz);
        if (run(p.x + nx * far, p.z + nz * far, hd, 150, (q) => (q.x - p.x) * nx + (q.z - p.z) * nz < -2 && q.y < p.lift + sim.terrainAt(p.x, p.z) - 0.3)) r.sideThrough++;
      }
    }
    // Underneath, from where there is 5 m, heading down to the foot.
    for (let d = 5; d < e.length; d += 3) {
      const p = at(d);
      if (p.lift < 5) continue;
      const q = at(d - 6), hd = Math.atan2(q.x - p.x, q.z - p.z);
      r.under = run(p.x, p.z, hd, 240, (w) => {
        const t = G.nearestEdge ? null : null; void t;
        let best = Infinity, lift = 9;
        for (let dd = 0; dd < d; dd += 3) { const o = at(dd), k = Math.hypot(o.x - w.x, o.z - w.z); if (k < best) { best = k; lift = o.lift; } }
        return best < 4 && lift < 2;
      });
      break;
    }
    out.push(r);
  }
  return { ramps: out.length, sides: out.reduce((a, r) => a + r.side, 0), sideThrough: out.reduce((a, r) => a + r.sideThrough, 0), underThrough: out.filter((r) => r.under).length, out };
}
