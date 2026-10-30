// Can you drive out from a police car's nose against your side?
//
// "When, like, a police car is almost like ... has its front against your
// side, you can't, and it's sometimes pushing or even when it's still,
// sometimes you can't actually go forwards. It's like there's too much
// friction ... there needs to be friction, but there needs to be slightly
// less."
//
// Out past the edge of the map on forced tarmac (like tests/highspeed.js). The
// player's car stands still; a patrol car is put square to it, its nose
// against the player's door, either pushing (`push` throttle) or parked. Then
// the player goes full throttle ahead for `seconds`:
//
//   moved   metres the player got along its own heading
//   kph     its speed at the end
//   free    whether it had cleared the patrol car's nose
window.__runPinFree = async function (kind = 'runner', seconds = 2, friction = null) {
  window.__res = null;
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
    const out = [];
    for (const push of [0.6, 0]) {
      const v = g.createVehicle(kind, kind, { x: 1015, y: 0.9, z: -1000 }, 0, {});
      v.assist.boost = 1; v.assist.grip = 1;
      // Square to it, nose 0.1 m off its right-hand door, pointing at it.
      const half = v.spec.dims ? v.spec.dims.w * 0.5 : 0.95;
      const cop = g.createVehicle('patrol', 'patrol', { x: 1015 - half - 2.5, y: 0.9, z: -1000 }, Math.PI / 2, { police: true });
      if (friction !== null) for (const c of [v, cop]) c.collider.setFriction(friction);
      let vc = { throttle: 0, brake: 1, steer: 0, handbrake: 1 }, cc = { throttle: push, brake: push ? 0 : 1, steer: 0, handbrake: push ? 0 : 1 };
      const origU = g._update.bind(g);
      g._update = (dt) => { v.setControls(vc); cop.setControls(cc); origU(dt); v.setControls(vc); cop.setControls(cc); };
      // Let it settle into the door.
      g.stepHeadless(1.2);
      const z0 = v.position.z;
      vc = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      g.stepHeadless(seconds);
      const moved = v.position.z - z0;
      const free = Math.abs(cop.position.z - v.position.z) > (v.spec.dims ? v.spec.dims.l * 0.5 : 2.2) + 1.1;
      out.push({ push, moved: +moved.toFixed(1), kph: Math.round(v.forwardSpeed * 3.6), free });
      g._update = origU;
      g.removeVehicle(v);
      g.removeVehicle(cop);
      await new Promise((r) => setTimeout(r, 0));
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight;
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
