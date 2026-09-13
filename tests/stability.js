// Does it stay pointing where it is going?
//
// tests/handling.js reads cornering balance from yaw rate times speed, which
// is right while the car is on its line and badly wrong the moment the tail
// starts to come round -- it reports the rotation as grip. This asks the plainer
// question a driver would: hold a speed, hold a steering input, and see how far
// the body ends up from the direction of travel, and whether it spins.
//
// Run out past the edge of the map on forced tarmac, like tests/supercar.js.
window.__runStability = async function (kinds = ['runner', 'supercar']) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 1;
    g.sim.heightAt = () => 0;

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const out = {};
    for (const kind of kinds) {
      const rows = out[kind] = [];
      for (const lock of [0.5, 1.0]) {
        for (const kph of [50, 90, 130]) {
          const v = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -900 }, 0, {});
          v.assist.boost = 1; v.assist.grip = 1;
          subject = v;
          controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
          g.stepHeadless(0.8);
          v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });

          let pvx = v.linvel.x, pvz = v.linvel.z;
          let slipMax = 0, slipSum = 0, latSum = 0, n = 0, spun = false;
          for (let i = 0; i < 240; i++) {
            const err = kph / 3.6 - Math.abs(v.forwardSpeed);
            controls = { throttle: Math.max(0, Math.min(1, err * 0.5)), brake: 0,
              steer: Math.min(lock, (i / 45) * lock), handbrake: 0 };
            g.stepHeadless(1 / 60);
            const ax = (v.linvel.x - pvx) * 60, az = (v.linvel.z - pvz) * 60;
            pvx = v.linvel.x; pvz = v.linvel.z;
            const sp = Math.hypot(v.linvel.x, v.linvel.z) || 1;
            const lat = Math.abs(ax * (-v.linvel.z / sp) + az * (v.linvel.x / sp));
            const beta = Math.abs(v.slipAngleBody) * 57.3;
            if (beta > 25) spun = true;
            if (i >= 120) { slipSum += beta; latSum += lat; n++; slipMax = Math.max(slipMax, beta); }
          }
          rows.push(`lock ${lock} @${kph}: body slip ${(slipSum / n).toFixed(1)} deg`
            + ` (max ${slipMax.toFixed(1)}), ${(latSum / n / 9.81).toFixed(2)} g, `
            + `${spun ? 'SPUN' : 'held'}, ${(Math.abs(v.forwardSpeed) * 3.6).toFixed(0)} km/h`);
          subject = null;
          g.removeVehicle(v);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight; g._update = origU;
    window.__res = Object.entries(out).map(([k, r]) => `${k}\n  ${r.join('\n  ')}`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
