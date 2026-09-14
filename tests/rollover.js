// Does it fall over?
//
// Three ways a player rolls a car, each at a range of speeds, for each car:
//
//   turn    full lock from a straight line, held for three seconds, throttle
//           held to keep the speed up -- a keyboard's idea of a corner
//   slalom  full lock one way then the other every 0.6 s -- a keyboard's idea
//           of dodging something
//   kerb    sliding sideways into a 14 cm kerb at the given sideways speed,
//           while doing 90 km/h forwards
//
// On forced flat tarmac past the edge of the map, like tests/highspeed.js, with
// a kerb laid by the height function for the last case. Reports the worst roll
// angle, how long any wheel was off the ground, and whether the car went past
// the point of no return (up vector under 0.25, the game's own "flipped").
window.__runRollover = async function (kinds = ['runner', 'supercar']) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 1;
    let kerbX = Infinity;
    g.sim.heightAt = (x) => (x > kerbX ? 0.14 : 0);

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const X0 = 1015, Z0 = -1000;
    const run = (kind, kph, script, seconds, opts = {}) => {
      kerbX = Infinity;
      const v = g.createVehicle(kind, kind, { x: X0, y: 0.9, z: Z0 }, 0, {});
      v.assist.boost = 1; v.assist.grip = 1;
      subject = v;
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.8);
      v.setVelocity({ x: opts.side || 0, y: 0, z: kph / 3.6 });
      if (opts.kerb) kerbX = v.position.x + opts.kerb;
      let worstRoll = 0, liftT = 0, flipped = false, t = 0;
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        const err = kph / 3.6 - Math.abs(v.forwardSpeed);
        controls = Object.assign({ throttle: Math.max(0, Math.min(1, err * 0.6)), brake: 0, steer: 0, handbrake: 0 }, script(t));
        g.stepHeadless(1 / 60);
        t += 1 / 60;
        // Roll: how far the car's own left axis has tipped out of level.
        const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, v.left.y)))) * 57.3;
        worstRoll = Math.max(worstRoll, roll);
        if (v.wheels.some((w) => !w.grounded)) liftT += 1 / 60;
        if (v.up.y < 0.25) flipped = true;
      }
      subject = null;
      g.removeVehicle(v);
      return { roll: +worstRoll.toFixed(1), lift: +liftT.toFixed(2), flipped };
    };

    const rows = [];
    for (const kind of kinds) {
      for (const kph of [60, 100, 140, 180, 220]) {
        const r = run(kind, kph, (t) => (t > 0.8 ? { steer: 1 } : {}), 4);
        rows.push({ kind, test: 'turn', kph, ...r });
        await new Promise((res) => setTimeout(res, 0));
      }
      for (const kph of [80, 120, 160, 200]) {
        const r = run(kind, kph, (t) => (t > 0.8 ? { steer: Math.floor((t - 0.8) / 0.6) % 2 ? -1 : 1 } : {}), 4.4);
        rows.push({ kind, test: 'slalom', kph, ...r });
        await new Promise((res) => setTimeout(res, 0));
      }
      for (const side of [3, 6, 10]) {
        const r = run(kind, 90, () => ({}), 2.5, { side, kerb: 2.5 });
        rows.push({ kind, test: `kerb ${side} m/s sideways`, kph: 90, ...r });
        await new Promise((res) => setTimeout(res, 0));
      }
    }

    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight; g._update = origU;
    window.__res = rows.map((r) => `${r.kind.padEnd(9)} ${r.test.padEnd(22)} ${String(r.kph).padStart(3)} km/h  roll ${String(r.roll).padStart(5)}°  wheel off ${r.lift}s${r.flipped ? '  FLIPPED' : ''}`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
