// Does a unit arrive at a junction able to take it?
//
// Separates scenery impacts from car-to-car ones: braking harder makes the car
// behind run into you, and counting that as a crash would credit the fix with
// the very problem it caused. Also records how often the road-runout limit is
// the binding constraint, so a change that never fires is not mistaken for one
// that works. Pass mode 'before' to stub out the travel-direction probe and
// the runout check.
window.__runJunction = async function (mode, seconds = 90) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    const P = M.Driver.prototype;

    if (mode === 'before') {
      P.roadRunout = function (d) { return d; };
      P._travelDir = function (out) { return out.copy(this.v.forward); };
      const origSafe = P.safeSpeed;
      P.safeSpeed = function (alpha, aimDist, aimX, aimZ) {
        this._clearTravel = 1e6;
        const r = origSafe.call(this, alpha, aimDist, aimX, aimZ);
        this._clearTravel = 1e6;
        return r;
      };
    }

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
    g.heat.value = 0; g.heat.bump(1, 'j'); g.heat.value = 4.2;
    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };

    const chase = new Set(['pursue', 'respond', 'intercept', 'pit', 'box', 'block']);
    const prevSpeed = new Map(), stalled = new Map();
    let t = 0, grass = 0, sceneryHits = 0, carHits = 0, stallEvents = 0;
    let runoutBinding = 0, runoutSamples = 0;
    const spd = [], runouts = [];

    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      g.stepHeadless(0.1);
      for (const u of g.dispatcher.units) {
        if (!chase.has(u.role)) continue;
        t++;
        const v = u.vehicle;

        // Impacts are detected as a step change in speed, not as damage.
        // Units more than 30 m from the player are damage-shielded, so a
        // damage-based count silently ignores most of the map. Braking at
        // 1.2g sheds about 1.2 m/s in a 0.1 s window; 4 is a collision.
        const wasV = prevSpeed.has(u) ? prevSpeed.get(u) : v.speed;
        prevSpeed.set(u, v.speed);
        if (wasV - v.speed > 4) {
          let near = false;
          for (const o of g.vehicles) {
            if (o === v) continue;
            const dd = Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z);
            if (dd < 6.5) { near = true; break; }
          }
          if (near) carHits++; else sceneryHits++;
        }

        if (g.sim.surfaceAt(v.position.x, v.position.z) === 0) grass++;

        const s = (stalled.get(u) || 0);
        if (v.speed < 1.5) {
          stalled.set(u, s + 0.1);
          if (s < 3 && s + 0.1 >= 3) stallEvents++;
        } else stalled.set(u, 0);

        if (u.driver._runout !== undefined) {
          runoutSamples++;
          if (u.driver._runout < 110) { runoutBinding++; runouts.push(u.driver._runout); }
        }
        spd.push(v.speed * 3.6);
      }
      if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const med = (a) => {
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return +s[Math.floor(s.length / 2)].toFixed(1);
    };
    const pct = (a, q) => {
      const s = a.slice().sort((x, y) => x - y);
      return s.length ? +s[Math.floor(s.length * q)].toFixed(1) : null;
    };
    const perMin = (n) => +(n / (t / 600)).toFixed(2);
    window.__res = JSON.stringify({
      mode, map: sessionStorage.getItem('pc.map'), chaseTicks: t,
      sceneryHitsPerCarMin: perMin(sceneryHits),
      carToCarHitsPerCarMin: perMin(carHits),
      onGrassPct: +(100 * grass / Math.max(1, t)).toFixed(1),
      stallsPerCarMin: perMin(stallEvents),
      policeKphMedian: med(spd), policeKph90th: pct(spd, 0.9),
      runoutBindingPct: +(100 * runoutBinding / Math.max(1, runoutSamples)).toFixed(1),
      runoutWhenBindingMedian_m: med(runouts),
    }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
