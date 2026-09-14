// Stiletto against Runner, on the things the Stiletto is supposed to be for.
//
// Faster, quicker, grippier, more fragile: four claims, four measurements.
// Everything runs out beyond the edge of the map, on the flat plate with the
// surface forced to tarmac, so neither car is measured against a road that
// bends, a tree, or a verge -- only against the other car.
window.__runSupercar = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    // Out past the map edge (the ground plate runs to 1200, the world to
    // 1000), with nothing to hit and the grid's idea of grass switched off.
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 1;
    g.sim.heightAt = () => 0;
    const LANE_X = 1100, Z0 = -1150, Z1 = 1150;

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const spawn = (kind, x, z, heading) => {
      const v = g.createVehicle(kind, kind, { x, y: 0.9, z }, heading, {});
      v.assist.boost = 1; v.assist.grip = 1;
      subject = v;
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      g.stepHeadless(0.8);
      return v;
    };

    // Put a car back at the start of the lane with everything it was doing
    // intact -- speed, gear, revs, wheel speeds -- so a top-speed run can go on
    // for longer than 2.3 km without the teleport costing it anything.
    const treadmill = (v) => {
      if (v.position.z < Z1) return;
      const vel = { x: v.linvel.x, y: v.linvel.y, z: v.linvel.z };
      const gear = v.gear, rpm = v.rpm, omegas = v.wheels.map((w) => w.omega);
      v.teleport({ x: LANE_X, y: v.position.y, z: Z0 }, 0);
      v.setVelocity(vel);
      v.gear = gear; v.rpm = rpm;
      v.wheels.forEach((w, i) => { w.omega = omegas[i]; });
    };

    const rows = {};
    for (const kind of ['runner', 'supercar']) {
      const r = rows[kind] = {};

      // ------------------------------------------------------ straight line
      const v = spawn(kind, LANE_X, Z0, 0);
      controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      const marks = { 100: null, 160: null, 200: null, 250: null };
      let t = 0, top = 0, flatFor = 0, last = 0;
      const step = 1 / 60;
      while (t < 90) {
        g.stepHeadless(step);
        t += step;
        treadmill(v);
        const kph = Math.abs(v.forwardSpeed) * 3.6;
        for (const m of Object.keys(marks)) if (marks[m] === null && kph >= +m) marks[m] = t;
        top = Math.max(top, kph);
        // Stop once it has gained less than half a km/h in two seconds.
        if (Math.floor(t * 60) % 120 === 0) {
          if (kph - last < 0.5) flatFor++; else flatFor = 0;
          last = kph;
          if (flatFor >= 2 && t > 10) break;
        }
      }
      for (const m of Object.keys(marks)) r[`0-${m}`] = marks[m] === null ? null : +marks[m].toFixed(2);
      r.topKph = Math.round(top);
      r.topReachedGear = v.gear;
      subject = null;
      g.removeVehicle(v);
      await new Promise((res) => setTimeout(res, 0));

      // ---------------------------------------------------------- cornering
      // Hold a speed and wind the lock on slowly; the peak steady lateral
      // acceleration before it lets go is the grip. Low speed is the tyres,
      // high speed is the tyres plus whatever the downforce adds.
      for (const kph of [60, 120, 170]) {
        const c = spawn(kind, 1015, -600, 0);
        c.setVelocity({ x: 0, y: 0, z: kph / 3.6 });
        let peak = 0;
        const avg = [];
        let pvx = c.linvel.x, pvz = c.linvel.z;
        for (let i = 0; i < 420; i++) {
          const err = kph / 3.6 - Math.abs(c.forwardSpeed);
          controls = { throttle: Math.max(0, Math.min(1, err * 0.5)), brake: 0,
            steer: Math.min(1, i / 360), handbrake: 0 };
          g.stepHeadless(1 / 60);
          // The true sideways acceleration of the car, from its velocity.
          // yawRate x speed is only that while the car is on its line: the
          // moment the tail starts to come round, the yaw rate runs ahead of
          // the path and the product reports grip the tyres never produced.
          const ax = (c.linvel.x - pvx) * 60, az = (c.linvel.z - pvz) * 60;
          pvx = c.linvel.x; pvz = c.linvel.z;
          const sp = Math.hypot(c.linvel.x, c.linvel.z) || 1;
          const lat = Math.abs(ax * (-c.linvel.z / sp) + az * (c.linvel.x / sp));
          avg.push(lat);
          if (avg.length > 30) avg.shift();
          // Only while it is genuinely cornering: speed held within 5% and the
          // body pointing within six degrees of where it is going.
          const held = Math.abs(err) < kph / 3.6 * 0.05;
          if (held && Math.abs(c.slipAngleBody) < 0.10 && avg.length === 30) {
            peak = Math.max(peak, avg.reduce((a, b) => a + b, 0) / 30);
          }
        }
        r[`grip@${kph}_g`] = +(peak / 9.81).toFixed(2);
        subject = null;
        g.removeVehicle(c);
        await new Promise((res) => setTimeout(res, 0));
      }

      // -------------------------------------------------------------- damage
      // The same shunt for both: into the back of a parked patrol car at
      // 50 km/h. How much one costs, and so how many it takes.
      const wall = g.createVehicle('patrol', 'patrol', { x: LANE_X, y: 0.9, z: -900 }, 0,
        { police: true });
      // Ten metres short of it, not sixty: coasting sixty metres let engine
      // braking decide the impact speed, so a change of gearing moved the
      // "toughness" figure without the car being any tougher.
      const d = spawn(kind, LANE_X, -915, 0);
      d.repair();
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      d.setVelocity({ x: 0, y: 0, z: 50 / 3.6 });
      controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
      let hitDv = 0;
      for (let i = 0; i < 240; i++) {
        g.stepHeadless(1 / 60);
        if (d.lastImpact && d.lastImpact > hitDv) hitDv = d.lastImpact;
      }
      r.impactDv = +hitDv.toFixed(1);
      r.damagePer50kphShunt = +d.damage.toFixed(3);
      r.shuntsToLosePower = d.damage > 0 ? Math.ceil(0.28 / d.damage) : null;
      r.shuntsToWreck = d.damage > 0 ? Math.ceil(0.92 / d.damage) : null;
      subject = null;
      g.removeVehicle(d);
      g.removeVehicle(wall);
      await new Promise((res) => setTimeout(res, 0));
    }

    g.sim.surfaceAt = realSurface;
    g.sim.heightAt = realHeight;
    g._update = origU;
    window.__res = JSON.stringify(rows, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
