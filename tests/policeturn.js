// How tightly does the police car a person drives go round at chase speeds?
//
// "The police car that the player will be driving needs to be slightly better
// at turning at higher speeds -- like fifty to a hundred." Turning is not the
// same question as grip: tests/policecars.js asks how much lateral
// acceleration the car can hold at all, and the answer was already high. What
// a driver feels as "it will not turn" is the front tyres giving up before the
// rears, so the nose runs wide of the lock they asked for.
//
// So this measures the line the car actually takes, at a fixed steering input,
// on the flat plate past the map edge:
//
//   yaw      steady yaw rate, degrees per second -- how fast it is coming round
//   radius   the circle it settles into, metres: smaller is a tighter turn
//   lat      lateral acceleration, g
//   slip     body slip angle, degrees. Under about 4 is tidy; past 10 the back
//            is coming round and the driver has a different problem
//   kphEnd   what it is doing at the end: a car that scrubs off half its speed
//            has not turned better, it has just slowed down
//
// `variants` are named changes to the spec, so a proposed setting can be
// measured against the one in the game in a single run.
// `set` picks what is being tried: 'tyre' for the grip balance that fixed the
// interceptor's understeer at 50-100 km/h, 'lock' for how tightly a car will
// come round at crawling speed, where the steering lock and not the tyres is
// what runs out first.
window.__runPoliceTurn = async function (kind = 'interceptor', speeds = [50, 70, 90, 100], steer = 1, set = 'tyre') {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const { drivablePoliceSpec } = await import('../src/game/vehicles.js');
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
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

    // The setting in the game, and the ones being considered against it. Each
    // is a whole spec, built from the drivable one.
    const base = drivablePoliceSpec(kind);
    const tyre = (front, rear, fg, rg) => Object.assign({}, base, {
      highSpeedTyre: {
        from: 8, to: 30,
        stiffness: { front, rear },
        grip: { front: fg, rear: rg },
      },
    });
    //
    // Measured, 2026-09: stiffening the front made it turn *worse* (radius at
    // 90 km/h 36.6 m -> 37.9), and raising the steering limiter did nothing a
    // tyre change had not already done. Front grip is the setting that moves
    // it, so these are four helpings of it.
    const lock = (angle, front) => Object.assign({}, base, {
      steering: Object.assign({}, base.steering, { maxAngle: angle }),
      gripBias: { front: front || base.gripBias.front, rear: base.gripBias.rear },
    });
    const variants = set === 'lock' ? [
      ['now', base],
      ['0.62+0.06', lock(0.62, base.gripBias.front + 0.06)],
      ['0.62+0.10', lock(0.62, base.gripBias.front + 0.10)],
      ['0.66+0.10', lock(0.66, base.gripBias.front + 0.10)],
    ] : [
      ['now', base],
      ['fg-1.24', tyre(2.2, 2.8, 1.24, 1.25)],
      ['fg-1.30', tyre(2.2, 2.8, 1.30, 1.25)],
      ['fg-1.36', tyre(2.2, 2.8, 1.36, 1.25)],
    ];

    const rows = [];
    for (const [name, spec] of variants) {
      for (const kph of speeds) {
        const v = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -600 }, 0,
          { police: true, spec });
        v.assist.boost = 1; v.assist.grip = 1;
        subject = v;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.6);
        v._readState();
        v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });

        // Wind the lock on over half a second rather than snapping it to full,
        // which is what a person does and what the steering rate allows
        // anyway, then hold it and let the car settle.
        const yaws = [], lats = [], slips = [];
        let pvx = v.linvel.x, pvz = v.linvel.z;
        for (let i = 0; i < 240; i++) {
          const err = kph / 3.6 - Math.abs(v.forwardSpeed);
          controls = {
            throttle: Math.max(0, Math.min(1, err * 0.5)), brake: 0,
            steer: Math.min(steer, (i / 30) * steer), handbrake: 0,
          };
          g.stepHeadless(1 / 60);
          const ax = (v.linvel.x - pvx) * 60, az = (v.linvel.z - pvz) * 60;
          pvx = v.linvel.x; pvz = v.linvel.z;
          const sp = Math.hypot(v.linvel.x, v.linvel.z) || 1;
          const lat = Math.abs(ax * (-v.linvel.z / sp) + az * (v.linvel.x / sp));
          // The last second and a half, by which time it is settled.
          if (i >= 150) {
            yaws.push(Math.abs(v.yawRate));
            lats.push(lat);
            slips.push(Math.abs(v.slipAngleBody));
          }
        }
        const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        const yaw = mean(yaws);
        const sp = Math.abs(v.forwardSpeed);
        rows.push({
          set: name,
          kph,
          yaw: +(yaw * 180 / Math.PI).toFixed(1),
          radius: yaw > 1e-3 ? +(sp / yaw).toFixed(1) : null,
          lat: +(mean(lats) / 9.81).toFixed(2),
          slip: +(mean(slips) * 180 / Math.PI).toFixed(1),
          kphEnd: Math.round(sp * 3.6),
        });
        subject = null;
        g.removeVehicle(v);
        await new Promise((res) => setTimeout(res, 0));
      }
    }

    g.sim.surfaceAt = realSurface;
    g.sim.heightAt = realHeight;
    g._update = origU;
    window.__res = rows.map((r) => `${r.set.padEnd(12)} ${String(r.kph).padStart(4)} `
      + `yaw ${String(r.yaw).padStart(5)}  r ${String(r.radius).padStart(6)}  `
      + `lat ${r.lat}  slip ${String(r.slip).padStart(5)}  end ${r.kphEnd}`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
