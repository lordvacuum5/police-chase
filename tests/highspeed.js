// High-speed sliding, driven the way a keyboard drives: full lock, held.
//
// A keyboard's steering is all or nothing, so at speed the player is asking
// for full lock whenever they steer at all. The question is how far each car
// ends up sideways when they do -- body slip angle, mean and worst -- with the
// throttle held to keep the speed up, and with it lifted. Out past the edge of
// the map on forced tarmac, like tests/supercar.js.
window.__runHighSpeed = async function (kinds = ['runner', 'supercar'], speeds = [100, 140, 180]) {
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

    const out = [];
    for (const kind of kinds) {
      for (const kph of speeds) {
        for (const mode of ['hold', 'lift']) {
          const v = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -1000 }, 0, {});
          v.assist.boost = 1; v.assist.grip = 1;
          subject = v;
          controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
          g.stepHeadless(0.8);
          v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });
          // A second of straight running at speed so the suspension and aero
          // have settled before the input.
          for (let i = 0; i < 60; i++) {
            const err = kph / 3.6 - v.forwardSpeed;
            controls = { throttle: Math.max(0, Math.min(1, err * 0.6)), brake: 0, steer: 0, handbrake: 0 };
            g.stepHeadless(1 / 60);
          }
          let slipSum = 0, slipMax = 0, n = 0, spun = false, latSum = 0;
          let pvx = v.linvel.x, pvz = v.linvel.z;
          for (let i = 0; i < 120; i++) {
            const err = kph / 3.6 - Math.abs(v.forwardSpeed);
            controls = {
              throttle: mode === 'hold' ? Math.max(0, Math.min(1, err * 0.6)) : 0,
              brake: 0, steer: 1, handbrake: 0,
            };
            g.stepHeadless(1 / 60);
            const beta = Math.abs(v.slipAngleBody) * 57.3;
            const ax = (v.linvel.x - pvx) * 60, az = (v.linvel.z - pvz) * 60;
            pvx = v.linvel.x; pvz = v.linvel.z;
            const sp = Math.hypot(v.linvel.x, v.linvel.z) || 1;
            latSum += Math.abs(ax * (-v.linvel.z / sp) + az * (v.linvel.x / sp));
            if (beta > 30) spun = true;
            slipSum += beta; slipMax = Math.max(slipMax, beta); n++;
          }
          out.push({ kind, kph, mode, meanSlip: +(slipSum / n).toFixed(1), maxSlip: +slipMax.toFixed(1),
            latG: +(latSum / n / 9.81).toFixed(2), spun, endKph: Math.round(Math.abs(v.forwardSpeed) * 3.6) });
          subject = null;
          g.removeVehicle(v);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight; g._update = origU;
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
