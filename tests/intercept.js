// Are the intercepts waiting where the car actually goes?
//
// The player's car is moved along a fixed route across the map -- the same
// route in every version, chosen by map position with its own seeded random
// numbers, like tests/tail.js -- but driven the way a car is driven: up to a
// cruising speed on the straights, braking for corners so it could take them
// (7 m/s^2 across the car), 8 m/s^2 down and 5 back up. Police are held at
// four stars with contact forced, so up to three units are on intercept duty
// the whole time.
//
//   metAtJunction   of the junctions the car went through, the share with a
//                   police car already there -- within 35 m of it and not
//                   simply following the car in
//   predictedPct    of every second a unit spent on intercept, the share
//                   where the car did come through that junction within 25 s
//   nearestMedianM  median distance to the nearest unit
window.__runIntercept = async function (seconds = 90, kph = 110, seedValue = 4242, gameSeed = 101) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    {
      let s = gameSeed >>> 0;
      g.rng = () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    let seed = seedValue;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const n of gr.nodes) {
      if (n.x < minX) minX = n.x; if (n.z < minZ) minZ = n.z;
      if (n.x > maxX) maxX = n.x; if (n.z > maxZ) maxZ = n.z;
    }
    const junctionNear = (x, z) => {
      let best = null, bd = Infinity;
      for (const n of gr.nodes) {
        if (!n || !n.edges || n.edges.length < 3) continue;
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };

    // ---- the route ----
    const cruise = kph / 3.6;
    const need = cruise * seconds + 400;
    const pts = [];
    let at = junctionNear(minX + rnd() * (maxX - minX), minZ + rnd() * (maxZ - minZ));
    let length = 0;
    for (let guard = 0; length < need && guard < 80; guard++) {
      const to = junctionNear(minX + rnd() * (maxX - minX), minZ + rnd() * (maxZ - minZ));
      if (!to || to === at || Math.hypot(to.x - at.x, to.z - at.z) < 250) continue;
      const ids = gr.route(at.id, to.id);
      if (!ids || ids.length < 2) continue;
      const seg = gr.pathToPoints(ids, 2.4);
      for (const q of (pts.length ? seg.slice(1) : seg)) {
        if (pts.length) length += Math.hypot(q.x - pts[pts.length - 1].x, q.z - pts[pts.length - 1].z);
        pts.push({ x: q.x, z: q.z });
      }
      at = to;
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));

    // ---- a speed profile a driver could actually follow ----
    const indexAt = (s) => {
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
      return Math.max(1, lo);
    };
    const pose = (s) => {
      const i = indexAt(s);
      const a = pts[i - 1], b = pts[i];
      const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: Math.atan2(b.x - a.x, b.z - a.z) };
    };
    const STEP = 2;
    const n = Math.ceil(length / STEP) + 1;
    const vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      const a = pose(Math.max(0, s - 8)), b = pose(s), c = pose(Math.min(length, s + 8));
      const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
      let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
      const r = d > 1e-3 ? 16 / d : 1e6;
      vmax[i] = Math.min(cruise, Math.sqrt(7 * r));
    }
    for (let i = 1; i < n; i++) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i - 1] ** 2 + 2 * 5 * STEP));
    for (let i = n - 2; i >= 0; i--) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] ** 2 + 2 * 8 * STEP));
    const speedAt = (s) => vmax[Math.min(n - 1, Math.max(0, Math.round(s / STEP)))];

    let s = 0;
    const start = pose(0);
    p.teleport({ x: start.x, y: 0.95, z: start.z }, start.h);
    g.heat.value = 0; g.heat.bump(1, 'a test'); g.heat.value = 4.3;

    const k = g.dispatcher.knowledge;
    const realK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      realK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };
    const origU = g._update.bind(g);
    let clock = 0;
    g._update = (dt) => {
      if (g.heat.value < 4.05 || g.heat.value > 4.9) g.heat.value = 4.3;
      const v = Math.max(3, speedAt(s));
      s += v * dt;
      clock += dt;
      const q = pose(Math.min(s, length));
      p.teleport({ x: q.x, y: 0.95, z: q.z }, q.h);
      p.setVelocity({ x: Math.sin(q.h) * v, y: 0, z: Math.cos(q.h) * v });
      p.repair();
      g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
      origU(dt);
    };

    const passes = [];            // { id, t }
    let inJunction = null;
    const orders = [];            // { id, t }
    let met = 0, junctions = 0;
    const nearest = [];
    const steps = Math.round(seconds / 0.1);
    for (let i = 0; i < steps && s < length; i++) {
      g.stepHeadless(0.1);
      const px = p.position.x, pz = p.position.z;
      const hx = Math.sin(pose(s).h), hz = Math.cos(pose(s).h);

      // Junction passages, and who was there to meet the car.
      const snap = gr.nearestEdge(px, pz, 30);
      let node = null;
      if (snap) {
        for (const id of [snap.edge.a, snap.edge.b]) {
          const nd = gr.nodes[id];
          if (nd.edges.length >= 3 && Math.hypot(nd.x - px, nd.z - pz) < 10) node = nd;
        }
      }
      if (node && inJunction !== node.id) {
        inJunction = node.id;
        passes.push({ id: node.id, t: clock });
        if (clock > 12) {
          junctions++;
          const there = g.dispatcher.units.some((u) => {
            if (u.vehicle.disabled) return false;
            const dx = u.position.x - node.x, dz = u.position.z - node.z;
            if (Math.hypot(dx, dz) > 35) return false;
            // Following the car in is not meeting it.
            return (u.position.x - px) * hx + (u.position.z - pz) * hz > -4;
          });
          if (there) met++;
        }
      } else if (!node) {
        inJunction = null;
      }

      if (i % 10 === 0) {
        for (const u of g.dispatcher.units) {
          if (u.role === 'intercept' && u.orders && u.orders.node != null) orders.push({ id: u.orders.node, t: clock });
        }
      }
      let near = Infinity;
      for (const u of g.dispatcher.units) {
        if (u.vehicle.disabled) continue;
        near = Math.min(near, Math.hypot(u.position.x - px, u.position.z - pz));
      }
      if (isFinite(near)) nearest.push(near);
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    let hit = 0, judged = 0;
    for (const o of orders) {
      if (o.t > clock - 25) continue;           // not enough run left to judge
      judged++;
      if (passes.some((pp) => pp.id === o.id && pp.t >= o.t && pp.t <= o.t + 25)) hit++;
    }

    g._update = origU;
    g.dispatcher._updateKnowledge = realK;
    g.forceControls = null;

    const med = (a) => { const q = a.slice().sort((x, y) => x - y); return q.length ? +q[q.length >> 1].toFixed(1) : null; };
    window.__res = JSON.stringify({
      kph, seedValue, gameSeed, routeM: Math.round(length),
      junctions, metAtJunctionPct: junctions ? +(100 * met / junctions).toFixed(1) : null,
      interceptSeconds: judged, predictedPct: judged ? +(100 * hit / judged).toFixed(1) : null,
      nearestMedianM: med(nearest),
      straightShare: g.dispatcher.straightShare != null ? +g.dispatcher.straightShare.toFixed(2) : null,
    });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
