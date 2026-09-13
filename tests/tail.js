// Can they keep up with a car that does not stop?
//
// The chase harness measures police against a quarry that the police
// themselves slow down -- boxes, blocks, shunts -- so every number in it moves
// with every other. This takes the quarry out of the loop: the player's car is
// moved along a fixed route through the city at a fixed speed, whatever
// happens around it, and the police chase it at two stars (pursuit and
// intercepts, no contact tactics). What is left is purely how well they drive
// and route to stay with it.
//
// The route is chosen by map position with its own seeded random numbers, so
// it is the same drive in every version of the game.
//
//   nearest     median distance from the car to the closest unit
//   within 40   share of the time any unit is within 40 m
//   lost        share of the time no unit is within 120 m
window.__runTail = async function (seconds = 90, kph = 60, seedValue = 4242) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };

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

    // A long drive: junction to junction across the map, joined up.
    const speed = kph / 3.6;
    const need = speed * seconds + 200;
    const pts = [];
    let at = junctionNear(minX + rnd() * (maxX - minX), minZ + rnd() * (maxZ - minZ));
    let length = 0;
    for (let guard = 0; length < need && guard < 60; guard++) {
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
    const pose = (s) => {
      let i = 1;
      while (i < pts.length - 1 && cum[i] < s) i++;
      const a = pts[i - 1], b = pts[i];
      const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: Math.atan2(b.x - a.x, b.z - a.z) };
    };

    // Start the chase with the car on its route.
    let s = 0;
    const start = pose(0);
    p.teleport({ x: start.x, y: 0.95, z: start.z }, start.h);
    g.heat.reset && g.heat.reset();
    g.heat.value = 0; g.heat.bump(1, 'a test'); g.heat.value = 2.3;

    const k = g.dispatcher.knowledge;
    const realK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      realK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (g.heat.value < 2.1 || g.heat.value > 2.9) g.heat.value = 2.3;
      s += speed * dt;
      const q = pose(s);
      p.teleport({ x: q.x, y: 0.95, z: q.z }, q.h);
      p.setVelocity({ x: Math.sin(q.h) * speed, y: 0, z: Math.cos(q.h) * speed });
      p.repair();
      g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
      origU(dt);
    };

    const chase = new Set(['pursue', 'respond', 'intercept', 'block']);
    const nearest = [], police = [];
    let within = 0, lost = 0, samples = 0, off = 0, offN = 0, firstWithin = null;
    const steps = Math.round(seconds / 0.1);
    for (let i = 0; i < steps; i++) {
      g.stepHeadless(0.1);
      let near = Infinity;
      for (const u of g.dispatcher.units) {
        if (u.vehicle.disabled || !chase.has(u.role)) continue;
        near = Math.min(near, Math.hypot(u.position.x - p.position.x, u.position.z - p.position.z));
        police.push(u.vehicle.speed * 3.6);
        const snap = gr.nearestEdge(u.position.x, u.position.z);
        if (snap) {
          offN++;
          if (Math.hypot(u.position.x - snap.x, u.position.z - snap.z) - snap.edge.width * 0.5 > 6) off++;
        }
      }
      samples++;
      if (near < 40) { within++; if (firstWithin === null) firstWithin = +(i * 0.1).toFixed(1); }
      if (!(near < 120)) lost++;
      if (isFinite(near)) nearest.push(near);
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.dispatcher._updateKnowledge = realK;
    g.forceControls = null;
    if (g.audio) g.audio.muted = false;

    const med = (a) => { const q = a.slice().sort((x, y) => x - y); return q.length ? +q[q.length >> 1].toFixed(1) : null; };
    window.__res = JSON.stringify({
      routeM: Math.round(length), kph,
      nearestMedianM: med(nearest),
      within40Pct: +(100 * within / samples).toFixed(1),
      lostPct: +(100 * lost / samples).toFixed(1),
      firstWithin40s: firstWithin,
      policeKphMedian: med(police),
      wellOffRoadPct: offN ? +(100 * off / offN).toFixed(1) : null,
    });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
