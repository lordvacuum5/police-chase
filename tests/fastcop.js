// The interceptor you drive, against the Stiletto, in a straight line and into a parked car.
//
// "Make the new interceptor as fast as the criminal [Stiletto], the one that's really weak. But give it ...
// quite a lot more health." On the flat plate past the map edge, as tests/supercar.js does:
//
//   await import('/tests/fastcop.js');  __runFastCop();  // then window.__fastDone, window.__res
//
//   sixty, to100, to200   seconds from rest; topKph the most it reaches
//   hits                  50 km/h shunts into a parked patrol car to wreck it
window.__runFastCop = async function () {
  window.__fastDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game;
    const V = await import('/src/game/vehicles.js');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    const rs = g.sim.surfaceAt, rh = g.sim.heightAt;
    g.sim.surfaceAt = () => 1; g.sim.heightAt = () => 0;
    const LANE_X = 1100, Z0 = -1150, Z1 = 1150;
    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => { if (subject) subject.setControls(controls); origU(dt); if (subject) subject.setControls(controls); };
    const make = (kind, spec, x, z) => {
      const v = g.createVehicle(kind, kind, { x, y: 0.9, z }, 0, spec ? { spec, police: true } : {});
      v.assist.boost = 1; v.assist.grip = 1;
      subject = v;
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.8);
      return v;
    };
    const run = async (kind, spec) => {
      const v = make(kind, spec, LANE_X, Z0);
      controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      let t = 0, top = 0, sixty = null, h100 = null, h200 = null, last = 0, flat = 0;
      while (t < 90) {
        g.stepHeadless(1 / 60); t += 1 / 60;
        if (v.position.z >= Z1) {
          const vel = { x: v.linvel.x, y: v.linvel.y, z: v.linvel.z }, gear = v.gear, rpm = v.rpm, om = v.wheels.map((w) => w.omega);
          v.teleport({ x: LANE_X, y: v.position.y, z: Z0 }, 0); v.setVelocity(vel); v.gear = gear; v.rpm = rpm;
          v.wheels.forEach((w, i) => { w.omega = om[i]; });
        }
        const k = Math.abs(v.forwardSpeed) * 3.6;
        if (sixty === null && k >= 96.561) sixty = t;
        if (h100 === null && k >= 100) h100 = t;
        if (h200 === null && k >= 200) h200 = t;
        top = Math.max(top, k);
        if (Math.floor(t * 60) % 120 === 0) { if (k - last < 0.5) flat++; else flat = 0; last = k; if (flat >= 2 && t > 10) break; }
        if (Math.floor(t * 60) % 300 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      subject = null; g.removeVehicle(v);
      // Toughness, as tests/supercar.js: into the back of a parked patrol car at 50 km/h, how much one costs.
      const wall = g.createVehicle('patrol', 'patrol', { x: LANE_X, y: 0.9, z: -900 }, 0, { police: true });
      const d = make(kind, spec, LANE_X, -915);
      d.repair();
      d.setVelocity({ x: 0, y: 0, z: 50 / 3.6 });
      controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
      for (let i = 0; i < 120; i++) g.stepHeadless(1 / 60);
      const per = d.damage;
      subject = null; g.removeVehicle(d); g.removeVehicle(wall);
      return { sixty: sixty && +sixty.toFixed(2), to100: h100 && +h100.toFixed(2), to200: h200 && +h200.toFixed(2),
        topKph: Math.round(top), topMph: Math.round(top / 1.609344), perHit: +per.toFixed(3), hits: per > 0 ? Math.ceil(1 / per) : null };
    };
    const res = {};
    res.stiletto = await run('supercar', null);
    res.interceptor = await run('interceptor', V.drivablePoliceSpec('interceptor'));
    g._update = origU; g.sim.surfaceAt = rs; g.sim.heightAt = rh;
    window.__res = res;
  } catch (e) {
    window.__res = 'ERR ' + (e.stack || e);
  }
  window.__fastDone = true;
  return window.__res;
};
