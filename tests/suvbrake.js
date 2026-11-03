// The police SUV's stopping distance: the player's (drivablePoliceSpec('suv'))
// against the AI's (SPECS.suv), from 100 and 60 km/h on the longest wide
// straight. "[The brakes are] slightly bit too good when the player is playing
// the police SUV. Keep the brakes the same when the computer is driving."
//
// Same method as tests/braking.js. Run from the console: __runSuvBrake().
import { SPECS, drivablePoliceSpec } from '../src/game/vehicles.js';

window.__runSuvBrake = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    let best = null;
    for (const e of gr.edges) {
      if (e.width < 10 || e.length < 100 || e.quarry || e.kind === 'track') continue;
      if (!best || e.length > best.length) best = e;
    }
    let subject = null, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      if (subject) subject.setControls(controls);
      origU(dt);
      if (subject) subject.setControls(controls);
    };
    const rows = [];
    for (const fromKph of [100, 60]) {
      for (const [name, spec] of [['ai', SPECS.suv], ['player', drivablePoliceSpec('suv')]]) {
        const start = gr.pointAt(best, 12);
        const heading = Math.atan2(start.tx, start.tz);
        const v = g.createVehicle('suv', 'suv', { x: start.x, y: 0.95, z: start.z }, heading,
          { police: true, spec });
        subject = v;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.8);
        controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
        let t = 0;
        while (v.speed < fromKph / 3.6 && t < 25) { g.stepHeadless(0.1); t += 0.1; }
        const entry = v.speed;
        const x0 = v.position.x, z0 = v.position.z;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
        let stopT = 0;
        while (v.speed > 0.5 && stopT < 12) { g.stepHeadless(1 / 60); stopT += 1 / 60; }
        const dist = Math.hypot(v.position.x - x0, v.position.z - z0);
        rows.push(`${name} ${Math.round(entry * 3.6)} km/h: ${dist.toFixed(1)} m, ${stopT.toFixed(2)} s, ${((entry * entry) / (2 * dist) / 9.81).toFixed(2)} g (gripBonus ${spec.brakes.gripBonus})`);
        subject = null;
        g.removeVehicle(v);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    window.__res = rows;
  } catch (e) {
    window.__res = 'EX: ' + e.message;
  }
};
