// Straight-line braking test.
//
// Accelerates each car to a target speed on a long straight, then stands on
// the brake and measures the distance to a stop. Driven through the game's own
// update path -- replicating the substep loop by hand gets the ordering subtly
// wrong and the wheels never find the ground.
window.__runBraking = async function (fromKph = 100) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    if (!g.player) { window.__res = 'NO PLAYER'; return; }

    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    // The longest wide straight on the map.
    let best = null;
    for (const e of gr.edges) {
      if (e.width < 14 || e.length < 100) continue;
      if (!best || e.length > best.length) best = e;
    }
    if (!best) { window.__res = 'no straight found'; return; }

    // One control hook for the car under test, applied before the game's own
    // update so nothing downstream overwrites it.
    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const rows = [];
    for (const kind of ['runner', 'patrol', 'interceptor', 'unmarked']) {
      const start = gr.pointAt(best, 12);
      const heading = Math.atan2(start.tx, start.tz);
      const v = g.createVehicle(kind, kind, { x: start.x, y: 0.95, z: start.z }, heading,
        { police: kind !== 'runner' });
      subject = v;

      // Settle onto its suspension.
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.8);

      const target = fromKph / 3.6;
      controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      let t = 0;
      while (v.speed < target && t < 25) { g.stepHeadless(0.1); t += 0.1; }
      const entry = v.speed;

      const x0 = v.position.x, z0 = v.position.z;
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
      let stopT = 0, peakG = 0, prev = v.speed;
      const locked = [];
      while (v.speed > 0.5 && stopT < 12) {
        g.stepHeadless(1 / 60);
        const dec = (prev - v.speed) * 60 / 9.81;
        if (dec > peakG && dec < 4) peakG = dec;
        prev = v.speed;
        stopT += 1 / 60;
        // A wheel at zero speed while the car is still moving is locked.
        locked.push(v.wheels.filter((w) => w.grounded && Math.abs(w.omega) < 0.5).length);
      }
      const dist = Math.hypot(v.position.x - x0, v.position.z - z0);
      rows.push({
        car: kind,
        abs: !!v.spec.brakes.abs,
        brakeTorque: v.spec.brakes.maxTorque,
        entryKph: +(entry * 3.6).toFixed(1),
        stopDistance_m: +dist.toFixed(1),
        stopTime_s: +stopT.toFixed(2),
        meanG: +((entry * entry) / (2 * Math.max(dist, 0.1)) / 9.81).toFixed(2),
        peakG: +peakG.toFixed(2),
        lockedWheelTicksPct: locked.length
          ? +(100 * locked.filter((n) => n > 0).length / locked.length).toFixed(0) : 0,
      });
      subject = null;
      g.removeVehicle(v);
      await new Promise((r) => setTimeout(r, 0));
    }

    const runner = rows.find((r) => r.car === 'runner');
    for (const r of rows) {
      r.vsPlayer_m = +(r.stopDistance_m - runner.stopDistance_m).toFixed(1);
      r.shorterThanPlayerPct = +(100 * (1 - r.stopDistance_m / runner.stopDistance_m)).toFixed(1);
    }
    window.__res = JSON.stringify({ fromKph, straight_m: Math.round(best.length), rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
