// "There is quite a bad judder on the player's car just driving along, even on
// single player, possibly when there are a lot of police cars."
//
// The player's car is handed to the getaway AI (ai/runner.js) so it drives
// itself along the roads, the wanted level is set, and then the real frame
// loop runs for `seconds` in the visible page. Per frame:
//
//   dt        the rAF interval, ms -- p50, p95, max
//   upd, rnd  time inside _update and _render, ms
//   subs      substeps taken that frame; `zero` frames drew the same physics
//             pose again, `capped` hit MAX_SUBSTEPS and threw time away
//   jerk      how far the car moves on screen frame to frame, against how far
//             it should: |drawn / (speed * dt) - 1| of the car's position
//             relative to the camera, p50 and p95, and how many frames were
//             off by more than 30%. This is the judder itself.
//   units     police on the board at the end
window.__runJudder = async function (seconds = 20, heat = 5, label = '') {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { Runner } = await import('/src/ai/runner.js');
    g.onBusted = () => { g.outcome = null; };
    const p = g.player;
    const ai = new Runner(g, p);
    if (heat > 0) g.heat.value = heat;

    const origU = g._update.bind(g), origR = g._render.bind(g);
    const origStep = g.world.step.bind(g.world);
    let subs = 0, tu = 0, tr = 0;
    g.world.step = (...a) => { subs++; return origStep(...a); };
    g._update = (dt) => {
      try { ai.update(dt); } catch (e) { /* keep timing */ }
      if (heat > 0) g.heat.value = Math.max(g.heat.value, heat - 0.01);
      const t0 = performance.now(); origU(dt); tu = performance.now() - t0;
    };
    g._render = (dt) => { const t0 = performance.now(); origR(dt); tr = performance.now() - t0; };

    const rows = [];
    const cam = g.camera;
    let last = null, lastT = performance.now();
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now();
        const dt = (now - lastT) / 1000; lastT = now;
        const rel = p.view.position.clone().sub(cam.position);
        if (last && dt > 0) {
          const moved = rel.distanceTo(last.rel);
          // What the car should have moved across the screen: its own motion
          // and the camera's both happen in the world, so the expected change
          // of the gap is the difference in their velocities -- which, behind
          // a chase camera, is small. Use the car's speed as the yardstick
          // instead and compare drawn travel in the world.
          const world = p.view.position.distanceTo(last.pos);
          const want = p.speed * dt;
          rows.push({ dt: dt * 1000, upd: tu, rnd: tr, subs,
            r: want > 0.05 ? world / want : null, moved });
        }
        last = { rel, pos: p.view.position.clone() };
        subs = 0;
        if (now - t0 < seconds * 1000) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    g._update = origU; g._render = origR; g.world.step = origStep;

    const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1) : null; };
    const dts = rows.map((r) => r.dt), us = rows.map((r) => r.upd), rs = rows.map((r) => r.rnd);
    const off = rows.filter((r) => r.r != null).map((r) => Math.abs(r.r - 1));
    window.__res = JSON.stringify({
      label, frames: rows.length,
      dt: [q(dts, 0.5), q(dts, 0.95), q(dts, 1)],
      upd: [q(us, 0.5), q(us, 0.95), q(us, 1)],
      rnd: [q(rs, 0.5), q(rs, 0.95), q(rs, 1)],
      zero: rows.filter((r) => r.subs === 0).length,
      capped: rows.filter((r) => r.subs >= 5).length,
      jerk: [q(off, 0.5), q(off, 0.95)], jerky: off.filter((x) => x > 0.3).length,
      units: g.vehicles.filter((v) => v.isPolice && !v.removed).length,
      kph: Math.round(p.speed * 3.6),
    });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
