// Do they try to PIT a fast car?
//
// "Why aren't they like constantly trying to pit maneuver me and like ram me? ... it seems like [it's] only
// when I'm slow, but when I'm going pretty fast they don't seem to." On the map, not past its edge (the force
// drives oddly on the open plate): the longest run of near-straight road, your car held at `kph` down it,
// five stars, the force always knowing where you are, and its own cars coming for you (cars put down behind
// you were taken off the board within two seconds). Run on a fresh page each time; a run carries damage and
// cars into the next.
//
//   await import('/tests/fastpit.js');  __runFastPit(140);   // then window.__fpDone, window.__res
//
//   road       metres of road the run had, and how long it lasted, s
//   pits       PITs ordered (Dispatcher.activePit going to a new unit)
//   strikes    of those, how many reached the strike phase
//   touches    quarter-seconds with a police car touching yours
//   spun       seconds in at which your car was turned more than 45 degrees off the road, or null
//   behind     the nearest police car behind you, m, every 2 s
window.__runFastPit = async function (kph = 140) {
  window.__fpDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.hud); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player, gr = g.graph;
    const { Driver, SKILL } = window.__modules;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat._checkBust = () => {};
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    g.traffic.clear();
    g.traffic.update = () => {};

    // The longest chain of edges, each turning less than 12 degrees from the last, kept to wide roads.
    const dirAt = (e, fromId, end) => {
      const pts = e.a === fromId ? e.points : e.points.slice().reverse();
      const [a, b] = end ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
    };
    let best = null;
    for (const e0 of gr.edges) {
      if (e0.cut || e0.width < 9) continue;
      for (const start of [e0.a, e0.b]) {
        const path = [start];
        let node = start, e = e0, len = 0;
        for (let k = 0; k < 40; k++) {
          const next = e.a === node ? e.b : e.a;
          path.push(next);
          len += e.length;
          const out = dirAt(e, node, true);
          let pick = null, bd = Math.cos(12 * Math.PI / 180);
          for (const id of gr.nodes[next].edges) {
            const f = gr.edges[id];
            if (f === e || f.cut || f.width < 9) continue;
            const d = dirAt(f, next, false);
            const dot = d.x * out.x + d.z * out.z;
            if (dot > bd) { bd = dot; pick = f; }
          }
          if (!pick || path.includes(pick.a === next ? pick.b : pick.a)) break;
          node = next; e = pick;
        }
        if (!best || len > best.len) best = { path, len };
      }
    }
    const pts = gr.pathToPoints(best.path, 0, true);
    const sp = kph / 3.6;
    const s0 = pts[0], s1 = pts[Math.min(4, pts.length - 1)];
    const h = Math.atan2(s1.x - s0.x, s1.z - s0.z);
    p.repair();
    p.teleport({ x: s0.x, y: g.groundAt(s0.x, s0.z) + 0.95, z: s0.z }, h);
    p.setVelocity({ x: Math.sin(h) * sp, y: 0, z: Math.cos(h) * sp });
    const drv = new Driver(p, SKILL.pursuit);
    drv.setPath(pts);
    g.heat.bump(1, 'a probe');
    g.heat.value = 5;
    g.helicopter.reset();
    g.heliGrounded = true;
    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };
    // Slow until one of them is on your tail, then up to the speed: what is measured is what they do once
    // they have caught you, not how long they take to.
    const WAIT_KPH = 60;
    let caught = false, caughtAt = null;
    let pits = 0, strikes = 0, touches = 0, spunAt = null, last = null, t = 0;
    const seen = new Set(), behind = [], roles = {}, pitLog = [];
    const end = pts[pts.length - 1];
    for (let i = 0; i < 4 * 60; i++) {
      // Steered down the road by the driver every thirtieth of a second, held at the speed by hand.
      // Its own steering is the game driver's planner, which is for chase speeds and lost the road at 140;
      // this is a plain look-ahead: aim at the line a second and a bit up the road.
      for (let j = 0; j < 8; j++) {
        drv._trackPath();
        const look = Math.max(25, p.speed * 1.2);
        let k2 = drv.pathIndex, run = 0;
        while (k2 < pts.length - 1 && run < look) { run += Math.hypot(pts[k2 + 1].x - pts[k2].x, pts[k2 + 1].z - pts[k2].z); k2++; }
        const aim = pts[k2];
        const dx = aim.x - p.position.x, dz = aim.z - p.position.z;
        const ang = Math.atan2(dx * p.left.x + dz * p.left.z, dx * p.forward.x + dz * p.forward.z);
        const steer = Math.max(-1, Math.min(1, ang * 3));
        const want = caught ? sp : WAIT_KPH / 3.6;
        const throttle = p.forwardSpeed < want ? 1 : 0;
        g.stepHeadless(1 / 30, { throttle, brake: p.forwardSpeed > want + 3 ? 0.3 : 0, steer, handbrake: 0 });
      }
      t += 0.25;
      if (!caught) {
        for (const un of g.dispatcher.units) {
          const v = un.vehicle;
          const lng = (v.position.x - p.position.x) * p.forward.x + (v.position.z - p.position.z) * p.forward.z;
          if (lng < 0 && lng > -30 && Math.abs((v.position.x - p.position.x) * p.left.x + (v.position.z - p.position.z) * p.left.z) < 10) { caught = true; caughtAt = t; }
        }
        if (!caught) { if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0)); if (t > 60) break; continue; }
      }
      const u = g.dispatcher.activePit;
      if (u && u !== last) pits++;
      last = u;
      if (u && u.pitState && u.pitState.phase === 'strike' && !seen.has(u)) { seen.add(u); strikes++; }
      // The PIT car's speed against yours, and how far behind it is, every second of the attempt.
      if (u && i % 4 === 0) {
        const lng = (u.vehicle.position.x - p.position.x) * p.forward.x + (u.vehicle.position.z - p.position.z) * p.forward.z;
        // And which of the driver's limits is holding it (Driver.caps), km/h: asked for, then what each allows.
        const c = u.driver && u.driver.caps;
        const cap = c ? Object.entries(c).filter(([, v]) => typeof v === 'number' && v < 200).map(([kk, v]) => `${kk}${Math.round(v * 3.6)}`).join(' ') : '';
        pitLog.push(`${Math.round(u.vehicle.speed * 3.6)}/${Math.round(p.speed * 3.6)}km/h ${Math.round(-lng)}m ${(u.pitState && u.pitState.phase) || ''} [${cap}]`);
      }
      let touching = false;
      g.world.contactPairsWith(p.collider, (o) => { if (o.__vehicle && o.__vehicle.isPolice) touching = true; });
      if (touching) touches++;
      let near = Infinity;
      for (const un of g.dispatcher.units) {
        if (un.human) continue;
        roles[un.role] = (roles[un.role] || 0) + 1;
        const lng = (un.vehicle.position.x - p.position.x) * p.forward.x + (un.vehicle.position.z - p.position.z) * p.forward.z;
        if (lng < 0) near = Math.min(near, -lng);
      }
      if (i % 8 === 0) behind.push(near === Infinity ? '-' : Math.round(near));
      // Turned more than 45 degrees from the road's own direction where it is: spun, or put off it.
      const a = drv.path[Math.min(drv.path.length - 2, drv.pathIndex)], b = drv.path[Math.min(drv.path.length - 1, drv.pathIndex + 1)];
      if (spunAt === null && t > 2 && a && b) {
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
        if ((dx * p.forward.x + dz * p.forward.z) / l < 0.7) spunAt = t;
      }
      if (Math.hypot(p.position.x - end.x, p.position.z - end.z) < 25 || spunAt !== null) break;
      if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = { kph, road: Math.round(best.len), caughtAt, measuredSecs: caughtAt === null ? 0 : +(t - caughtAt).toFixed(2), secs: t, pits, strikes, touches, spunAt, behind: behind.join(' '), pit: pitLog.join(', '), roles };
  } catch (e) {
    window.__res = 'ERR ' + (e.stack || e);
  }
  window.__fpDone = true;
  return window.__res;
};
