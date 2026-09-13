// Steady-state cornering balance.
//
// Holds a fixed steering angle at a fixed speed on open tarmac and reports the
// understeer gradient: how much more slip the front axle is carrying than the
// rear. Positive means the car pushes wide; near zero is neutral.
window.__runHandling = async function (kind = 'runner') {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    if (!g.player) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;

    let best = null;
    for (const e of gr.edges) {
      if (e.width < 20 || e.length < 120) continue;
      if (!best || e.length > best.length) best = e;
    }
    if (!best) { window.__res = 'no pad'; return; }
    const start = gr.pointAt(best, 10);

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const rows = [];
    for (const kph of [50, 80, 110]) {
      const v = g.createVehicle(kind, kind, { x: start.x, y: 0.95, z: start.z },
        Math.atan2(start.tx, start.tz), { police: kind !== 'runner' && kind !== 'supercar' });
      subject = v;
      v.assist.boost = 1; v.assist.grip = 1;

      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.6);
      // Get to speed in a straight line.
      controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      let t = 0;
      while (Math.abs(v.forwardSpeed) * 3.6 < kph && t < 20) { g.stepHeadless(1 / 60); t += 1 / 60; }

      // Steady half-lock turn, holding speed.
      let fSlip = 0, rSlip = 0, n = 0, yaw = 0, latA = 0, steerUsed = 0;
      for (let i = 0; i < 150; i++) {
        const err = kph / 3.6 - Math.abs(v.forwardSpeed);
        controls = { throttle: clamp01(err * 0.3), brake: 0, steer: 0.5, handbrake: 0 };
        g.stepHeadless(1 / 60);
        if (i > 60) {
          fSlip += Math.abs(v.wheels[0].slipAngle) + Math.abs(v.wheels[1].slipAngle);
          rSlip += Math.abs(v.wheels[2].slipAngle) + Math.abs(v.wheels[3].slipAngle);
          yaw += Math.abs(v.yawRate);
          latA += Math.abs(v.yawRate * v.speed);
          steerUsed += Math.abs(v.steerAngle);
          n++;
        }
      }
      const toDeg = 180 / Math.PI;
      rows.push({
        kph,
        frontSlipDeg: +((fSlip / (2 * n)) * toDeg).toFixed(2),
        rearSlipDeg: +((rSlip / (2 * n)) * toDeg).toFixed(2),
        understeerDeg: +(((fSlip - rSlip) / (2 * n)) * toDeg).toFixed(2),
        yawRate: +(yaw / n).toFixed(3),
        lateralG: +((latA / n) / 9.81).toFixed(2),
        steerAngleDeg: +((steerUsed / n) * toDeg).toFixed(1),
      });
      subject = null;
      g.removeVehicle(v);
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = JSON.stringify({ car: kind, rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 250);
  }
};
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
