// Straight-line acceleration, player against the fleet.
//
// Driven through the game's own update path. Reports 0-100 km/h, 0-160, and
// the speed reached after ten seconds, which is what "they lag behind when I
// floor it" actually refers to.
window.__runAccel = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    if (!g.player) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    let best = null;
    for (const e of gr.edges) {
      if (e.width < 14 || e.length < 140) continue;
      if (!best || e.length > best.length) best = e;
    }
    if (!best) { window.__res = 'no straight'; return; }

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const rows = [];
    for (const kind of ['runner', 'patrol', 'interceptor', 'unmarked']) {
      const start = gr.pointAt(best, 8);
      const heading = Math.atan2(start.tx, start.tz);
      const v = g.createVehicle(kind, kind, { x: start.x, y: 0.95, z: start.z }, heading,
        { police: kind !== 'runner' });
      subject = v;
      // Assist off: this is the car, not the rubber band.
      v.assist.boost = 1; v.assist.grip = 1;

      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.8);
      controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };

      let t = 0, t100 = null, t160 = null, at10 = null;
      const step = 1 / 60;
      while (t < 22) {
        g.stepHeadless(step);
        t += step;
        const kph = Math.abs(v.forwardSpeed) * 3.6;
        if (t100 === null && kph >= 100) t100 = t;
        if (t160 === null && kph >= 160) t160 = t;
        if (at10 === null && t >= 10) at10 = kph;
      }
      rows.push({
        car: kind,
        mass: v.spec.mass,
        peakTorque: Math.max(...v.spec.engine.torqueCurve.map((p) => p[1])),
        to100_s: t100 === null ? null : +t100.toFixed(2),
        to160_s: t160 === null ? null : +t160.toFixed(2),
        kphAt10s: at10 === null ? null : Math.round(at10),
        kphAt22s: Math.round(Math.abs(v.forwardSpeed) * 3.6),
      });
      subject = null;
      g.removeVehicle(v);
      await new Promise((r) => setTimeout(r, 0));
    }
    const run = rows.find((r) => r.car === 'runner');
    for (const r of rows) {
      r.vsPlayer_kphAt10s = r.kphAt10s - run.kphAt10s;
      r.vsPlayer_to100_s = r.to100_s === null || run.to100_s === null
        ? null : +(r.to100_s - run.to100_s).toFixed(2);
    }
    window.__res = JSON.stringify({ rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
