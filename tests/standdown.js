// What happens after a chase ends, and whether the manoeuvres actually close.
//
// Three questions the game cannot answer by being looked at:
//
// 1. Escaping used to end the run. It should now clear the heat, put the force
//    back on patrol, thin the roster back to an ambient patrol, and leave the
//    car under your control the whole time.
// 2. A box is called on units up to forty metres out and used to be told to
//    hold the target's speed, so it could never close. This crawls along with
//    a full-tier response and measures whether the box ever shuts.
// 3. A PIT authorised from thirty metres back has twelve seconds to reach the
//    strike window. Measured: whether it gets there, and how long it takes.
window.__runStandDown = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    if (!g.player) { window.__res = 'NO PLAYER'; return; }
    const gr = g.graph, rows = [];

    const pick = (minWidth, minLen) => {
      let best = null;
      for (const e of gr.edges) {
        if (e.dead || e.turningHead) continue;
        if (e.width < minWidth || e.length < minLen) continue;
        if (!best || e.length > best.length) best = e;
      }
      return best;
    };

    const placeOnRoad = (edge, along) => {
      const s = gr.pointAt(edge, along);
      const h = Math.atan2(s.tx, s.tz);
      g.player.teleport({ x: s.x, y: 0.9, z: s.z }, h);
      g.player.setVelocity({ x: 0, y: 0, z: 0 });
      return s;
    };

    // Where a unit sits in the player's frame -- the same thing tactics.js
    // works in, written out here so the test needs nothing exported for it.
    const rel = (unit) => {
      const p = g.player;
      const dx = unit.position.x - p.position.x, dz = unit.position.z - p.position.z;
      return {
        long: dx * p.forward.x + dz * p.forward.z,
        lat: dx * p.left.x + dz * p.left.z,
      };
    };

    // Each phase starts from a clean sheet: an arrest in one of them ends the
    // run, and everything after that would be measuring a stationary car.
    const freshStart = () => {
      g.outcome = null;
      g.hud.hideOverlay();
      g.heat.reset();
      g.dispatcher.reset();
      g.player.repair();
    };

    const setHeat = (value) => {
      g.heat.bump(1, 'a test');
      g.heat.value = value;
      g.heat.peak = value;
      g.heat.evadeTimer = 0;
    };

    // =============================================== 1. escape and stand down
    freshStart();
    const road = pick(10, 200);
    placeOnRoad(road, 40);
    setHeat(3.4);
    // Let the response build up around us.
    g.stepHeadless(14, { throttle: 0.55, brake: 0, steer: 0, handbrake: 0 });
    const peakUnits = g.dispatcher.units.length;

    // Now become invisible. Rather than hiding the car somewhere the engine
    // would object to, stub the one thing an escape actually depends on: the
    // shared model of where you are stops being updated, the search window
    // runs out, and the heat decays. That is the real path to onEscaped.
    const realKnowledge = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt) => {
      const k = g.dispatcher.knowledge;
      k.seen = false;
      k.spotter = null;
      k.confidence = 0;
      k.timeSinceSeen += dt;
    };
    let escapedAfter = null;
    for (let s = 0; s < 220; s++) {
      g.stepHeadless(1, { throttle: 0, brake: 0, steer: 0, handbrake: 1 });
      if (g.heat.value <= 0) { escapedAfter = s + 1; break; }
    }
    g.dispatcher._updateKnowledge = realKnowledge;

    rows.push(['units at tier 3', String(peakUnits)]);
    rows.push(['heat cleared after', escapedAfter === null ? 'never' : `${escapedAfter}s`]);
    rows.push(['outcome (should be null)', String(g.outcome)]);

    const roles = {};
    for (const u of g.dispatcher.units) roles[u.role] = (roles[u.role] || 0) + 1;
    rows.push(['roles right after', Object.entries(roles)
      .map(([k, v]) => `${k} ${v}`).join(', ') || 'none']);

    // Drive off for a while; the surplus should be gone by the end of it.
    // Put the car back on the road first: it spent the chase being rammed by
    // five units and is usually wedged against something by now, which says
    // nothing about whether the game is still playable.
    placeOnRoad(road, Math.min(road.length - 25, 150));
    g.player.repair();
    // Distance covered, not speed at the end: this drives open-loop for fifty
    // seconds and will eventually put itself in a hedge, which says nothing
    // about whether the game was still playable when it did.
    const from = g.player.position.clone();
    g.stepHeadless(50, { throttle: 0.6, brake: 0, steer: 0, handbrake: 0 });
    const moved = g.player.position.distanceTo(from);
    rows.push(['units 50s later', `${g.dispatcher.units.length}`
      + ` (ambient is ${g.dispatcher.rules.units})`]);
    rows.push(['heat', g.heat.value.toFixed(2)]);
    rows.push(['drove on, under control', `${moved.toFixed(0)} m in 50s`]);
    rows.push(['', '']);

    // ============================================================ 2. the box
    freshStart();
    const wide = pick(14, 260) || road;
    placeOnRoad(wide, 60);
    setHeat(4.6);
    // Crawl, which is exactly when a box is the right answer.
    g.stepHeadless(20, { throttle: 0.18, brake: 0, steer: 0, handbrake: 0 });

    let boxCalled = false, closedAt = null, tightest = 0, bestInPlace = 0;
    let pinnedFor = 0, bustedAt = null;
    for (let s = 0; s < 70; s++) {
      g.stepHeadless(1, { throttle: 0.18, brake: 0, steer: 0, handbrake: 0 });
      // What the box is actually for, from the player's side of it: being
      // unable to move with a police car against you. Standing in the right
      // slot to the centimetre is the means, not the end.
      if (g.heat.bustPinned) pinnedFor++;
      if (g.outcome === 'busted' && bustedAt === null) bustedAt = s + 1;
      const a = g.dispatcher.boxAssignment;
      if (!a) continue;
      boxCalled = true;
      tightest = Math.max(tightest, g.dispatcher.boxTightness);
      let inPlace = 0;
      for (const [unit, slot] of a) {
        const r = rel(unit.vehicle);
        if (Math.hypot(r.lat - slot.x, r.long - slot.z) < 3.2) inPlace++;
      }
      bestInPlace = Math.max(bestInPlace, inPlace);
      if (inPlace >= 3 && closedAt === null) closedAt = s + 1;
    }
    rows.push(['box called', String(boxCalled)]);
    rows.push(['three in their slots after', closedAt === null ? 'never' : `${closedAt}s`]);
    rows.push(['most in place at once', String(bestInPlace)]);
    rows.push(['tightness reached', tightest.toFixed(2)]);
    rows.push(['seconds pinned by a unit', String(pinnedFor)]);
    rows.push(['arrested after', bustedAt === null ? 'not arrested' : `${bustedAt}s`]);
    rows.push(['', '']);

    // ============================================================ 3. the PIT
    freshStart();
    placeOnRoad(wide, 60);
    setHeat(3.6);
    let pits = 0, strikes = 0, spinFrames = 0;
    const setupTime = [];
    const seen = new Map();
    for (let s = 0; s < 160; s++) {
      g.stepHeadless(0.5, { throttle: 0.62, brake: 0, steer: 0, handbrake: 0 });
      const u = g.dispatcher.activePit;
      if (u) {
        if (!seen.has(u)) { seen.set(u, { t: 0, struck: false }); pits++; }
        const rec = seen.get(u);
        rec.t += 0.5;
        if (u.pitState && u.pitState.phase === 'strike' && !rec.struck) {
          rec.struck = true; strikes++; setupTime.push(rec.t);
        }
      }
      if (Math.abs(g.player.yawRate) > 1.7) spinFrames++;
    }
    setupTime.sort((a, b) => a - b);
    rows.push(['PITs authorised', String(pits)]);
    rows.push(['reached the strike', String(strikes)]);
    rows.push(['setup took, median', setupTime.length
      ? `${setupTime[setupTime.length >> 1].toFixed(1)}s` : '-']);
    rows.push(['half-seconds spun', String(spinFrames)]);

    window.__res = rows.map((r) => `${r[0].padEnd(28)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 600);
  }
};
