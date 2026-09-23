// How forgiving is a car to a person, rather than to the speed planner?
//
// tests/highspeed.js asks what a car does at full lock at 100-180 km/h, which
// is the motorway question. This is the city one: the speeds a chase actually
// happens at, and the three things that spin a rear-drive car for someone
// holding a keyboard, where steering is all or nothing:
//
//   turnIn    hold full lock at a steady speed, throttle keeping it there
//   powerOn   hold full lock and floor it -- the classic way to lose the back
//   liftOff   hold full lock and come off the throttle, so the weight goes
//             forward and the tail comes round
//
// and then whether the car comes back when the wheel is straightened, which is
// what separates "lively" from "over".
//
//   slip      body slip angle while it happens, mean and worst, in degrees
//   spun      it went past 30 degrees: gone
//   recovers  straightening the wheel brought it back under 3 degrees
//   kph       what it was doing at the end -- a car that scrubs off half its
//             speed in a corner is hard to drive even if it never spins
//
// Out past the edge of the map on forced tarmac, like tests/highspeed.js.
window.__runDrivable = async function (kinds = ['runner', 'supercar', 'interceptor'], speeds = [40, 60, 80]) {
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
        for (const mode of ['turnIn', 'powerOn', 'liftOff']) {
          const v = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -1000 }, 0, {});
          v.assist.boost = 1; v.assist.grip = 1;
          // The car a person drives in a police game is not the one the AI
          // drives; measure what the player actually gets.
          if (kind === 'interceptor' && window.__drivableTune) v.spec = window.__drivableTune;
          subject = v;
          controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
          g.stepHeadless(0.8);
          v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });
          for (let i = 0; i < 60; i++) {
            const err = kph / 3.6 - v.forwardSpeed;
            controls = { throttle: Math.max(0, Math.min(1, err * 0.6)), brake: 0, steer: 0, handbrake: 0 };
            g.stepHeadless(1 / 60);
          }

          let slipSum = 0, slipMax = 0, n = 0, spun = false;
          for (let i = 0; i < 150; i++) {
            const err = kph / 3.6 - Math.abs(v.forwardSpeed);
            const throttle = mode === 'powerOn' ? 1
              : mode === 'liftOff' ? 0
                : Math.max(0, Math.min(1, err * 0.6));
            controls = { throttle, brake: 0, steer: 1, handbrake: 0 };
            g.stepHeadless(1 / 60);
            const beta = Math.abs(v.slipAngleBody) * 57.3;
            if (beta > 30) spun = true;
            slipSum += beta; slipMax = Math.max(slipMax, beta); n++;
          }

          // Straighten up, as a driver would the moment it steps out.
          let recovers = false;
          for (let i = 0; i < 150; i++) {
            controls = { throttle: 0.25, brake: 0, steer: 0, handbrake: 0 };
            g.stepHeadless(1 / 60);
            if (Math.abs(v.slipAngleBody) * 57.3 < 3) { recovers = true; break; }
          }

          out.push({
            kind, kph, mode,
            slip: +(slipSum / n).toFixed(1), worst: +slipMax.toFixed(1),
            spun, recovers, endKph: Math.round(Math.abs(v.forwardSpeed) * 3.6),
          });
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
