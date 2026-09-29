// Does it go up on two wheels when you climb a kerb and turn?
//
// "If you go on a kerb and turn really hard, it starts to tip over."
//
// tests/rollover.js asks the question on a flat plate with a kerb laid by the
// height function, and there nothing tips: the worst any of these cars managed
// was eight degrees of roll. The case the player is describing is the real
// one -- a car on a real street, climbing the real pavement with the wheels on
// one side while it is turning -- so this does that, on whatever map is
// loaded:
//
//   roll     the worst roll angle reached, degrees
//   air      how long any wheel spent off the ground
//   flipped  the game's own test, up vector under 0.25
//
// Each car gets a straight length of street, is put on it at the given speed,
// and is steered into the kerb at full lock while the throttle is held.
window.__runTipping = async function (kinds = ['runner', 'patrol', 'interceptor'], speeds = [55, 75, 95]) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    g.paused = true;

    // A long straight edge with a pavement beside it.
    let site = null;
    for (const e of g.graph.edges) {
      if (e.kind !== 'street' && e.kind !== 'avenue') continue;
      if (e.length < 120 || e.points.length > 2) continue;
      const a = e.points[0], b = e.points[e.points.length - 1];
      site = {
        x: a.x + (b.x - a.x) * 0.25, z: a.z + (b.z - a.z) * 0.25,
        heading: Math.atan2(b.x - a.x, b.z - a.z),
      };
      break;
    }
    if (!site) { window.__res = 'no straight street'; return; }

    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };

    const rows = [];
    for (const kind of kinds) {
      for (const kph of speeds) {
        const v = g.createVehicle(kind, kind, { x: site.x, y: 0.95, z: site.z }, site.heading,
          { police: kind !== 'runner' && kind !== 'supercar' && kind !== 'offroad' });
        v.assist.boost = 1; v.assist.grip = 1;
        subject = v;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.6);
        v._readState();
        v.setVelocity({
          x: Math.sin(site.heading) * (kph / 3.6), y: 0,
          z: Math.cos(site.heading) * (kph / 3.6),
        });

        // Straight for a moment, then full lock toward the kerb, held.
        let roll = 0, air = 0, flipped = false;
        for (let i = 0; i < 300; i++) {
          controls = {
            throttle: 0.55, brake: 0,
            steer: i < 20 ? 0 : 1,          // left, into the near-side kerb
            handbrake: 0,
          };
          g.stepHeadless(1 / 60);
          const tilt = Math.acos(Math.max(-1, Math.min(1, v.up.y))) * 57.2958;
          roll = Math.max(roll, tilt);
          if (v.grounded < 4) air += 1 / 60;
          if (v.up.y < 0.25) flipped = true;
        }
        rows.push({
          kind, kph, roll: +roll.toFixed(1), air: +air.toFixed(2), flipped,
        });
        subject = null;
        g.removeVehicle(v);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    g._update = origU;
    g.paused = false;
    window.__res = rows.map((r) => `${r.kind.padEnd(12)}${String(r.kph).padStart(4)} km/h  `
      + `roll ${String(r.roll).padStart(5)}°  air ${String(r.air).padStart(5)}s`
      + `${r.flipped ? '  FLIPPED' : ''}`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
