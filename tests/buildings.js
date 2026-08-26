// Do units hit scenery, and if so, who and while doing what?
//
// Impacts are detected as a step change in speed rather than as damage: units
// more than 30 m from the player are damage-shielded, so a damage-based count
// quietly ignores most of the map. Each impact is attributed to the role the
// unit was in and to whether it was on the road at the time, because "police
// drive into buildings" and "police cut corners" are different behaviours and
// only one of them is wanted.
window.__runBuildings = async function (seconds = 120) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }

    g.stepHeadless(0.6, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.6;
    const rp = () => {
      const to = gr.randomNode(g.rng);
      const pts = gr.pathFromPosition(p.position.x, p.position.z, p.forward.x, p.forward.z, to.id, 2.5);
      if (pts.length > 1) auto.setPath(pts);
    };
    let stuck = 0;
    const recover = () => {
      const i = Math.min(auto.pathIndex + 5, auto.path.length - 1);
      const a = auto.path[i], b = auto.path[Math.min(i + 1, auto.path.length - 1)];
      if (!a) return;
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      p.teleport({ x: a.x, y: 0.95, z: a.z }, h); p.repair();
      p.setVelocity({ x: Math.sin(h) * 16, y: 0, z: Math.cos(h) * 16 });
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
    g.heat.value = 0; g.heat.bump(1, 'b'); g.heat.value = 4.2;
    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };

    const prevSpeed = new Map();
    const byRole = {}, hits = [];
    let t = 0, grass = 0, sceneryHits = 0, carHits = 0, stalls = 0;
    const stalled = new Map();
    const spd = [], offRoadSpd = [];

    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      g.stepHeadless(0.1);
      for (const u of g.dispatcher.units) {
        const v = u.vehicle;
        if (u.role === 'hold' || u.role === 'disabled') continue;
        t++;
        const onGrass = g.sim.surfaceAt(v.position.x, v.position.z) === 0;
        if (onGrass) { grass++; offRoadSpd.push(v.speed * 3.6); }
        spd.push(v.speed * 3.6);

        const wasV = prevSpeed.has(u) ? prevSpeed.get(u) : v.speed;
        prevSpeed.set(u, v.speed);
        if (wasV - v.speed > 4) {
          let near = false;
          for (const o of g.vehicles) {
            if (o === v) continue;
            const dd = Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z);
            if (dd < 9.5) { near = true; break; }
          }
          if (near) carHits++;
          else {
            sceneryHits++;
            byRole[u.role] = (byRole[u.role] || 0) + 1;
            if (hits.length < 14) {
              hits.push({
                role: u.role,
                kph: Math.round(wasV * 3.6),
                onGrass,
                wallNear: u.driver.wallNear === undefined ? null : Math.round(u.driver.wallNear),
                speedTarget: Math.round((u.driver.speedTarget || 0) * 3.6),
              });
            }
          }
        }

        const s = stalled.get(u) || 0;
        if (v.speed < 1.5) {
          stalled.set(u, s + 0.1);
          if (s < 3 && s + 0.1 >= 3) stalls++;
        } else stalled.set(u, 0);
      }
      if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const med = (a) => {
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return +s[Math.floor(s.length / 2)].toFixed(1);
    };
    const perMin = (n) => +(n / (t / 600)).toFixed(2);
    window.__res = JSON.stringify({
      map: sessionStorage.getItem('pc.map'), seconds, unitTicks: t,
      sceneryHitsPerCarMin: perMin(sceneryHits),
      carToCarHitsPerCarMin: perMin(carHits),
      sceneryHitsByRole: byRole,
      stallsPerCarMin: perMin(stalls),
      onGrassPct: +(100 * grass / Math.max(1, t)).toFixed(1),
      kphMedian: med(spd),
      kphMedianWhileOffRoad: med(offRoadSpd),
      sampleHits: hits,
    }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
