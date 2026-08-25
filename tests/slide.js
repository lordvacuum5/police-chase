// One arm of the A/B for the slide-awareness change.
//
// Call with mode 'after' (shipping code) or 'before' (the previous behaviour:
// corner speeds planned against a hard-coded dry-road figure regardless of
// what is under the car and regardless of whether the car is currently
// sliding, and no recovery lift). Run each arm from a fresh page load so both
// start from identical world state.
window.__runSlide = async function (mode, seconds = 90) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    const P = M.Driver.prototype;

    if (mode === 'before') {
      P._mu = function () {
        const a = this.v.assist || { grip: 1 };
        return 1.42 * this.skill.grip * 0.87 * a.grip;
      };
      P._updateGrip = function () { this.gripEstimate = 1; };
      P.slideLift = function () { return Infinity; };
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
    g.heat.value = 0; g.heat.bump(1, 'ab'); g.heat.value = 4.2;

    const k = g.dispatcher.knowledge;
    const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    g.dispatcher._updateKnowledge = (dt, tg) => {
      oK(dt, tg);
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(tg.position); k.velocity.copy(tg.linvel);
    };

    const chase = new Set(['pursue', 'respond', 'intercept', 'pit', 'box', 'block']);
    let t = 0, grass = 0, sliding = 0, hardSlide = 0, wrecked = 0, farOff = 0, damage = 0;
    const spd = [];
    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      g.stepHeadless(0.1);
      for (const u of g.dispatcher.units) {
        if (!chase.has(u.role)) continue;
        t++;
        const v = u.vehicle;
        if (v.disabled) wrecked++;
        damage += v.damage;
        if (g.sim.surfaceAt(v.position.x, v.position.z) === 0) grass++;
        const slip = Math.abs(v.slipAngleBody);
        if (slip > 0.20 && v.speed > 7) sliding++;
        if (slip > 0.45 && v.speed > 7) hardSlide++;
        const snap = gr.nearestEdge(v.position.x, v.position.z);
        if (snap) {
          const d = Math.hypot(v.position.x - snap.x, v.position.z - snap.z);
          if (d - snap.edge.width * 0.5 > 6) farOff++;
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
    window.__res = JSON.stringify({
      mode, map: sessionStorage.getItem('pc.map'), ticks: t,
      onGrassPct: +(100 * grass / Math.max(1, t)).toFixed(1),
      slidingPct: +(100 * sliding / Math.max(1, t)).toFixed(1),
      hardSlidePct: +(100 * hardSlide / Math.max(1, t)).toFixed(1),
      wellOffRoadPct: +(100 * farOff / Math.max(1, t)).toFixed(1),
      wreckedPct: +(100 * wrecked / Math.max(1, t)).toFixed(1),
      meanDamage: +(damage / Math.max(1, t)).toFixed(3),
      policeKphMedian: med(spd),
    }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
