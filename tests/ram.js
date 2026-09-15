// Does a unit on your tail actually hit you?
//
// One police car, forty metres behind the player, told to pursue and nothing
// else: no dispatcher, no other units, no tactics. The player is driven along
// a route by the same controller the police use, capped at a steady speed, so
// the only question is what the pursuer does once it has caught up.
//
//   firstHit   seconds until the first contact
//   hits       contacts in the run, and how hard they land on average (m/s)
//   closing    how much faster than the player the pursuer was going when it
//              hit, on average (m/s) -- the ram itself, rather than the knock
//   scenery    times the pursuer hit something that was not the player
window.__runRam = async function (tier = 3, kph = 70, seconds = 30, seed = 4242) {
  try {
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.restart();
    const wasPaused = g.paused;
    g.paused = true;   // the render loop would otherwise step the chase between awaits
    // Nobody else: the dispatcher is switched off and only this unit updates.
    const realDispatch = g.dispatcher.update.bind(g.dispatcher);
    const realRoadblocks = g.roadblocks.update.bind(g.roadblocks);
    g.roadblocks.update = () => {};

    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // A long route: junction to junction across the map, joined up, until
    // there is more road than the run needs.
    const nodes = gr.nodes.filter((n) => n.edges.length >= 3);
    const need = (kph / 3.6) * seconds + 300;
    const pts = [];
    let at = nodes[Math.floor(rnd() * nodes.length)], length = 0;
    for (let guard = 0; length < need && guard < 60; guard++) {
      const to = nodes[Math.floor(rnd() * nodes.length)];
      if (to === at || Math.hypot(to.x - at.x, to.z - at.z) < 300) continue;
      const ids = gr.route(at.id, to.id);
      if (!ids || ids.length < 2) continue;
      const seg = gr.pathToPoints(ids, 2.4);
      for (const q of (pts.length ? seg.slice(1) : seg)) {
        if (pts.length) length += Math.hypot(q.x - pts[pts.length - 1].x, q.z - pts[pts.length - 1].z);
        pts.push(q);
      }
      at = to;
    }
    const start = pts[4], next = pts[5];
    const h = Math.atan2(next.x - start.x, next.z - start.z);
    p.repair();
    p.teleport({ x: start.x, y: 0.95, z: start.z }, h);
    p.setVelocity({ x: Math.sin(h) * kph / 3.6, y: 0, z: Math.cos(h) * kph / 3.6 });
    p._readState();   // otherwise the first frame steers from where the car was before the teleport
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.6;
    auto.setPath(pts.slice(4));

    // The pursuer, forty metres back along the same road.
    const back = { x: start.x - Math.sin(h) * 40, z: start.z - Math.cos(h) * 40 };
    const v = g.createVehicle('interceptor', 'interceptor', { x: back.x, y: 0.95, z: back.z }, h, { police: true });
    v.setVelocity({ x: Math.sin(h) * kph / 3.6, y: 0, z: Math.cos(h) * kph / 3.6 });
    v._readState();
    const u = new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'interceptor' });
    g.dispatcher.units.push(u);
    u.setRole(M.ROLE.PURSUE);
    g.heat.value = 0; g.heat.bump(1, 'test'); g.heat.value = tier + 0.3;

    const k = g.dispatcher.knowledge;
    g.dispatcher.update = (dt, target) => {
      g.dispatcher.clock += dt;
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(target.position); k.velocity.copy(target.linvel);
      if (u.role !== M.ROLE.PURSUE) u.setRole(M.ROLE.PURSUE);
      u.update(dt, target);
    };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = tier + 0.3;
      if (p.damage > 0.5) p.repair();
      auto.avoid(g.vehicles, dt);
      g.forceControls = Object.assign({}, auto.followPath(dt, kph / 3.6));
      origU(dt);
    };

    let t = 0, firstHit = null, hits = 0, dvSum = 0, scenery = 0, pAt = 0, uAt = 0;
    let closeSum = 0, rel = 0;
    const gaps = [];
    while (t < seconds && auto.remaining() > 30) {
      // Closing speed from before the step: by the end of it the hit has
      // already evened the two cars out.
      rel = v.linvel.dot(p.forward) - p.forwardSpeed;
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      const gap = u.distanceTo(p.position);
      gaps.push(gap);
      if (p.lastImpactAt && p.lastImpactAt !== pAt) {
        pAt = p.lastImpactAt;
        if (gap < 7) { hits++; dvSum += p.lastImpact; closeSum += rel; if (firstHit === null) firstHit = +t.toFixed(1); }
      }
      if (v.lastImpactAt && v.lastImpactAt !== uAt) {
        uAt = v.lastImpactAt;
        if (gap > 7) scenery++;
      }
      if (Math.floor(t * 30) % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.dispatcher.update = realDispatch;
    g.roadblocks.update = realRoadblocks;
    g.forceControls = null;
    g.paused = wasPaused;
    gaps.sort((a, b) => a - b);
    return {
      tier, kph, seconds: +t.toFixed(0), firstHit, hits, hitDv: hits ? +(dvSum / hits).toFixed(1) : 0,
      closing: hits ? +(closeSum / hits).toFixed(1) : 0,
      scenery, medianGap: +gaps[gaps.length >> 1].toFixed(1), mode: u._mode || null,
    };
  } catch (e) {
    return 'EX ' + e.message + ' ' + String(e.stack).slice(0, 300);
  }
};
