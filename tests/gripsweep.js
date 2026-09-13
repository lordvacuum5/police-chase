// Peak steady cornering grip, for comparing tyre settings.
//
// Same measurement as the grip rows of tests/supercar.js: hold a speed, wind
// the lock on slowly, and take the highest half-second average of true lateral
// acceleration while the speed is held within 5% and the body is within six
// degrees of its direction of travel. Out past the map edge on forced tarmac.
window.__runGripSweep = async function (kinds = ['runner', 'supercar'], speeds = [60, 120, 170], tolerance = 0.05) {
  try {
    const g = window.__game;
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
      const row = { kind };
      for (const kph of speeds) {
        const c = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -600 }, 0, {});
        c.assist.boost = 1; c.assist.grip = 1;
        subject = c;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.8);
        c.setVelocity({ x: 0, y: 0, z: kph / 3.6 });
        let peak = 0;
        const avg = [];
        let pvx = c.linvel.x, pvz = c.linvel.z;
        for (let i = 0; i < 420; i++) {
          const err = kph / 3.6 - Math.abs(c.forwardSpeed);
          controls = { throttle: Math.max(0, Math.min(1, err * 0.5)), brake: 0,
            steer: Math.min(1, i / 360), handbrake: 0 };
          g.stepHeadless(1 / 60);
          const ax = (c.linvel.x - pvx) * 60, az = (c.linvel.z - pvz) * 60;
          pvx = c.linvel.x; pvz = c.linvel.z;
          const sp = Math.hypot(c.linvel.x, c.linvel.z) || 1;
          avg.push(Math.abs(ax * (-c.linvel.z / sp) + az * (c.linvel.x / sp)));
          if (avg.length > 30) avg.shift();
          const held = Math.abs(err) < kph / 3.6 * tolerance;
          if (held && Math.abs(c.slipAngleBody) < 0.10 && avg.length === 30) {
            peak = Math.max(peak, avg.reduce((a, b) => a + b, 0) / 30);
          }
        }
        row[kph] = +(peak / 9.81).toFixed(2);
        subject = null;
        g.removeVehicle(c);
        await new Promise((r) => setTimeout(r, 0));
      }
      out.push(row);
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight; g._update = origU;
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
