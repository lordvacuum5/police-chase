// Pulling away up a hill.
//
// "Just going up hills, it's a little bit too bouncy sometimes. Not quite
// right." And, from the driving log of being stuck beside the quarry track:
// full throttle on a 12-degree grass bank, the Badger's engine sat at 850 rpm
// -- idle, locked to a car that was not moving -- making idle torque, and it
// crept. Only the Stiletto had a clutch that slipped to let the engine rev.
//
// Each car from a standstill, full throttle, straight up a slope of `grade`
// (rise over run) on grass, out past the edge of the map with the ground the
// wheels ride replaced by the slope. Per car and grade:
//
//   kph4    speed after 4 s
//   rpm1    engine speed after 1 s
//   to20    seconds to 20 km/h, or '-' if not in 8 s
window.__runHillStart = async function (kinds = ['runner', 'offroad', 'patrol', 'supercar'], grades = [0, 0.21, 0.36]) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    const rows = [];
    for (const kind of kinds) {
      for (const grade of grades) {
        const z0 = -1000;
        g.sim.surfaceAt = () => 0;
        g.sim.heightAt = (x, z) => Math.max(0, (z - z0)) * grade + 20;
        const v = g.createVehicle(kind, kind, { x: 1015, y: 21, z: z0 + 2 }, 0, {});
        v.assist.boost = 1; v.assist.grip = 1;
        let controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        const origU = g._update.bind(g);
        g._update = (dt) => { v.setControls(controls); origU(dt); v.setControls(controls); };
        g.stepHeadless(1);
        controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
        let to20 = null, rpm1 = null, kph4 = null;
        for (let i = 0; i < 480; i++) {
          g._update(1 / 60);
          const kph = v.forwardSpeed * 3.6;
          if (to20 === null && kph >= 20) to20 = +((i + 1) / 60).toFixed(1);
          if (i === 59) rpm1 = Math.round(v.rpm);
          if (i === 239) kph4 = Math.round(kph);
        }
        rows.push(`${kind} grade ${grade}: kph4 ${kph4}, rpm1 ${rpm1}, to20 ${to20 === null ? '-' : to20 + ' s'}`);
        g._update = origU;
        g.removeVehicle(v);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
