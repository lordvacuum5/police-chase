// Behaviour measurement harness, loaded from the page console during
// verification. Drives the player with the same controller the police use, and
// forces contact so that driving quality is measured rather than perception.
window.__runHarness = async function (seconds = 90) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player, gr = g.graph;
    if (!p) { window.__res = 'NO PLAYER (still at the menu?)'; return; }

    const errs = [];
    window.onerror = (m) => { errs.push(String(m).slice(0, 140)); };
    g.stepHeadless(0.6, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });

    // ---- a quarry that actually drives ----
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.6;
    const rp = () => {
      const to = gr.randomNode(g.rng);
      const pts = gr.pathFromPosition(p.position.x, p.position.z, p.forward.x, p.forward.z, to.id, 2.5);
      if (pts.length > 1) auto.setPath(pts);
    };
    let stuck = 0, nudges = 0;
    // Nudge back onto the path rather than teleporting across the map: a long
    // jump breaks contact, and every number here is about what happens while
    // contact is held.
    const recover = () => {
      const i = Math.min(auto.pathIndex + 5, auto.path.length - 1);
      const a = auto.path[i], b = auto.path[Math.min(i + 1, auto.path.length - 1)];
      if (!a) return;
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      p.teleport({ x: a.x, y: 0.95, z: a.z }, h);
      p.repair();
      p.setVelocity({ x: Math.sin(h) * 16, y: 0, z: Math.cos(h) * 16 });
      nudges++;
    };
    const origU = g._update.bind(g);
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; recover(); };
    g.onEscaped = () => { g.outcome = null; };
    g._update = (dt) => {
      if (p.damage > 0.5) p.repair();
      if (g.heat.value < 4.0) g.heat.value = 4.2;
      if (p.speed < 3) { stuck += dt; if (stuck > 1.5) { recover(); stuck = 0; } } else stuck = 0;
      if (!auto.hasPath || auto.remaining() < 120) rp();
      auto.avoid(g.vehicles, dt);
      g.forceControls = Object.assign({}, auto.followPath(dt, 55));
      origU(dt);
    };
    rp();
    g.heat.value = 0; g.heat.bump(1, 'harness'); g.heat.value = 4.2;

    // ---- force contact ----
    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };

    const chase = new Set(['pursue', 'respond', 'intercept', 'pit', 'box', 'block']);
    const off = [], pspd = [], police = [], byRole = {};
    let t = 0, wreck = 0, maxB = 0;
    const ev = [];
    const lead = (u) => {
      const rx = u.position.x - p.position.x, rz = u.position.z - p.position.z;
      return rx * p.forward.x + rz * p.forward.z;
    };
    const os = g.spawnPoliceAhead.bind(g);
    g.spawnPoliceAhead = (tg, tier) => {
      const r = os(tg, tier);
      ev.push(r ? { unit: r, spawn: Math.round(lead(r)), secs: 0, eng: 0, slow: [] } : { failed: true });
      return r;
    };

    const steps = Math.round(seconds / 0.1);
    for (let i = 0; i < steps; i++) {
      g.stepHeadless(0.1);
      pspd.push(p.speed * 3.6);
      maxB = Math.max(maxB, g.roadblocks.blocks.length);
      for (const u of g.dispatcher.units) {
        if (u.role === 'block') {
          const e = ev.find((x) => x.unit === u);
          if (e) {
            e.secs += 0.1;
            const L = lead(u);
            if (L < 45 && L > -7) { e.eng += 0.1; e.slow.push(p.speed * 3.6); }
          }
        }
        if (!chase.has(u.role)) continue;
        t++;
        if (u.vehicle.disabled) wreck++;
        const snap = gr.nearestEdge(u.position.x, u.position.z);
        if (!snap) continue;
        const d = Math.hypot(u.position.x - snap.x, u.position.z - snap.z);
        const outside = Math.max(0, d - snap.edge.width * 0.5);
        off.push(outside);
        police.push(u.vehicle.speed * 3.6);
        const r = byRole[u.role] || (byRole[u.role] = { n: 0, off: 0 });
        r.n++;
        if (outside > 6) r.off++;
      }
      if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    const med = (a) => {
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return +s[Math.floor(s.length / 2)].toFixed(1);
    };
    const roles = {};
    for (const kk in byRole) roles[kk] = +(100 * byRole[kk].off / byRole[kk].n).toFixed(1);
    const ok = ev.filter((e) => !e.failed);
    window.__res = JSON.stringify({
      map: sessionStorage.getItem('pc.map'), sim_s: seconds, exceptions: errs.length, errs: errs.slice(0, 3),
      nudges, playerKphMedian: med(pspd), policeKphMedian: med(police), chaseTicks: t,
      wellOffRoadPct: off.length ? +(100 * off.filter((x) => x > 6).length / off.length).toFixed(1) : null,
      byRoleWellOffRoadPct: roles,
      wreckedPct: +(100 * wreck / Math.max(1, t)).toFixed(1),
      roadblockMaxAlive: maxB,
      blocker: {
        spawned: ok.length, failed: ev.length - ok.length,
        aheadPct: ok.length ? Math.round(100 * ok.filter((e) => e.spawn > 0).length / ok.length) : null,
        spawnMedian: med(ok.map((e) => e.spawn)),
        lifeMedian: med(ok.map((e) => e.secs)),
        engaged: ok.filter((e) => e.eng > 0.5).length,
        playerKphWhileEngaged: med([].concat(...ok.map((e) => e.slow))),
      },
    }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 200);
  }
};
