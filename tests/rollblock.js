// The rolling roadblock: several cars abreast in front of you, slowing together.
//
// "It'd be nice if you could try and make, like, rolling roadblocks." There was
// already a one-car rolling block (README, "The rolling block"); this asks
// whether the multi-car one does what the name promises. Set up like
// tests/rhino.js: the player is driven down a long road at a fixed speed by the
// same Driver the police use -- which steers round any car in its way, so if
// the line leaves a gap it will find it -- and a rolling block is sent in front
// of it the way the dispatcher sends one at four stars. Nothing else is on the
// roster.
//
//   cars        how many the block came out as (1 means the road was too narrow)
//   onIt        seconds the player spent within 30 m behind the line
//   from/to     the player's speed when it first got there, and the lowest after
//   got past    whether it got by, and after how long behind the line
//   widestGap   the widest opening across the road the player had while on it
//               -- kerb to car, car to car -- against the 2.6 m a car needs
//
//   await import('/tests/rollblock.js');
//   await __runRollBlock(110, 25, [11, 22, 33, 44, 55, 66]);
//   window.__oneCarBlock = true;  // ... and again, for the one-car block
window.__runRollBlock = async function (kph = 110, seconds = 25, seeds = [11, 22, 33, 44, 55, 66]) {
  const rows = [];
  for (const seed of seeds) rows.push(await runOne(kph, seconds, seed));
  return rows.join('\n');
};

/**
 * A police car on the player's own route, `ahead` metres up it, facing along
 * it and already rolling -- the same car Game.spawnPoliceAhead would make, in
 * a place chosen by the route rather than by prediction.
 */
function placeOnRoute(g, M, auto, p, ahead) {
  const path = auto.path;
  if (!path || path.length < 3) return null;
  let i = auto.pathIndex || 0, acc = 0;
  let prev = { x: p.position.x, z: p.position.z };
  for (; i < path.length - 1; i++) {
    acc += Math.hypot(path[i].x - prev.x, path[i].z - prev.z);
    prev = path[i];
    if (acc >= ahead) break;
  }
  if (acc < ahead * 0.8 || i >= path.length - 1) return null;
  const a = path[i], b = path[i + 1];
  const heading = Math.atan2(b.x - a.x, b.z - a.z);
  const pos = { x: a.x, y: 0.95, z: a.z };
  if (g.sim.surfaceAt(pos.x, pos.z) !== 1) return null;
  const v = g.createVehicle('interceptor', 'interceptor', pos, heading, { police: true });
  if (!v) return null;
  v.setVelocity({ x: Math.sin(heading) * 18, y: 0, z: Math.cos(heading) * 18 });
  return new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'interceptor' });
}

