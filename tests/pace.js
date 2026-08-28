// Can they keep up, per wanted level?
//
// Puts one police car directly behind a player driving flat out in a straight
// line and measures how the gap moves. Negative closing means you pull away.
// Also reports the detection radius at each tier, since the two together are
// what "level one is too easy for them" actually means.
window.__runPace = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph, p = g.player, M = window.__modules;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };

    // Longest straight available.
    let best = null;
    for (const e of gr.edges) {
      if (e.width < 14 || e.length < 110) continue;
      if (!best || e.length > best.length) best = e;
    }
    if (!best) { window.__res = 'no straight'; return; }

    const rows = [];
    for (const tier of [1, 2, 3, 4, 5]) {
      // Fresh unit each time so nothing carries over.
      for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
      g.heat.value = tier + 0.25;

      const s0 = gr.pointAt(best, 12);
      const h = Math.atan2(s0.tx, s0.tz);
      const tx = Math.sin(h), tz = Math.cos(h);

      p.teleport({ x: s0.x, y: 0.95, z: s0.z }, h);
      p.repair();
      p.setVelocity({ x: tx * 30, y: 0, z: tz * 30 });

      // One unit 60 m behind, already rolling.
      const kind = tier >= 4 ? 'interceptor' : 'patrol';
      const v = g.createVehicle(kind, kind,
        { x: s0.x - tx * 60, y: 0.95, z: s0.z - tz * 60 }, h, { police: true });
      v.setVelocity({ x: tx * 30, y: 0, z: tz * 30 });
      const off = new M.Officer(g, v, { skill: M.SKILL.advanced, kind });
      off.setRole(M.ROLE.PURSUE);
      g.dispatcher.units.push(off);

      const k = g.dispatcher.knowledge;
      const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
      g.dispatcher._updateKnowledge = (dt, tg) => {
        oK(dt, tg);
        k.seen = true; k.timeSinceSeen = 0;
        k.position.copy(tg.position); k.velocity.copy(tg.linvel);
      };

      const gap0 = 60;
      let t = 0;
      // Player flat out, straight. Re-teleport both onto the line each step so
      // this measures pace alone, not who corners better.
      for (let i = 0; i < 90; i++) {
        g.forceControls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
        g.stepHeadless(1 / 30);
        t += 1 / 30;
      }
      const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z;
      const gap = Math.hypot(dx, dz);
      rows.push({
        tier,
        car: kind,
        pace: +off.pace.toFixed(2),
        boost: +v.assist.boost.toFixed(2),
        sightRadius_m: Math.round(g.dispatcher.sightRange),
        playerKph: Math.round(p.speed * 3.6),
        policeKph: Math.round(v.speed * 3.6),
        gapStart_m: gap0,
        gapEnd_m: Math.round(gap),
        closed_m: Math.round(gap0 - gap),
      });
      g.dispatcher._updateKnowledge = oK;
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = JSON.stringify({ rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 250);
  }
};
