// Behaviour measurement harness, loaded from the page console during
// verification. Drives the player with the same controller the police use, and
// forces contact so that driving quality is measured rather than perception.
window.__runHarness = async function (seconds = 90, seed = null) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player, gr = g.graph;
    if (!p) { window.__res = 'NO PLAYER (still at the menu?)'; return; }
    // A different chase for each seed. Runs are chaotic -- one collision early
    // on changes everything after it -- so compare versions over several.
    if (seed !== null) {
      let s = seed >>> 0;
      g.rng = () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const errs = [];
    window.onerror = (m) => { errs.push(String(m).slice(0, 140)); };
    g.stepHeadless(0.6, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });

    // ---- a quarry that actually drives ----
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.6;
    // The quarry plans without the turn-at-this-junction step, which only
    // police routing should be judged on: given it too, the quarry got a third
    // faster and every "how close are the police" number measured the quarry.
    // Older copies of the game have no _pathAhead and use the full planner,
    // which in them is the same thing.
    const plan = gr._pathAhead ? gr._pathAhead.bind(gr) : gr.pathFromPosition.bind(gr);
    const rp = () => {
      const to = gr.randomNode(g.rng);
      const pts = plan(p.position.x, p.position.z, p.forward.x, p.forward.z, to.id, 2.5, Infinity);
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
    const off = [], pspd = [], police = [], byRole = {}, nearest = [];
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

    // ---- manoeuvres ----
    // Whether the tactics actually happen, which is a different question from
    // whether the units drive well. A box that is never called and a PIT that
    // never reaches the strike both look like a tidy pursuit in every other
    // number here.
    let pits = 0, strikes = 0, spinTicks = 0, boxes = 0, boxTicks = 0;
    let formedTicks = 0, pinTicks = 0, wayTicks = 0;
    let lastPit = null, lastBox = null;
    const struck = new Set();

    const steps = Math.round(seconds / 0.1);
    for (let i = 0; i < steps; i++) {
      g.stepHeadless(0.1);
      pspd.push(p.speed * 3.6);

      const ap = g.dispatcher.activePit;
      if (ap && ap !== lastPit) { lastPit = ap; pits++; }
      if (!ap) lastPit = null;
      if (ap) {
        if (ap.pitState && ap.pitState.phase === 'strike' && !struck.has(ap)) {
          struck.add(ap); strikes++;
        }
        if (Math.abs(p.yawRate) > 1.7) spinTicks++;
      }

      const ba = g.dispatcher.boxAssignment;
      if (ba && ba !== lastBox) { lastBox = ba; boxes++; }
      if (!ba) lastBox = null;
      if (ba) {
        boxTicks++;
        let inPlace = 0;
        for (const [u, slot] of ba) {
          const rx = u.position.x - p.position.x, rz = u.position.z - p.position.z;
          const lo = rx * p.forward.x + rz * p.forward.z;
          const la = rx * p.left.x + rz * p.left.z;
          if (Math.hypot(la - slot.x, lo - slot.z) < 4) inPlace++;
        }
        if (inPlace >= 3) formedTicks++;
      }
      if (g.heat.bustPinned) pinTicks++;
      for (const u of g.dispatcher.units) {
        if (u.driver && u.driver.wayCap < Infinity) { wayTicks++; break; }
      }
      maxB = Math.max(maxB, g.roadblocks.blocks.length);
      // How close the pursuit is keeping to the car: the nearest working unit.
      let near = Infinity;
      for (const u of g.dispatcher.units) {
        if (u.vehicle.disabled || !chase.has(u.role)) continue;
        near = Math.min(near, Math.hypot(u.position.x - p.position.x, u.position.z - p.position.z));
      }
      if (isFinite(near)) nearest.push(near);
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
      nearestUnitMedianM: med(nearest),
      within40mPct: nearest.length ? +(100 * nearest.filter((x) => x < 40).length / steps).toFixed(1) : null,
      wellOffRoadPct: off.length ? +(100 * off.filter((x) => x > 6).length / off.length).toFixed(1) : null,
      byRoleWellOffRoadPct: roles,
      wreckedPct: +(100 * wreck / Math.max(1, t)).toFixed(1),
      roadblockMaxAlive: maxB,
      manoeuvres: {
        pitsAuthorised: pits,
        reachedStrike: strikes,
        secondsTargetSpun: +(spinTicks * 0.1).toFixed(1),
        boxesCalled: boxes,
        secondsBoxRunning: +(boxTicks * 0.1).toFixed(1),
        secondsThreeInPlace: +(formedTicks * 0.1).toFixed(1),
        secondsPinned: +(pinTicks * 0.1).toFixed(1),
        secondsSomebodyGivingWay: +(wayTicks * 0.1).toFixed(1),
      },
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