async function runOne(kph, seconds, seed) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.restart();

    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    g.rng = rnd;

    // A long run on wide roads, where a block of more than one car fits.
    const nodes = gr.nodes.filter((n) => n.edges.length >= 2
      && n.edges.some((id) => gr.edges[id].width >= 9));
    const pts = [];
    let at = nodes[Math.floor(rnd() * nodes.length)], length = 0;
    for (let guard = 0; length < (kph / 3.6) * seconds + 600 && guard < 60; guard++) {
      const to = nodes[Math.floor(rnd() * nodes.length)];
      if (to === at || Math.hypot(to.x - at.x, to.z - at.z) < 400) continue;
      const ids = gr.route(at.id, to.id);
      if (!ids || ids.length < 2) continue;
      const seg = gr.pathToPoints(ids, 2.4);
      for (const q of (pts.length ? seg.slice(1) : seg)) {
        if (pts.length) length += Math.hypot(q.x - pts[pts.length - 1].x, q.z - pts[pts.length - 1].z);
        pts.push(q);
      }
      at = to;
    }
    if (pts.length < 10) return `seed ${seed}: no route`;

    const start = pts[4], next = pts[5];
    const h = Math.atan2(next.x - start.x, next.z - start.z);
    p.repair();
    p.teleport({ x: start.x, y: 0.95, z: start.z }, h);
    p.setVelocity({ x: Math.sin(h) * kph / 3.6, y: 0, z: Math.cos(h) * kph / 3.6 });
    p._readState();
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 2.4;
    auto.setPath(pts.slice(4));

    g.heat.value = 0; g.heat.bump(1, 'test'); g.heat.value = 4.3;
    const D = g.dispatcher, k = D.knowledge;
    for (const u of D.units.slice()) D.retire(u);
    const realDispatch = D.update.bind(D);
    const realBlocks = g.roadblocks.update.bind(g.roadblocks);
    g.roadblocks.update = () => {};
    let line = [];
    D.update = (dt, target) => {
      D.clock += dt;
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(target.position); k.velocity.copy(target.linvel);
      D._trackCourse(dt, target);
      for (const u of line) u.update(dt, target);
    };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = 4.3;
      auto.avoid(g.vehicles, dt);
      g.forceControls = Object.assign({}, auto.followPath(dt, kph / 3.6));
      origU(dt);
    };

    let t = 0, sentAt = null, onIt = 0, from = null, low = Infinity, past = null, widest = 0;
    let tries = 0;
    while (t < seconds && auto.remaining() > 30) {
      // Only once the car is committed to a road and going at it -- like the van
      // in tests/rhino.js. Sent at any old moment, the site ahead was usually up
      // a road the route then turned away from, 80-150 m off to one side, and the
      // block was never met at all.
      if (!line.length && p.speed > 15 && t > 3 && tries < 40
        && Math.floor(t * 30) % 15 === 0) {
        tries++;
        // One car ahead, then the rest abreast -- but the first is put on the
        // car's own route, 150 m up it, rather than wherever the dispatcher would
        // guess. Where a block is sited is a separate question; this rig asks
        // whether the line, once it is in front of you, closes the road and
        // slows you. Left to the dispatcher's siting, the random route turned
        // off before the block nearly every time, and redrawing the route
        // through the block gave the driver U-turns it crawled round.
        const u = placeOnRoute(g, M, auto, p, 150);
        if (u) {
          D.units.push(u);
          u.setRole(M.ROLE.BLOCK);
          line = [u];
          const ab = window.__oneCarBlock ? null : g.spawnBlockMates(u, 4);
          if (ab) {
            const group = { members: [u], ended: false, squeeze: 0 };
            u.setRole(M.ROLE.BLOCK, { group, slot: ab.leaderSlot });
            for (const m of ab.mates) {
              D.units.push(m.officer);
              m.officer.setRole(M.ROLE.BLOCK, { group, slot: m.slot });
              group.members.push(m.officer);
              line.push(m.officer);
            }
          }
          sentAt = t;
        }
      }
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;

      const blocking = line.filter((u) => u.role === M.ROLE.BLOCK);
      if (line.length && !blocking.length && past === null && onIt > 0) past = onIt;
      if (blocking.length) {
        // How far ahead of the player the line is, along the player's heading.
        const fx = p.forward.x, fz = p.forward.z;
        let ahead = Infinity;
        for (const u of blocking) {
          const a = (u.position.x - p.position.x) * fx + (u.position.z - p.position.z) * fz;
          ahead = Math.min(ahead, a);
        }
        if (ahead > 0 && ahead < 30) {
          onIt += 1 / 30;
          if (from === null) from = p.speed * 3.6;
          low = Math.min(low, p.speed * 3.6);
          // The openings across the road at the line, kerb to car to car to kerb.
          const snap = gr.nearestEdge(blocking[0].position.x, blocking[0].position.z);
          if (snap) {
            const q = gr.pointAt(snap.edge, snap.along);
            const lats = blocking.map((u) => (u.position.x - snap.x) * q.tz - (u.position.z - snap.z) * q.tx).sort((a, b) => a - b);
            const halfRoad = snap.edge.width * 0.5, halfCar = 1.0;
            let gap = (lats[0] - halfCar) - (-halfRoad);
            for (let i = 1; i < lats.length; i++) gap = Math.max(gap, (lats[i] - halfCar) - (lats[i - 1] + halfCar));
            gap = Math.max(gap, halfRoad - (lats[lats.length - 1] + halfCar));
            widest = Math.max(widest, gap);
          }
        }
      }
      if (p.damage > 0.5) p.repair();
      if (Math.floor(t * 30) % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    D.update = realDispatch;
    g.roadblocks.update = realBlocks;
    g.forceControls = null;
    g.paused = wasPaused;
    for (const u of line) if (D.units.includes(u)) D.retire(u);
    D.blockUnit = null;
    D.blockMates = [];
    if (sentAt === null) return `seed ${seed}: no block could be placed`;
    return `seed ${seed}: cars ${line.length}  onIt ${onIt.toFixed(1)}s  `
      + `from ${from === null ? '-' : Math.round(from)} to ${low === Infinity ? '-' : Math.round(low)} kph  `
      + `got past ${past === null ? (onIt > 0 ? 'NO (held to the end)' : '-') : `after ${past.toFixed(1)}s`}  `
      + `widestGap ${onIt > 0 ? widest.toFixed(1) + ' m' : '-'}${window.__oneCarBlock ? '  (one-car block)' : ''}`;
  } catch (e) {
    return `seed ${seed}: EX ${e.message} ${String(e.stack).slice(0, 300)}`;
  }
}
